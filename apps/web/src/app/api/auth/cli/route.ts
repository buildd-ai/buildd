import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { randomBytes } from 'crypto';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';
import { getUserTeamIds, getUserDefaultTeamId, getUserTeamRole } from '@/lib/team-access';
import { clampKeyLevel, parseKeyLevel } from '@/lib/key-level-policy';

// Generalized CLI OAuth flow:
// 1. CLI redirects here with ?callback=http://localhost:PORT/callback&client=cli&level=admin
// 2. We check if user is logged in (session auth)
// 3. If not, redirect to login with return URL
// 4. If yes, create a new named account and redirect back with ?token=xxx&level=yyy
//
// Query params:
//   callback (required) - localhost URL to redirect back to
//   client   (optional) - client identifier: 'runner', 'cli', 'mcp', 'agent' (default: 'cli')
//   account_name (optional) - custom account name (overrides client-based name)
//   level    (optional) - 'admin', 'worker' or 'trigger' (default depends on client).
//                         Capped by the user's team role: members get at most 'worker'.

const CLIENT_DEFAULTS: Record<string, { name: string; level: 'admin' | 'worker' }> = {
  'runner': { name: 'Runner', level: 'worker' },
  'cli': { name: 'CLI', level: 'admin' },
  'mcp': { name: 'MCP Server', level: 'admin' },
  'agent': { name: 'Agent', level: 'admin' },
};

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

const ALLOWED_PROVIDERS = ['google', 'github'];

export async function GET(req: NextRequest) {
  const callback = req.nextUrl.searchParams.get('callback');
  const client = req.nextUrl.searchParams.get('client') || 'cli';
  const accountName = req.nextUrl.searchParams.get('account_name');
  const levelParam = req.nextUrl.searchParams.get('level') as 'admin' | 'worker' | null;
  const provider = req.nextUrl.searchParams.get('provider');

  if (!callback) {
    return NextResponse.json({ error: 'callback parameter required' }, { status: 400 });
  }

  // Validate callback URL (must be localhost for security)
  try {
    const callbackUrl = new URL(callback);
    if (!['localhost', '127.0.0.1'].includes(callbackUrl.hostname)) {
      return NextResponse.json({ error: 'Callback must be localhost' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid callback URL' }, { status: 400 });
  }

  // When a specific provider is requested (e.g., from iOS "Continue with GitHub"),
  // always redirect through that provider's OAuth flow. This ensures the token is
  // created for the correct account even if Safari has a cached session for a
  // different provider.
  if (provider && ALLOWED_PROVIDERS.includes(provider)) {
    // Build return URL WITHOUT provider to avoid redirect loop
    const params = new URLSearchParams();
    params.set('callback', callback);
    if (client) params.set('client', client);
    if (accountName) params.set('account_name', accountName);
    if (levelParam) params.set('level', levelParam);

    const returnUrl = `/api/auth/cli?${params.toString()}`;
    const loginUrl = `/app/auth/signin?provider=${provider}&callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  // Check if user is authenticated
  const session = await auth();

  if (!session?.user?.id) {
    // Not logged in - redirect to login page with return URL
    const params = new URLSearchParams();
    params.set('callback', callback);
    if (client) params.set('client', client);
    if (accountName) params.set('account_name', accountName);
    if (levelParam) params.set('level', levelParam);

    const returnUrl = `/api/auth/cli?${params.toString()}`;
    const loginUrl = `/app/auth/signin?callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  // Resolve account name and requested level (unknown values fall back to the client default)
  const defaults = CLIENT_DEFAULTS[client] || CLIENT_DEFAULTS['cli'];
  const resolvedName = accountName || defaults.name;
  const requestedLevel = parseKeyLevel(levelParam) || defaults.level;

  // User is logged in - create a dedicated account for this login.
  // A login always mints a new account: it never rotates or returns an
  // existing account's key, even one with the same name.
  try {
    const teamIds = await getUserTeamIds(session.user.id);
    const teamId = teamIds[0] || await getUserDefaultTeamId(session.user.id);
    if (!teamId) {
      const errorUrl = new URL(callback);
      errorUrl.searchParams.set('error', 'No team found');
      return NextResponse.redirect(errorUrl.toString());
    }

    // The key's level is capped by the user's current role on that team.
    const role = await getUserTeamRole(session.user.id, teamId);
    if (!role) {
      const errorUrl = new URL(callback);
      errorUrl.searchParams.set('error', 'Not a member of the target team');
      return NextResponse.redirect(errorUrl.toString());
    }
    const grantedLevel = clampKeyLevel(role, requestedLevel);

    // Generate a fresh plaintext key for this auth flow
    const plaintextKey = generateApiKey();

    await db
      .insert(accounts)
      .values({
        name: resolvedName,
        type: 'user',
        level: grantedLevel,
        authType: 'api',
        apiKey: hashApiKey(plaintextKey),
        apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
        teamId,
      })
      .returning();

    // Redirect back to CLI with the plaintext token (shown once)
    const successUrl = new URL(callback);
    successUrl.searchParams.set('token', plaintextKey);
    successUrl.searchParams.set('level', grantedLevel);
    successUrl.searchParams.set('email', session.user.email || '');
    if (process.env.NEXT_PUBLIC_PUSHER_KEY) successUrl.searchParams.set('pusherKey', process.env.NEXT_PUBLIC_PUSHER_KEY);
    if (process.env.NEXT_PUBLIC_PUSHER_CLUSTER) successUrl.searchParams.set('pusherCluster', process.env.NEXT_PUBLIC_PUSHER_CLUSTER);
    if (process.env.PUSHER_CHANNEL_PREFIX) successUrl.searchParams.set('pusherChannelPrefix', process.env.PUSHER_CHANNEL_PREFIX);
    return NextResponse.redirect(successUrl.toString());

  } catch (error) {
    console.error('CLI auth error:', error);
    const errorUrl = new URL(callback);
    errorUrl.searchParams.set('error', 'Server error');
    return NextResponse.redirect(errorUrl.toString());
  }
}
