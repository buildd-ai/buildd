/**
 * PR scope guard: the head a task's PR is opened from may only carry what the
 * task's workers produced. An interactive session standing on a personal branch
 * passes the ownership check (`interactive_head`) yet drags every commit that
 * branch already held into the PR, so a slice of a few files arrives as dozens.
 *
 * "Foreign" = a non-merge commit authored before the task was first claimed.
 * Merges are skipped: syncing the base into the branch is the task's own move.
 * The check fails open on anything it cannot read (no claim time, no date, a
 * GitHub error): it refuses only on evidence.
 */

export interface ScopeCommit {
  sha: string;
  message: string;
  authoredAt: string | null;
  parents: number;
}

export interface ScopeVerdict {
  ok: boolean;
  foreign: ScopeCommit[];
}

/** Commits of a GitHub compare response, in the shape the guard reads. */
export function scopeCommitsFrom(compare: unknown): ScopeCommit[] {
  const commits = (compare as { commits?: unknown } | null)?.commits;
  if (!Array.isArray(commits)) return [];
  return commits.flatMap((raw): ScopeCommit[] => {
    const r = raw as { sha?: unknown; parents?: unknown; commit?: { message?: unknown; author?: { date?: unknown } } };
    if (typeof r.sha !== 'string') return [];
    return [{
      sha: r.sha,
      message: typeof r.commit?.message === 'string' ? r.commit.message.split('\n')[0]! : '',
      authoredAt: typeof r.commit?.author?.date === 'string' ? r.commit.author.date : null,
      parents: Array.isArray(r.parents) ? r.parents.length : 1,
    }];
  });
}

export function evaluatePrScope(commits: ScopeCommit[], claimedAt: Date | null): ScopeVerdict {
  if (!claimedAt || Number.isNaN(claimedAt.getTime())) return { ok: true, foreign: [] };
  const foreign = commits.filter((c) => {
    if (c.parents > 1 || !c.authoredAt) return false;
    const t = Date.parse(c.authoredAt);
    return Number.isFinite(t) && t < claimedAt.getTime();
  });
  return { ok: foreign.length === 0, foreign };
}

const LISTED = 8;

export function scopeRefusalMessage(foreign: ScopeCommit[], base: string, head: string): string {
  const listed = foreign.slice(0, LISTED).map((c) => `  ${c.sha.slice(0, 7)} ${c.message}`.trimEnd()).join('\n');
  const more = foreign.length > LISTED ? `\n  ...and ${foreign.length - LISTED} more` : '';
  return `PR not opened: '${head}' carries ${foreign.length} commit${foreign.length === 1 ? '' : 's'} that predate this task's claim, so the PR into '${base}' would include work that is not this task's:\n${listed}${more}\n`
    + `Fix it one of two ways: start a fresh branch from origin/${base}, apply this task's commits there and open the PR from it; or move those commits off '${head}' (rebase them out) and push. `
    + `If including them is intended, a person can pass scopeOverride with a reason; it is recorded.`;
}
