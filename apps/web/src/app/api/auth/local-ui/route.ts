import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { hashApiKey, extractApiKeyPrefix } from '@/lib/api-auth';

// Local-UI OAuth flow:
// 1. Local-UI redirects here with ?callback=http://localhost:PORT/auth/callback
// 2. We check if user is logged in (session auth)
// 3. If not, redirect to login with return URL
// 4. If yes, get/create a dedicated local-ui account and redirect back with ?token=xxx

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export async function GET(req: NextRequest) {
  const callback = req.nextUrl.searchParams.get('callback');

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
    const returnUrl = `/api/auth/local-ui?callback=${encodeURIComponent(callback)}`;
    const loginUrl = `/app/auth/signin?callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  // User is logged in - get or create their local-ui account
  try {
    // Look for existing local-ui account (named "Local UI")
    let account = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.ownerId, session.user.id),
        eq(accounts.name, 'Local UI')
      ),
    });

    // Generate a fresh plaintext key for this auth flow
    const plaintextKey = generateApiKey();

    if (!account) {
      // Create dedicated local-ui account with hashed key
      const [newAccount] = await db
        .insert(accounts)
        .values({
          name: 'Local UI',
          type: 'user',
          level: 'worker',
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
        })
        .where(eq(accounts.id, account.id))
        .returning();
      account = updated;
    }

    // Redirect back to local-ui with the plaintext token (shown once)
    const successUrl = new URL(callback);
    successUrl.searchParams.set('token', plaintextKey);
    return NextResponse.redirect(successUrl.toString());

  } catch (error) {
    console.error('Local-UI auth error:', error);
    const errorUrl = new URL(callback);
    errorUrl.searchParams.set('error', 'Server error');
    return NextResponse.redirect(errorUrl.toString());
  }
}
