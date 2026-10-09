import { execSync } from 'child_process';

export interface GitProgressObservation {
  lastCommitSha: string;
  commitCount: number;
  pushed: boolean;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Local-only observation; unavailable git/base facts fail open without inventing evidence. */
export function observeGitProgress(worktreePath: string, baseRef: string, branch: string): GitProgressObservation | null {
  const git = (args: string) => execSync(`git ${args}`, {
    cwd: worktreePath, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  try {
    const lastCommitSha = git('rev-parse HEAD');
    const count = git(`rev-list --count ${quote(`${baseRef}..HEAD`)} --`);
    const commitCount = Number(count);
    if (!lastCommitSha || !count || !Number.isInteger(commitCount) || commitCount < 0) return null;
    let pushed = false;
    try {
      const remoteHead = git(`rev-parse --verify ${quote(`refs/remotes/origin/${branch}`)}`);
      if (remoteHead === lastCommitSha) pushed = true;
      else if (remoteHead) { git(`merge-base --is-ancestor ${quote(lastCommitSha)} ${quote(remoteHead)}`); pushed = true; }
    } catch { /* A missing remote ref or an unpushed HEAD is not push evidence. */ }
    return { lastCommitSha, commitCount, pushed };
  } catch { return null; }
}
