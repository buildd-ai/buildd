/**
 * Bring a PR that is merely behind its base up to date via GitHub's
 * update-branch API — a server-side merge of the base into the head — rather
 * than dispatching an agent to do the same `git merge` by hand. Pinned to the
 * head that was evaluated, so a concurrent push makes GitHub refuse instead
 * of merging into a commit nobody looked at. Never a rebase: shared branch
 * history is preserved.
 *
 * A refusal is classified (conflict-aware-orchestration.md §4): only GitHub's
 * own 422 "merge conflict" is textual-conflict evidence. A moved head is a
 * re-read; "no new commits" means the branch already has its base; any other
 * 422 is a deterministic refusal (`refused`) that retrying cannot change; rate
 * limits, auth and transient/unknown errors are operational. None of those is
 * ever mistaken for a conflict that needs an agent.
 */

import { githubApi } from '@/lib/github';

type Api = (installationId: number, path: string, init?: RequestInit) => Promise<unknown>;

export type BranchUpdateFailure =
  | 'conflict'
  | 'head_changed'
  /** 422 "no new commits": the branch already contains its base. Nothing to do. */
  | 'up_to_date'
  /** Any other 422: GitHub refused this request deterministically; a retry cannot help. */
  | 'refused'
  | 'rate_limit'
  | 'auth'
  | 'transient'
  | 'unknown';

/** HTTP status from a `githubApi` error ("GitHub API error: <status> <body>"), else null. */
function statusOf(message: string): number | null {
  const m = /GitHub API error: (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/**
 * Classify an update-branch error message. Fails closed toward `unknown`:
 * nothing is called a conflict without GitHub's own 422 saying so.
 */
export function classifyBranchUpdateFailure(message: string): BranchUpdateFailure {
  const lower = message.toLowerCase();
  const status = statusOf(message);
  if (status === 422) {
    if (/merge conflict/.test(lower)) return 'conflict';
    if (/expected head sha|head ref/.test(lower)) return 'head_changed';
    if (/no new commits/.test(lower)) return 'up_to_date';
    return 'refused';
  }
  if (status === 429 || ((status === 403 || status === null) && /rate limit/.test(lower))) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (/failed to get installation token|bad credentials|github app not configured/.test(lower)) return 'auth';
  if (status !== null && status >= 500) return 'transient';
  if (status === null && /fetch failed|econnreset|econnrefused|etimedout|enotfound|socket|network|timed? ?out|aborted/.test(lower)) {
    return 'transient';
  }
  return 'unknown';
}

export async function updateBehindPrBranch(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  api?: Api;
}): Promise<{ updated: boolean; reason?: string; failure?: BranchUpdateFailure }> {
  const api = params.api ?? githubApi;
  try {
    await api(params.installationId, `/repos/${params.repoFullName}/pulls/${params.prNumber}/update-branch`, {
      method: 'PUT',
      body: JSON.stringify({ expected_head_sha: params.headSha }),
    });
    return { updated: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { updated: false, reason, failure: classifyBranchUpdateFailure(reason) };
  }
}
