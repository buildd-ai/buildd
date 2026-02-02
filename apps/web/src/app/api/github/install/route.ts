import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isGitHubAppConfigured, getGitHubAppConfig } from '@/lib/github';

export async function GET(req: NextRequest) {
  // Require auth
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL('/app/auth/signin', req.url));
  }

  if (!isGitHubAppConfigured()) {
    return NextResponse.json(
      { error: 'GitHub App not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_CLIENT_ID.' },
      { status: 500 }
    );
  }

  const config = getGitHubAppConfig();

  // Redirect to GitHub App installation page
  // state parameter will help us identify the user after callback
  const state = Buffer.from(JSON.stringify({
    userId: session.user.email,
    returnUrl: req.nextUrl.searchParams.get('returnUrl') || '/app/workspaces',
  })).toString('base64url');

  const installUrl = new URL(config.installUrl);
  installUrl.searchParams.set('state', state);

  return NextResponse.redirect(installUrl);
}
