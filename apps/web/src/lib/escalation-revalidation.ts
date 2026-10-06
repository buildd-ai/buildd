/**
 * Is a blocking review verdict still about this PR as it is now?
 *
 * A reviewer's `escalate` or `request-changes` is a claim about one commit in
 * one state of the repo. Two things can make it stale without anyone acting on
 * it:
 *
 *  1. The head moved. A verdict about commit A says nothing about commit B, and
 *     the push that moved it may be the fix. The synchronize webhook re-sends a
 *     reviewer for this, but only for agent-review PRs and only if the webhook
 *     arrives, so a missed event or a mission PR left the old verdict in charge.
 *  2. The verdict rested on mutable state outside the diff: a sibling PR being
 *     open, a migration number collision, a merge conflict. Those resolve on
 *     their own (the sibling merges, a renumbered migration is pushed, a base
 *     merge clears the conflict), and the verdict keeps blocking regardless.
 *
 * A stale verdict is never merged past. Its remedy is a fresh review of the
 * live head, which may well block again; that is the reviewer's call. So the
 * cost of a false "stale" is one review, and the landing function only spends
 * it once per blocking review task (see `claimReviewRevalidation`).
 *
 * Pure: the caller reads the sibling PRs and says whether the migration and
 * conflict rails pass on the live head.
 */

export interface MutableClaims {
  /** Other PRs the verdict names, which it may have assumed were open. */
  prNumbers: number[];
  migrationCollision: boolean;
  conflict: boolean;
}

/** A cap on sibling reads: a verdict naming more PRs than this is not a sibling-state claim we can settle cheaply. */
export const MAX_SIBLING_PR_READS = 5;

const PR_REF = /(?:\bPR\s*#?\s*|(?<![\w/])#)(\d{1,7})\b/gi;
const MIGRATION_COLLISION = /migration[^.\n]{0,40}\b(collision|collides|colliding|clash(es)?)\b|\b(collision|collides|colliding|clash(es)?)\b[^.\n]{0,60}\bmigration|duplicate migration (number|index|prefix)/i;
const CONFLICT = /\bmerge conflicts?\b|\bconflicts? with (the )?base\b|\bnot mergeable\b|\bmergeable[_ ]state[^.\n]{0,20}dirty\b|\bhas conflicts\b/i;

export function extractMutableClaims(text: string | null | undefined, ownPrNumber: number): MutableClaims {
  const body = text ?? '';
  const prNumbers = new Set<number>();
  for (const m of body.matchAll(PR_REF)) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > 0 && n !== ownPrNumber) prNumbers.add(n);
  }
  return {
    prNumbers: [...prNumbers],
    migrationCollision: MIGRATION_COLLISION.test(body),
    conflict: CONFLICT.test(body),
  };
}

export const hasMutableClaims = (c: MutableClaims): boolean =>
  c.prNumbers.length > 0 || c.migrationCollision || c.conflict;

export type SiblingState = 'open' | 'closed' | 'merged' | 'unknown';

export type StalenessVerdict =
  | { stale: true; basis: 'head_moved' | 'external_state'; why: string }
  | { stale: false; why: string };

const short = (sha: string) => sha.slice(0, 7);

function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

export function judgeBlockingVerdict(input: {
  reviewHeadSha: string | null | undefined;
  liveHeadSha: string;
  /** Heads recorded as carrying the same diff as the reviewed one. */
  equivalentHeadShas?: string[] | null;
  claims: MutableClaims;
  siblings: Record<number, SiblingState>;
  /** The migration rail passes on the live head (no collision found now). */
  migrationClear: boolean;
  /** GitHub does not report the live head as conflicting. */
  conflictClear: boolean;
}): StalenessVerdict {
  const reviewed = normalizeSha(input.reviewHeadSha);
  const live = normalizeSha(input.liveHeadSha);
  if (reviewed && live && reviewed !== live) {
    const equivalent = (input.equivalentHeadShas ?? []).some((s) => normalizeSha(s) === live);
    if (!equivalent) {
      return {
        stale: true,
        basis: 'head_moved',
        why: `the verdict was given on ${short(reviewed)} and the head is now ${short(live)}`,
      };
    }
  }

  const { claims } = input;
  if (!hasMutableClaims(claims)) return { stale: false, why: 'the verdict cites nothing outside the diff' };

  const cleared: string[] = [];
  if (claims.prNumbers.length > 0) {
    if (claims.prNumbers.length > MAX_SIBLING_PR_READS) {
      return { stale: false, why: `the verdict names ${claims.prNumbers.length} other PRs` };
    }
    for (const n of claims.prNumbers) {
      const state = input.siblings[n] ?? 'unknown';
      if (state === 'open') return { stale: false, why: `PR #${n} is still open` };
      if (state === 'unknown') return { stale: false, why: `could not read PR #${n}` };
      cleared.push(`PR #${n} is now ${state}`);
    }
  }
  if (claims.migrationCollision) {
    if (!input.migrationClear) return { stale: false, why: 'the migration collision is still there' };
    cleared.push('no migration collision is found on the current head');
  }
  if (claims.conflict) {
    if (!input.conflictClear) return { stale: false, why: 'the PR still conflicts with its base' };
    cleared.push('the PR no longer conflicts with its base');
  }
  return { stale: true, basis: 'external_state', why: cleared.join('; ') };
}
