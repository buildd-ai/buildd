import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { createConnectToken, resolveConnectRepo } from '@/lib/connect-repo';
import { isUuid } from '@/lib/uuid';
import ConnectRepoView from './ConnectRepoView';

export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/**
 * `/app/connect-repo?repo=<owner/name>&runner=<account id>`: where a T3 thread
 * on `buildd acp` sends a person whose project matched no workspace the
 * runner reaches (apps/runner/src/acp/bridge.ts). lib/connect-repo.ts works
 * out the case; the confirm posts to /api/connect-repo.
 */
export default async function ConnectRepoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const repo = first(params.repo);
  const runnerId = first(params.runner);
  const user = await getCurrentUser();
  if (!user) {
    const back = `/app/connect-repo?repo=${encodeURIComponent(repo)}&runner=${encodeURIComponent(runnerId)}`;
    redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
  }

  const found = isUuid(runnerId)
    ? await resolveConnectRepo({ userId: user.id, accountId: runnerId, repo })
    : ({ kind: 'key_not_found' } as const);
  return (
    <ConnectRepoView
      repo={repo}
      runnerId={runnerId}
      found={found}
      token={createConnectToken(user.id, runnerId, repo)}
      action="/api/connect-repo"
      error={first(params.error) || null}
      created={first(params.created) === '1'}
    />
  );
}
