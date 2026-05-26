import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createAuthCode, getClient } from '@/lib/oauth/storage';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

function redirectWithError(redirectUri: string, error: string, state?: string | null) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url);
}

function plainError(message: string, status = 400) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

/**
 * Returns workspaces the user can access through team membership.
 * Used to populate the workspace selector during OAuth consent.
 */
async function workspacesForUser(userId: string) {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true },
  });
  const teamIds = memberships.map((m) => m.teamId);
  if (teamIds.length === 0) return [];
  return db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds),
    columns: { id: true, name: true, teamId: true },
    orderBy: (w, { asc }) => [asc(w.name)],
  });
}

/**
 * OAuth 2.1 authorize endpoint.
 *
 * Flow:
 *   1. Validate client_id + redirect_uri (must match registered values)
 *   2. Validate PKCE params (S256 only — plain forbidden by OAuth 2.1)
 *   3. Require a logged-in NextAuth session; redirect to signin if absent
 *   4. Require a workspace param. If absent, render a workspace picker.
 *   5. Verify the user has access to the chosen workspace
 *   6. Mint a one-shot auth code keyed to (clientId, userId, workspaceId)
 *   7. Redirect back to client with the code + state
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const responseType = params.get('response_type');
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'plain';
  const state = params.get('state');
  const scope = params.get('scope');
  const workspaceId = params.get('workspace');

  if (!clientId || !redirectUri) {
    return plainError('missing client_id or redirect_uri');
  }
  const client = await getClient(clientId);
  if (!client) {
    return plainError('unknown client_id', 400);
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return plainError('redirect_uri not registered for this client', 400);
  }

  // From here on, redirect errors back to the client per OAuth 2.1.
  if (responseType !== 'code') {
    return redirectWithError(redirectUri, 'unsupported_response_type', state);
  }
  if (!codeChallenge) {
    return redirectWithError(redirectUri, 'invalid_request', state);
  }
  if (codeChallengeMethod !== 'S256') {
    return redirectWithError(redirectUri, 'invalid_request', state);
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    // Send the user through NextAuth signin, then back to this same authorize URL.
    const signinUrl = new URL('/api/auth/signin', req.nextUrl.origin);
    signinUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signinUrl);
  }

  // Workspace selection: when omitted, show a picker that posts back here with ?workspace=<id>.
  if (!workspaceId) {
    const available = await workspacesForUser(userId);
    if (available.length === 0) {
      return plainError(
        'no workspaces available for this account — sign in to buildd and create one first',
        403,
      );
    }
    return new NextResponse(renderWorkspacePicker(req, available, client.clientName ?? clientId), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // Verify access to the chosen workspace.
  const allowed = await workspacesForUser(userId);
  const chosen = allowed.find((w) => w.id === workspaceId);
  if (!chosen) {
    return plainError('you do not have access to that workspace', 403);
  }

  const code = await createAuthCode({
    clientId,
    userId,
    workspaceId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: scope ?? null,
  });

  const cbUrl = new URL(redirectUri);
  cbUrl.searchParams.set('code', code);
  if (state) cbUrl.searchParams.set('state', state);

  // Render a brief confirmation interstitial before redirecting back to the
  // OAuth client. Without this, the user (and any future Claude reading
  // screenshots) never sees which workspace the token was scoped to — the
  // root cause of the 2026-05-25 misroute incident, where the user couldn't
  // tell which of three buildd connectors they had just authorized.
  //
  // The page auto-redirects via meta refresh + JS after 2s, with a fallback
  // link so single-shot OAuth codes don't expire if JS is disabled.
  return new NextResponse(
    renderAuthorizedInterstitial(chosen.name, cbUrl.toString(), client.clientName ?? clientId),
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

/**
 * Minimal HTML workspace picker — keeps the OAuth flow self-contained, no
 * React/client component round-trip. Each button submits the same authorize
 * URL with workspace=<id> appended. Inline styles only; no asset deps.
 */
function renderWorkspacePicker(
  req: NextRequest,
  available: Array<{ id: string; name: string }>,
  clientName: string,
): string {
  const baseUrl = req.nextUrl.pathname + req.nextUrl.search;
  const items = available
    .map((w) => {
      const url = `${baseUrl}${req.nextUrl.search.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(w.id)}`;
      return `<a class="ws" href="${url}"><div class="name">${escapeHtml(w.name)}</div><div class="id">${escapeHtml(w.id)}</div></a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${escapeHtml(clientName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 2rem; }
  .wrap { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #a3a3a3; margin: 0 0 1.5rem; line-height: 1.5; }
  .ws { display: block; padding: 1rem; background: #171717; border: 1px solid #262626; border-radius: 0.5rem; margin-bottom: 0.5rem; text-decoration: none; color: #fafafa; transition: background 0.1s; }
  .ws:hover { background: #1f1f1f; }
  .name { font-weight: 500; }
  .id { font-family: monospace; font-size: 0.75rem; color: #737373; margin-top: 0.25rem; }
</style>
</head>
<body>
<div class="wrap">
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p>Pick the buildd workspace this connection should have access to. The connector will be scoped to this workspace only — to expose another workspace, add it as a separate connector.</p>
${items}
</div>
</body>
</html>`;
}

/**
 * Confirmation page rendered after the user picks a workspace and before the
 * OAuth code-redirect fires. Two paths complete the redirect:
 *   - <meta http-equiv="refresh"> (works without JS, 2s delay)
 *   - inline JS (immediate fallback, fires first when JS is on)
 * Plus a visible <a> for users who land here without either.
 */
function renderAuthorizedInterstitial(
  workspaceName: string,
  redirectUrl: string,
  clientName: string,
): string {
  const safeWs = escapeHtml(workspaceName);
  const safeClient = escapeHtml(clientName);
  const safeUrl = escapeHtml(redirectUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connected to ${safeWs}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="2;url=${safeUrl}">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 2rem; }
  .wrap { max-width: 480px; margin: 4rem auto 0; text-align: center; }
  .check { font-size: 3rem; color: #22c55e; line-height: 1; margin-bottom: 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  .ws { font-size: 1.5rem; font-weight: 600; color: #fafafa; margin: 0.5rem 0 1.5rem; }
  p { color: #a3a3a3; margin: 0 0 1.5rem; line-height: 1.5; }
  .hint { color: #737373; font-size: 0.875rem; margin-top: 2rem; }
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
<div class="check">✓</div>
<h1>Authorized ${safeClient}</h1>
<div class="ws">${safeWs}</div>
<p>This connector is scoped to <strong>${safeWs}</strong> only. To use another workspace, add it as a separate connector.</p>
<p class="hint">Redirecting you back… or <a href="${safeUrl}">continue now</a>.</p>
</div>
<script>setTimeout(function(){ window.location.href = ${JSON.stringify(redirectUrl)}; }, 800);</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
