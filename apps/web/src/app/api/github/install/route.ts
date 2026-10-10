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

  // Every caller is a link a person clicked ("Connect GitHub"), so a missing
  // App lands them on a page that says what to do instead of a JSON body.
  // The operator-facing detail (which env vars) stays in the server log.
  if (!isGitHubAppConfigured()) {
    console.warn('[github/install] GitHub App not configured: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_CLIENT_ID');
    return NextResponse.redirect(new URL('/app/settings/integrations?github=unavailable', req.url));
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
