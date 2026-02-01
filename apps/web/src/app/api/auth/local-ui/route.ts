import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

// Local-UI OAuth flow:
// 1. Local-UI redirects here with ?callback=http://localhost:PORT/auth/callback
// 2. We check if user is logged in (session auth)
// 3. If not, redirect to login with return URL
// 4. If yes, get/create their API key and redirect back to callback with ?token=xxx

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
    const loginUrl = `/login?callbackUrl=${encodeURIComponent(returnUrl)}`;
    return NextResponse.redirect(new URL(loginUrl, req.url));
  }

  // User is logged in - get their API key
  try {
    // Find user's account
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.ownerId, session.user.id),
    });

    if (!account || !account.apiKey) {
      // No account or API key - redirect back with error
      const errorUrl = new URL(callback);
      errorUrl.searchParams.set('error', 'No API key found. Please create one in the dashboard.');
      return NextResponse.redirect(errorUrl.toString());
    }

    // Redirect back to local-ui with the token
    const successUrl = new URL(callback);
    successUrl.searchParams.set('token', account.apiKey);
    return NextResponse.redirect(successUrl.toString());

  } catch (error) {
    console.error('Local-UI auth error:', error);
    const errorUrl = new URL(callback);
    errorUrl.searchParams.set('error', 'Server error');
    return NextResponse.redirect(errorUrl.toString());
  }
}
