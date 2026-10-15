import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { parseKeyLevel } from '@/lib/key-level-policy';
import { mintRunnerKey, runnerConsentTeams } from '@/lib/runner-picks';
import {
  RUNNER_CONSENT_HEADERS,
  decideRunnerConsent,
  initialRunnerState,
  isSameOriginPost,
  readFlow,
  renderRunnerConsentPage,
  verifyRunnerConsentToken,
  type RunnerConsentFlow,
} from '@/lib/runner-consent';

// CLI login (spec "One runner for every team you run", R-1, R-2):
// 1. The CLI opens ?callback=http://localhost:PORT/callback&client=runner&level=worker
// 2. Not signed in: to the sign-in page, then back here
// 3. Signed in: the runner consent page (lib/runner-consent.ts), the MCP
//    sign-in picker worded for a runner: every team the person is on with its
//    workspaces, a team's restricted ones only for its owners and admins
// 4. Approve (POST, same origin, signed form): a new key confined to the
//    picks, its level capped by the person's role in every picked team, then
//    the same redirect to the callback with ?token=…&level=…, so the CLI needs
//    no change to keep working
//
// Query params:
//   callback (required) - localhost URL to redirect back to
//   client   (optional) - client identifier: 'runner', 'cli', 'mcp', 'agent' (default: 'cli')
//   account_name (optional) - custom account name (overrides client-based name)
//   level    (optional) - 'admin', 'worker' or 'trigger' (default depends on client).
//                         Capped by the user's role in each picked team: members get at most 'worker'.

const CLIENT_DEFAULTS: Record<string, { name: string; level: 'admin' | 'worker' }> = {
  'runner': { name: 'Runner', level: 'worker' },
  'cli': { name: 'CLI', level: 'admin' },
  'mcp': { name: 'MCP Server', level: 'admin' },
  'agent': { name: 'Agent', level: 'admin' },
};

const ALLOWED_PROVIDERS = ['google', 'github'];

/** A localhost callback, or null. Checked on GET and again on the POST. */
function localhostCallback(callback: string | null): URL | null {
  if (!callback) return null;
  try {
    const url = new URL(callback);
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

function plain(message: string, status: number) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

function errorRedirect(callback: string, error: string, status?: number) {
  const url = new URL(callback);
  url.searchParams.set('error', error);
  return status ? NextResponse.redirect(url.toString(), status) : NextResponse.redirect(url.toString());
}

function returnParams(flow: Extract<RunnerConsentFlow, { kind: 'cli' }>): URLSearchParams {
  const params = new URLSearchParams();
  params.set('callback', flow.callback);
  if (flow.client) params.set('client', flow.client);
  if (flow.accountName) params.set('account_name', flow.accountName);
  if (flow.level) params.set('level', flow.level);
  if (flow.machine) params.set('machine', flow.machine);
  return params;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const callback = sp.get('callback');
  const provider = sp.get('provider');

  if (!callback) {
    return NextResponse.json({ error: 'callback parameter required' }, { status: 400 });
  }

  // Validate callback URL (must be localhost for security)
  try {
    new URL(callback);
  } catch {
    return NextResponse.json({ error: 'Invalid callback URL' }, { status: 400 });
  }
  if (!localhostCallback(callback)) {
    return NextResponse.json({ error: 'Callback must be localhost' }, { status: 400 });
  }

  const flow: Extract<RunnerConsentFlow, { kind: 'cli' }> = {
    kind: 'cli',
    callback,
    client: sp.get('client') || 'cli',
    accountName: sp.get('account_name'),
    level: sp.get('level'),
    machine: sp.get('machine'),
  };

  // When a specific provider is requested (e.g., from iOS "Continue with GitHub"),
  // always redirect through that provider's OAuth flow. This ensures the token is
  // created for the correct account even if Safari has a cached session for a
  // different provider.
  if (provider && ALLOWED_PROVIDERS.includes(provider)) {
    // Build return URL WITHOUT provider to avoid redirect loop
    const returnUrl = `/api/auth/cli?${returnParams(flow).toString()}`;
    const loginUrl = `/app/auth/signin?provider=${provider}&callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  const session = await auth();
  if (!session?.user?.id) {
    const returnUrl = `/api/auth/cli?${returnParams(flow).toString()}`;
    const loginUrl = `/app/auth/signin?callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  try {
    const teams = await runnerConsentTeams(session.user.id);
    if (teams.length === 0) return errorRedirect(callback, 'No workspaces available');
    const html = renderRunnerConsentPage({
      flow,
      userId: session.user.id,
      teams,
      state: initialRunnerState(teams, null),
      action: '/api/auth/cli',
    });
    return new NextResponse(html, { status: 200, headers: RUNNER_CONSENT_HEADERS });
  } catch (error) {
    console.error('CLI auth error:', error);
    return errorRedirect(callback, 'Server error');
  }
}

/** The consent form. Nothing is minted until the person presses Connect runner. */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return plain('unsupported content-type', 400);
  }
  const form = new URLSearchParams(await req.text());
  const flow = readFlow('cli', form);
  if (!flow || flow.kind !== 'cli' || !localhostCallback(flow.callback)) return plain('Callback must be localhost', 400);

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return plain('sign in required', 401);
  if (!isSameOriginPost(req)) return plain('consent must be submitted from this site', 403);
  if (!verifyRunnerConsentToken(form.get('csrf_token'), userId, flow)) {
    return plain('This page expired. Run buildd login again.', 403);
  }

  try {
    const teams = await runnerConsentTeams(userId);
    const decision = decideRunnerConsent(form, teams);
    if (decision.type === 'deny') return errorRedirect(flow.callback, 'access_denied', 303);
    if (decision.type === 'refuse') return plain(decision.message, decision.status);
    if (decision.type === 'page') {
      const html = renderRunnerConsentPage({ flow, userId, teams, state: decision.state, action: '/api/auth/cli', error: decision.error });
      return new NextResponse(html, { status: decision.status ?? 200, headers: RUNNER_CONSENT_HEADERS });
    }

    const defaults = CLIENT_DEFAULTS[flow.client ?? 'cli'] || CLIENT_DEFAULTS['cli'];
    const minted = await mintRunnerKey({
      userId,
      workspaceIds: decision.workspaceIds,
      // A login always mints a new account: it never rotates or returns an
      // existing account's key, even one with the same name.
      name: flow.accountName || defaults.name,
      requestedLevel: parseKeyLevel(flow.level) || defaults.level,
    });
    if (!minted.ok) return plain(minted.message, minted.status);

    // Redirect back to the CLI with the plaintext token (shown once)
    const successUrl = new URL(flow.callback);
    successUrl.searchParams.set('token', minted.plaintextKey);
    successUrl.searchParams.set('level', minted.level);
    successUrl.searchParams.set('email', session.user?.email || '');
    // The person's presence token for the agent plugin's hooks (lib/presence-token.ts),
    // one per machine. Best effort: a login without one still works.
    try {
      const { issuePresenceToken } = await import('@/lib/presence-token');
      const presenceToken = await issuePresenceToken(userId, flow.machine);
      if (presenceToken) successUrl.searchParams.set('presenceToken', presenceToken);
    } catch (err) {
      console.warn('[auth/cli] presence token not issued:', err instanceof Error ? err.message : err);
    }
    if (process.env.NEXT_PUBLIC_PUSHER_KEY) successUrl.searchParams.set('pusherKey', process.env.NEXT_PUBLIC_PUSHER_KEY);
    if (process.env.NEXT_PUBLIC_PUSHER_CLUSTER) successUrl.searchParams.set('pusherCluster', process.env.NEXT_PUBLIC_PUSHER_CLUSTER);
    if (process.env.PUSHER_CHANNEL_PREFIX) successUrl.searchParams.set('pusherChannelPrefix', process.env.PUSHER_CHANNEL_PREFIX);
    return NextResponse.redirect(successUrl.toString(), 303);
  } catch (error) {
    console.error('CLI auth error:', error);
    return errorRedirect(flow.callback, 'Server error', 303);
  }
}
