import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';

// Generalized CLI OAuth flow:
// 1. CLI redirects here with ?callback=http://localhost:PORT/callback&client=cli&level=admin
// 2. We check if user is logged in (session auth)
// 3. If not, redirect to login with return URL
// 4. If yes, get/create a dedicated named account and redirect back with ?token=xxx
//
// Query params:
//   callback (required) - localhost URL to redirect back to
//   client   (optional) - client identifier: 'local-ui', 'cli', 'mcp', 'agent' (default: 'cli')
//   account_name (optional) - custom account name (overrides client-based name)
//   level    (optional) - 'admin' or 'worker' (default depends on client)

const CLIENT_DEFAULTS: Record<string, { name: string; level: 'admin' | 'worker' }> = {
  'local-ui': { name: 'Local UI', level: 'worker' },
  'cli': { name: 'CLI', level: 'admin' },
  'mcp': { name: 'MCP Server', level: 'admin' },
  'agent': { name: 'Agent', level: 'admin' },
};

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function GET(req: NextRequest) {
  const callback = req.nextUrl.searchParams.get('callback');
  const client = req.nextUrl.searchParams.get('client') || 'cli';
  const accountName = req.nextUrl.searchParams.get('account_name');
  const levelParam = req.nextUrl.searchParams.get('level') as 'admin' | 'worker' | null;

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

  // Resolve account name and level
  const defaults = CLIENT_DEFAULTS[client] || CLIENT_DEFAULTS['cli'];
  const resolvedName = accountName || defaults.name;
  const resolvedLevel = levelParam || defaults.level;

  // User is logged in - get or create their account
  try {
    let account = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.ownerId, session.user.id),
        eq(accounts.name, resolvedName)
      ),
    });

    // Generate a fresh plaintext key for this auth flow
    const plaintextKey = generateApiKey();

    if (!account) {
      // Create dedicated account with hashed key
      const [newAccount] = await db
        .insert(accounts)
        .values({
          name: resolvedName,
          type: 'user',
          level: resolvedLevel,
          authType: 'api',
          apiKey: hashApiKey(plaintextKey),
          apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
          ownerId: session.user.id,
        })
        .returning();
      account = newAccount;
    } else {
      // Account exists - rotate key (we can't recover the old plaintext)
      const [updated] = await db
        .update(accounts)
        .set({
          apiKey: hashApiKey(plaintextKey),
          apiKeyPrefix: extractApiKeyPrefix(plaintextKey),
          level: resolvedLevel,
        })
        .where(eq(accounts.id, account.id))
        .returning();
      account = updated;
    }

    // Redirect back to CLI with the plaintext token (shown once)
    const successUrl = new URL(callback);
    successUrl.searchParams.set('token', plaintextKey);
    successUrl.searchParams.set('email', session.user.email || '');
    return NextResponse.redirect(successUrl.toString());

  } catch (error) {
    console.error('CLI auth error:', error);
    const errorUrl = new URL(callback);
    errorUrl.searchParams.set('error', 'Server error');
    return NextResponse.redirect(errorUrl.toString());
  }
}
