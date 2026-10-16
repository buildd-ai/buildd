import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createAuthCode, getClient, isSafeRedirectUri } from '@/lib/oauth/storage';
import { getAccountResourceUrl, getIssuer, getJwtSecret } from '@/lib/oauth/config';
import { levelForTeamRole } from '@/lib/oauth/session-level';
import {
  applyNav,
  classifyResource,
  clientIdentity,
  grantedScopeString,
  initialConsentState,
  parseRequestedAccess,
  pickerTeams,
  readConsentForm,
  renderAccountConsentPage,
  renderGrantInterstitial,
  renderLegacyConsentPage,
  renderLegacyInterstitial,
  validateApproval,
  type ClientIdentity,
  type ConsentState,
  type ConsentTeam,
} from '@/lib/oauth/account-consent';
import { createGrant } from '@/lib/mcp-grants';
import { consentTeamsForUser } from '@/lib/mcp-grant-admin';
import { db } from '@buildd/core/db';
import { teamMembers, teams, workspaces } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { isSystemWorkspace } from '@buildd/shared';
import { isUuid } from '@/lib/uuid';
import { sqlWhere } from '@buildd/core/db/relational-sql';

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
 * The one workspace an older per-workspace address names, when the user is on
 * its team now, with what the legacy consent page shows about it.
 */
async function legacyWorkspaceForUser(userId: string, workspaceId: string) {
  if (!isUuid(workspaceId)) return null;
  const ws = await db.query.workspaces.findFirst({
    where: sqlWhere(eq(workspaces.id, workspaceId)),
    columns: { id: true, name: true, repo: true, teamId: true },
  });
  if (!ws) return null;
  const membership = await db.query.teamMembers.findFirst({
    where: sqlWhere(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, ws.teamId))),
    columns: { role: true },
  });
  if (!membership) return null;
  const team = await db.query.teams.findFirst({ where: sqlWhere(eq(teams.id, ws.teamId)), columns: { name: true } });
  return {
    id: ws.id,
    name: ws.name,
    repo: ws.repo ?? null,
    system: isSystemWorkspace(ws.name),
    teamName: team?.name ?? '',
    role: (membership.role as string | null | undefined) ?? null,
  };
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
  /** RFC 8707 resource indicator. The account-level resource selects grant consent. */
  resource: string | null;
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
    resource: params.get('resource'),
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
    'buildd-oauth-consent-v2',
    userId,
    p.clientId,
    p.redirectUri,
    p.workspaceId,
    p.codeChallenge,
    p.codeChallengeMethod,
    p.scope ?? '',
    p.state ?? '',
    p.responseType,
    p.resource ?? '',
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
 *   4. Classify the RFC 8707 `resource` (classifyResource):
 *      - none or `<issuer>/api/mcp`: the account consent page
 *        (lib/oauth/account-consent.ts): the user's teams and workspaces,
 *        internal workspaces left out (pickerTeams), the kind of connection
 *        and read/write. This is the default for every new connection.
 *      - `<issuer>/api/mcp-oauth/<workspace>`: an older per-workspace
 *        address. Consent for that one workspace only, plus the address
 *        that reaches several. The token stays bound to that workspace.
 *      - anything else: `invalid_target` back to the client.
 *   No code is issued on GET.
 *
 * POST (the consent form):
 *   5. Same-origin + consent token bound to the user and every parameter
 *   6. Deny → redirect back with access_denied
 *   7. Approve → re-check against current membership, then a one-shot code
 *      bound to a new grant (account) or to the one workspace (legacy).
 */
export async function GET(req: NextRequest) {
  const p = readParams(req.nextUrl.searchParams);
  const checked = await validateRequest(p);
  if (!checked.ok) return checked.response;
  const { client, clientId, redirectUri } = checked.v;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    // Send the user through NextAuth signin, then back to this same authorize URL.
    const signinUrl = new URL('/api/auth/signin', req.nextUrl.origin);
    signinUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signinUrl);
  }

  const target = classifyResource(p.resource, getAccountResourceUrl());
  if (target.kind === 'unknown') return redirectWithError(redirectUri, 'invalid_target', p.state);
  const identity = clientIdentity(client.clientName ?? clientId, redirectUri);

  if (target.kind === 'legacy') {
    if (p.workspaceId && p.workspaceId !== target.workspaceId) {
      return plainError('the workspace does not match the address this app connected to', 400);
    }
    const ws = await legacyWorkspaceForUser(userId, target.workspaceId);
    if (!ws) return plainError('you do not have access to that workspace', 403);
    return new NextResponse(
      renderLegacyConsentPage({
        clientName: identity.name,
        clientVerified: identity.verified,
        redirectHost: redirectHostOf(redirectUri),
        hidden: hiddenFields(p, createConsentToken(userId, p)),
        workspace: { name: ws.name, teamName: ws.teamName, repo: ws.repo, system: ws.system },
        level: levelForTeamRole(ws.role),
        canonicalUrl: getAccountResourceUrl(),
      }),
      { status: 200, headers: HTML_HEADERS },
    );
  }

  const consentTeams = pickerTeams(await consentTeamsForUser(userId), p.workspaceId);
  if (consentTeams.length === 0) {
    return plainError('no workspaces available for this account — sign in to buildd and create one first', 403);
  }
  const requested = parseRequestedAccess(p.scope);
  return accountConsentResponse({
    identity,
    redirectUri,
    params: p,
    userId,
    teams: consentTeams,
    state: initialConsentState(consentTeams, requested, p.workspaceId),
    requested,
  });
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

  const target = classifyResource(p.resource, getAccountResourceUrl());
  if (target.kind === 'unknown') return redirectWithError(redirectUri, 'invalid_target', p.state, 303);
  const identity = clientIdentity(client.clientName ?? clientId, redirectUri);

  if (target.kind !== 'legacy') {
    return accountConsentPost({ form, p, userId, clientId, identity, redirectUri, codeChallenge });
  }

  if (form.get('decision') !== 'approve') {
    return redirectWithError(redirectUri, 'access_denied', p.state, 303);
  }

  // Re-check access at approval time; membership may have changed since GET.
  // The workspace comes from the resource, never from a form field.
  if (p.workspaceId && p.workspaceId !== target.workspaceId) {
    return plainError('the workspace does not match the address this app connected to', 400);
  }
  const ws = await legacyWorkspaceForUser(userId, target.workspaceId);
  if (!ws) return plainError('you do not have access to that workspace', 403);

  const code = await createAuthCode({
    clientId,
    userId,
    workspaceId: ws.id,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: p.codeChallengeMethod,
    scope: p.scope ?? null,
  });

  const cbUrl = new URL(redirectUri);
  cbUrl.searchParams.set('code', code);
  if (p.state) cbUrl.searchParams.set('state', p.state);

  // Brief confirmation before redirecting back to the OAuth client. The page
  // auto-redirects via meta refresh after 1s, with a visible fallback link.
  // The URL is deliberately never inlined into a <script>: JSON.stringify
  // does not neutralise a script-closing sequence, and the URL parser
  // preserves raw angle brackets in the opaque path of a non-special scheme.
  return new NextResponse(
    renderLegacyInterstitial({
      clientName: identity.name,
      redirectUrl: cbUrl.toString(),
      workspaceName: ws.system ? 'Organizer' : ws.name,
    }),
    { status: 200, headers: HTML_HEADERS },
  );
}

function redirectHostOf(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host || u.protocol;
  } catch {
    return redirectUri;
  }
}

/** The authorize parameters carried through either consent form. */
function hiddenFields(p: AuthorizeParams, consentToken: string): Array<[string, string | null]> {
  return [
    ['response_type', p.responseType],
    ['client_id', p.clientId],
    ['redirect_uri', p.redirectUri],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', p.codeChallengeMethod],
    ['state', p.state],
    ['scope', p.scope],
    ['workspace', p.workspaceId],
    ['resource', p.resource],
    ['csrf_token', consentToken],
  ];
}

function accountConsentResponse(args: {
  identity: ClientIdentity;
  redirectUri: string;
  params: AuthorizeParams;
  userId: string;
  teams: ConsentTeam[];
  state: ConsentState;
  requested: ReturnType<typeof parseRequestedAccess>;
  error?: string;
  status?: number;
}) {
  const html = renderAccountConsentPage({
    clientName: args.identity.name,
    clientVerified: args.identity.verified,
    redirectHost: redirectHostOf(args.redirectUri),
    hidden: hiddenFields(args.params, createConsentToken(args.userId, args.params)),
    teams: args.teams,
    state: args.state,
    requested: args.requested,
    error: args.error ?? null,
  });
  return new NextResponse(html, { status: args.status ?? 200, headers: HTML_HEADERS });
}

/**
 * The account consent form, after the same-origin and consent-token checks.
 * Cancel returns access_denied; a page action (search, page, select all)
 * re-renders with the carried selection; Approve re-validates the selection,
 * the kind and the permissions against the user's teams now (the same picker
 * set the page offered) and what the client asked for, then creates the grant
 * and a code bound to it.
 */
async function accountConsentPost(args: {
  form: URLSearchParams;
  p: AuthorizeParams;
  userId: string;
  clientId: string;
  identity: ClientIdentity;
  redirectUri: string;
  codeChallenge: string;
}) {
  const { form, p, userId, clientId, redirectUri } = args;
  const decision = form.get('decision');
  if (decision === 'deny') return redirectWithError(redirectUri, 'access_denied', p.state, 303);

  const consentTeams = pickerTeams(await consentTeamsForUser(userId), p.workspaceId);
  const requested = parseRequestedAccess(p.scope);
  const page = (state: ConsentState, error?: string, status?: number) => accountConsentResponse({
    identity: args.identity, redirectUri, params: p, userId, teams: consentTeams, state, requested, error, status,
  });

  if (decision !== 'approve') {
    const nav = form.get('nav');
    if (!nav) return redirectWithError(redirectUri, 'access_denied', p.state, 303);
    return page(applyNav(readConsentForm(form, consentTeams, requested), nav, consentTeams));
  }

  const check = validateApproval(form, consentTeams, requested);
  if (!check.ok) {
    if (check.showPage) return page(readConsentForm(form, consentTeams, requested), check.message, check.status);
    return plainError(check.message, check.status);
  }

  const created = await createGrant({
    userId,
    clientId,
    actsAs: check.actsAs,
    scopes: check.scopes,
    workspaceIds: check.workspaceIds,
  });
  if (!created.ok) {
    return plainError('One of the chosen workspaces is not available to you. Start the connection again.', 403);
  }

  const code = await createAuthCode({
    clientId,
    userId,
    grantId: created.grantId,
    redirectUri,
    codeChallenge: args.codeChallenge,
    codeChallengeMethod: p.codeChallengeMethod,
    scope: grantedScopeString(check.scopes, check.actsAs),
  });

  const cbUrl = new URL(redirectUri);
  cbUrl.searchParams.set('code', code);
  if (p.state) cbUrl.searchParams.set('state', p.state);
  return new NextResponse(
    renderGrantInterstitial({
      clientName: args.identity.name,
      redirectUrl: cbUrl.toString(),
      workspaceCount: check.workspaceIds.length,
      actsAs: check.actsAs,
    }),
    { status: 200, headers: HTML_HEADERS },
  );
}
