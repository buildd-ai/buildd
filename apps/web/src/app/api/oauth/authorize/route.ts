import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createAuthCode, getClient, isSafeRedirectUri } from '@/lib/oauth/storage';
import { getIssuer, getJwtSecret } from '@/lib/oauth/config';
import { levelForTeamRole } from '@/lib/oauth/session-level';
import { db } from '@buildd/core/db';
import { teamMembers, workspaces } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

function redirectWithError(redirectUri: string, error: string, state?: string | null, status?: number) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  // 303 after a POST so the browser follows with a GET, not a re-POST.
  return status ? NextResponse.redirect(url, status) : NextResponse.redirect(url);
}

function plainError(message: string, status = 400) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isRegisteredRedirectUri(registeredUris: string[], requestedUri: string): boolean {
  // Applied here as well as at registration so a client row written before this
  // validation existed can't be used at authorize time.
  if (!isSafeRedirectUri(requestedUri)) return false;

  if (registeredUris.includes(requestedUri)) return true;

  let requested: URL;
  try {
    requested = new URL(requestedUri);
  } catch {
    return false;
  }

  if (!LOOPBACK_HOSTS.has(requested.hostname)) return false;

  return registeredUris.some((registeredUri) => {
    let registered: URL;
    try {
      registered = new URL(registeredUri);
    } catch {
      return false;
    }

    return (
      isSafeRedirectUri(registeredUri) &&
      LOOPBACK_HOSTS.has(registered.hostname) &&
      registered.protocol === requested.protocol &&
      registered.port === requested.port &&
      registered.pathname === requested.pathname &&
      registered.search === requested.search
    );
  });
}

/**
 * Returns workspaces the user can access through team membership, with the
 * user's role on each workspace's team. Used for the workspace picker and to
 * state on the consent page what access the connection will have.
 */
async function workspacesForUser(userId: string) {
  const memberships = await db.query.teamMembers.findMany({
    where: eq(teamMembers.userId, userId),
    columns: { teamId: true, role: true },
  });
  const roleByTeam = new Map(memberships.map((m) => [m.teamId, m.role as string | null | undefined]));
  const teamIds = memberships.map((m) => m.teamId);
  if (teamIds.length === 0) return [];
  const rows = await db.query.workspaces.findMany({
    where: inArray(workspaces.teamId, teamIds),
    columns: { id: true, name: true, teamId: true },
    orderBy: (w, { asc }) => [asc(w.name)],
  });
  return rows.map((w) => ({ ...w, role: roleByTeam.get(w.teamId) ?? null }));
}

/** The authorize parameters, read from the GET query or the consent POST body. */
interface AuthorizeParams {
  responseType: string | null;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string;
  state: string | null;
  scope: string | null;
  workspaceId: string | null;
}

function readParams(params: URLSearchParams): AuthorizeParams {
  return {
    responseType: params.get('response_type'),
    clientId: params.get('client_id'),
    redirectUri: params.get('redirect_uri'),
    codeChallenge: params.get('code_challenge'),
    codeChallengeMethod: params.get('code_challenge_method') ?? 'plain',
    state: params.get('state'),
    scope: params.get('scope'),
    workspaceId: params.get('workspace'),
  };
}

type Validated = {
  client: NonNullable<Awaited<ReturnType<typeof getClient>>>;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
};

/**
 * Client, redirect_uri and PKCE checks shared by GET and POST. Errors before
 * the redirect_uri is trusted are plain responses; after, they redirect back
 * to the client per OAuth 2.1.
 */
async function validateRequest(
  p: AuthorizeParams,
  redirectStatus?: number,
): Promise<{ ok: true; v: Validated } | { ok: false; response: NextResponse }> {
  if (!p.clientId || !p.redirectUri) {
    return { ok: false, response: plainError('missing client_id or redirect_uri') };
  }
  const client = await getClient(p.clientId);
  if (!client) {
    return { ok: false, response: plainError('unknown client_id', 400) };
  }
  if (!isRegisteredRedirectUri(client.redirectUris, p.redirectUri)) {
    return { ok: false, response: plainError('redirect_uri not registered for this client', 400) };
  }
  if (p.responseType !== 'code') {
    return { ok: false, response: redirectWithError(p.redirectUri, 'unsupported_response_type', p.state, redirectStatus) };
  }
  if (!p.codeChallenge || p.codeChallengeMethod !== 'S256') {
    return { ok: false, response: redirectWithError(p.redirectUri, 'invalid_request', p.state, redirectStatus) };
  }
  return { ok: true, v: { client, clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge } };
}

// ── Consent token ────────────────────────────────────────────────────────────
//
// The consent form carries an HMAC over the signed-in user and every authorize
// parameter, so only the page this server rendered for this user and this
// exact request can be approved. Stateless: no cookie or table needed.

const CONSENT_TOKEN_TTL_SECONDS = 10 * 60;

function consentMac(userId: string, p: AuthorizeParams, issuedAt: number): string {
  const payload = JSON.stringify([
    'buildd-oauth-consent-v1',
    userId,
    p.clientId,
    p.redirectUri,
    p.workspaceId,
    p.codeChallenge,
    p.codeChallengeMethod,
    p.scope ?? '',
    p.state ?? '',
    p.responseType,
    issuedAt,
  ]);
  return createHmac('sha256', getJwtSecret()).update(payload).digest('base64url');
}

function createConsentToken(userId: string, p: AuthorizeParams, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  return `${issuedAt}.${consentMac(userId, p, issuedAt)}`;
}

function verifyConsentToken(token: string | null, userId: string, p: AuthorizeParams, now = Date.now()): boolean {
  if (!token) return false;
  const [issuedAtRaw, mac] = token.split('.');
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt) || !mac) return false;
  const age = Math.floor(now / 1000) - issuedAt;
  if (age < 0 || age > CONSENT_TOKEN_TTL_SECONDS) return false;
  const expected = Buffer.from(consentMac(userId, p, issuedAt));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The consent POST must come from a page on this origin. Browsers send
 * `Origin` on form POSTs; a missing or foreign one is refused.
 */
function isSameOriginPost(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([req.nextUrl.origin]);
  try {
    allowed.add(new URL(getIssuer()).origin);
  } catch {
    // ignore a malformed issuer; the request origin still applies
  }
  return allowed.has(origin);
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

/**
 * OAuth 2.1 authorize endpoint.
 *
 * GET (a browser redirect from the OAuth client):
 *   1. Validate client_id + redirect_uri (must match registered values)
 *   2. Validate PKCE params (S256 only — plain forbidden by OAuth 2.1)
 *   3. Require a logged-in NextAuth session; redirect to signin if absent
 *   4. Require a workspace param. If absent, render a workspace picker.
 *   5. Verify the user has access to the chosen workspace
 *   6. Render a consent page: client, workspace, and the access the
 *      connection will have (the user's team role). No code is issued.
 *
 * POST (the consent form):
 *   7. Same-origin + consent token bound to the user and every parameter
 *   8. Deny → redirect back with access_denied
 *   9. Approve → mint a one-shot auth code keyed to (clientId, userId,
 *      workspaceId) and hand it back to the client.
 */
export async function GET(req: NextRequest) {
  const p = readParams(req.nextUrl.searchParams);
  const checked = await validateRequest(p);
  if (!checked.ok) return checked.response;
  const { client, clientId } = checked.v;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    // Send the user through NextAuth signin, then back to this same authorize URL.
    const signinUrl = new URL('/api/auth/signin', req.nextUrl.origin);
    signinUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signinUrl);
  }

  // Workspace selection: when omitted, show a picker that links back here with ?workspace=<id>.
  if (!p.workspaceId) {
    const available = await workspacesForUser(userId);
    if (available.length === 0) {
      return plainError(
        'no workspaces available for this account — sign in to buildd and create one first',
        403,
      );
    }
    return new NextResponse(renderWorkspacePicker(req, available, client.clientName ?? clientId), {
      status: 200,
      headers: HTML_HEADERS,
    });
  }

  // Verify access to the chosen workspace.
  const allowed = await workspacesForUser(userId);
  const chosen = allowed.find((w) => w.id === p.workspaceId);
  if (!chosen) {
    return plainError('you do not have access to that workspace', 403);
  }

  return new NextResponse(
    renderConsentPage({
      clientName: client.clientName ?? clientId,
      workspaceName: chosen.name,
      level: levelForTeamRole(chosen.role),
      redirectUri: checked.v.redirectUri,
      params: p,
      consentToken: createConsentToken(userId, p),
    }),
    { status: 200, headers: HTML_HEADERS },
  );
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return plainError('unsupported content-type', 400);
  }
  const form = new URLSearchParams(await req.text());
  const p = readParams(form);

  const checked = await validateRequest(p, 303);
  if (!checked.ok) return checked.response;
  const { client, clientId, redirectUri, codeChallenge } = checked.v;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return plainError('sign in required', 401);

  if (!isSameOriginPost(req)) return plainError('consent must be submitted from this site', 403);
  if (!verifyConsentToken(form.get('csrf_token'), userId, p)) {
    return plainError('consent expired or invalid — start the connection again', 403);
  }

  if (form.get('decision') !== 'approve') {
    return redirectWithError(redirectUri, 'access_denied', p.state, 303);
  }

  // Re-check access at approval time; membership may have changed since GET.
  const allowed = p.workspaceId ? await workspacesForUser(userId) : [];
  const chosen = allowed.find((w) => w.id === p.workspaceId);
  if (!chosen || !p.workspaceId) {
    return plainError('you do not have access to that workspace', 403);
  }

  const code = await createAuthCode({
    clientId,
    userId,
    workspaceId: p.workspaceId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: p.codeChallengeMethod,
    scope: p.scope ?? null,
  });

  const cbUrl = new URL(redirectUri);
  cbUrl.searchParams.set('code', code);
  if (p.state) cbUrl.searchParams.set('state', p.state);

  // Brief confirmation interstitial before redirecting back to the OAuth
  // client, so the user sees which workspace the connection is scoped to.
  //
  // The page auto-redirects via meta refresh after 1s, with a visible fallback
  // link. The URL is deliberately never inlined into a <script>: JSON.stringify
  // does not neutralise a script-closing sequence, and the URL parser preserves
  // raw angle brackets in the opaque path of a non-special scheme.
  return new NextResponse(
    renderAuthorizedInterstitial(chosen.name, cbUrl.toString(), client.clientName ?? clientId),
    { status: 200, headers: HTML_HEADERS },
  );
}

const ACCESS_DESCRIPTIONS: Record<'admin' | 'worker', { label: string; detail: string }> = {
  admin: {
    label: 'Admin',
    detail: 'Everything you can do as a team admin here, including schedules, missions, secrets and workspace settings.',
  },
  worker: {
    label: 'Member',
    detail: 'Task work: read, create, claim and update tasks, artifacts and pull requests. Admin actions are not available.',
  },
};

/**
 * Consent page. A plain HTML form POSTing back to this endpoint with the
 * original parameters and the consent token; nothing is issued until the
 * user clicks Approve. Every value is HTML-escaped; no inline script.
 */
function renderConsentPage(args: {
  clientName: string;
  workspaceName: string;
  level: 'admin' | 'worker';
  redirectUri: string;
  params: AuthorizeParams;
  consentToken: string;
}): string {
  const { params: p } = args;
  const hidden: Array<[string, string | null]> = [
    ['response_type', p.responseType],
    ['client_id', p.clientId],
    ['redirect_uri', p.redirectUri],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', p.codeChallengeMethod],
    ['state', p.state],
    ['scope', p.scope],
    ['workspace', p.workspaceId],
    ['csrf_token', args.consentToken],
  ];
  const inputs = hidden
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v as string)}">`)
    .join('\n');
  const access = ACCESS_DESCRIPTIONS[args.level];
  let redirectHost = args.redirectUri;
  try {
    const u = new URL(args.redirectUri);
    redirectHost = u.host || u.protocol;
  } catch {
    // keep the raw value; it is escaped below
  }
  const safeClient = escapeHtml(args.clientName);
  const safeWs = escapeHtml(args.workspaceName);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize ${safeClient}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 2rem; }
  .wrap { max-width: 480px; margin: 2rem auto 0; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  dl { background: #171717; border: 1px solid #262626; border-radius: 0.5rem; padding: 1rem; margin: 0 0 1.5rem; }
  dt { color: #a3a3a3; font-size: 0.8rem; margin-top: 0.75rem; }
  dt:first-child { margin-top: 0; }
  dd { margin: 0.25rem 0 0; }
  .detail { color: #a3a3a3; font-size: 0.875rem; margin-top: 0.25rem; line-height: 1.4; }
  .actions { display: flex; gap: 0.75rem; }
  button { flex: 1; padding: 0.75rem; border-radius: 0.5rem; font-size: 1rem; cursor: pointer; border: 1px solid #262626; }
  .approve { background: #fafafa; color: #0a0a0a; }
  .deny { background: #171717; color: #fafafa; }
</style>
</head>
<body>
<div class="wrap">
<h1>Allow ${safeClient} to access buildd?</h1>
<dl>
  <dt>Application</dt><dd>${safeClient}</dd>
  <dt>Workspace</dt><dd>${safeWs}</dd>
  <dt>Access</dt><dd data-access-level="${args.level}">${access.label} (your team role)<div class="detail">${escapeHtml(access.detail)}</div></dd>
  <dt>Returns to</dt><dd>${escapeHtml(redirectHost)}</dd>
</dl>
<form method="post" action="/api/oauth/authorize">
${inputs}
<div class="actions">
  <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
  <button class="approve" type="submit" name="decision" value="approve">Approve</button>
</div>
</form>
</div>
</body>
</html>`;
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
 * Confirmation page rendered after the user approves and before the OAuth
 * code-redirect fires. Two paths complete the redirect, both of which put
 * the URL in an HTML context that escapeHtml fully neutralises:
 *   - <meta http-equiv="refresh"> (works without JS, ~1s delay)
 *   - a visible <a> for users the meta refresh doesn't move
 * The redirect URL must NOT be inlined into a <script>: it is client-controlled
 * (registered redirect_uri) and JSON.stringify does not escape `</script>`.
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
<meta http-equiv="refresh" content="1;url=${safeUrl}">
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
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
