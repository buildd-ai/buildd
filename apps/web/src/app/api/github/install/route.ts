import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isGitHubAppConfigured, getGitHubAppConfig } from '@/lib/github';
import { signInstallState } from '@/lib/github-install-state';

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

  // Redirect to GitHub App installation page. The signed state binds the
  // flow to this session user so the callback can attribute the installation.
  const state = signInstallState({
    userId: session.user.id!,
    returnUrl: req.nextUrl.searchParams.get('returnUrl'),
  });

  const installUrl = new URL(config.installUrl);
  installUrl.searchParams.set('state', state);

  return NextResponse.redirect(installUrl);
}
