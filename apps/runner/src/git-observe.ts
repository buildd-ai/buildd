import { gitShellAsync } from './git-async';

export interface GitProgressObservation {
  lastCommitSha: string;
  commitCount: number;
  pushed: boolean;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/**
 * Local-only observation; unavailable git/base facts fail open without inventing evidence.
 * Async (git-async.ts): it runs on the worker sync tick, which must never hold
 * the runner's event loop while git works.
 */
export async function observeGitProgress(worktreePath: string, baseRef: string, branch: string): Promise<GitProgressObservation | null> {
  const git = async (args: string) => (await gitShellAsync(`git ${args}`, {
    cwd: worktreePath, timeoutMs: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })).trim();
  try {
    const lastCommitSha = await git('rev-parse HEAD');
    const count = await git(`rev-list --count ${quote(`${baseRef}..HEAD`)} --`);
    const commitCount = Number(count);
    if (!lastCommitSha || !count || !Number.isInteger(commitCount) || commitCount < 0) return null;
    let pushed = false;
    try {
      const remoteHead = await git(`rev-parse --verify ${quote(`refs/remotes/origin/${branch}`)}`);
      if (remoteHead === lastCommitSha) pushed = true;
      else if (remoteHead) { await git(`merge-base --is-ancestor ${quote(lastCommitSha)} ${quote(remoteHead)}`); pushed = true; }
    } catch { /* A missing remote ref or an unpushed HEAD is not push evidence. */ }
    return { lastCommitSha, commitCount, pushed };
  } catch { return null; }
}
