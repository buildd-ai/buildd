import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isUuid } from '@/lib/uuid';
import { isSameOriginPost } from '@/lib/runner-consent';
import { confirmConnectRepo, verifyConnectToken } from '@/lib/connect-repo';

export const dynamic = 'force-dynamic';

const PAGE = '/app/connect-repo';

function plain(message: string, status: number) {
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

/**
 * The confirm button on /app/connect-repo (lib/connect-repo.ts): pick this
 * runner for the repo's workspace, or create the workspace and pick it.
 *
 * A signed-in person only. A runner key (or any bearer credential) is
 * refused before anything is read: picks are a person's (spec "One runner for
 * every team you run", R-8).
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('authorization')) return plain('Only a signed-in person can connect a repo.', 403);
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return plain('unsupported content-type', 400);
  }
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return plain('sign in required', 401);
  if (!isSameOriginPost(req)) return plain('This must be submitted from this site.', 403);

  const form = new URLSearchParams(await req.text());
  const repo = form.get('repo') ?? '';
  const accountId = form.get('runner') ?? '';
  if (!isUuid(accountId)) return plain('Runner not found', 404);
  if (!verifyConnectToken(form.get('token'), userId, accountId, repo)) {
    return plain('This page expired. Open the link again.', 403);
  }

  const result = await confirmConnectRepo({
    userId,
    accountId,
    repo,
    workspaceId: form.get('workspaceId'),
    teamId: form.get('teamId'),
    trustLocal: form.get('trustLocal') === '1',
    origin: req.nextUrl.origin,
  });

  const back = new URL(PAGE, req.url);
  back.searchParams.set('repo', repo);
  back.searchParams.set('runner', accountId);
  if (result.ok) {
    if (result.created) back.searchParams.set('created', '1');
    if (result.isolationSet) back.searchParams.set('trusted', '1');
  } else {
    if (result.status === 404) return plain(result.message, 404);
    back.searchParams.set('error', result.message);
  }
  return NextResponse.redirect(back, 303);
}
