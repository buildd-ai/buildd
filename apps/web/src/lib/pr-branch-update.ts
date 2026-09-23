/**
 * Bring a PR that is merely behind its base up to date via GitHub's
 * update-branch API — a server-side merge of the base into the head — rather
 * than dispatching an agent to do the same `git merge` by hand. Pinned to the
 * head that was evaluated, so a concurrent push makes GitHub refuse instead
 * of merging into a commit nobody looked at. A real conflict also refuses;
 * the caller falls back to the agent retry in both cases.
 */

import { githubApi } from '@/lib/github';

type Api = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

export async function updateBehindPrBranch(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  api?: Api;
}): Promise<{ updated: boolean; reason?: string }> {
  const api = params.api ?? githubApi;
  try {
    await api(params.installationId, `/repos/${params.repoFullName}/pulls/${params.prNumber}/update-branch`, {
      method: 'PUT',
      body: JSON.stringify({ expected_head_sha: params.headSha }),
    });
    return { updated: true };
  } catch (err) {
    return { updated: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
