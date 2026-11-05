import { determiningVerdict, type Verdict, type VerdictSource } from '@buildd/spec-contract/outcome';

/**
 * "Matches what shipped" (Living Spec b7fc9316 R-34, AC-35): a waiting
 * revision whose pinned or provisional work has merged, and whose head
 * criteria all hold a pass verdict at the merged commit. Pure; the loader
 * (matches-shipped-store.ts) reads the merges and verdicts.
 *
 * A pass counts only for the wording and the commit it judged: a verdict
 * whose criterion text hash is not the head's (or is not recorded), or whose
 * head is not its task's merge commit, is no check. The label never approves.
 */
export interface ShippedCriterion { id: string; textHash: string }
export interface ShippedMerge { taskId: string; mergeSha: string }
export interface ShippedVerdict {
  taskId: string | null; criterionId: string; verdict: Verdict; headSha: string | null;
  at: Date | string; textHash: string | null; source?: VerdictSource;
}
export interface ShippedStanding {
  /** Some pinned work has merged. */
  merged: boolean;
  /** Every head criterion passed at the merged commit. */
  matches: boolean;
  /** When merged and not matching: the criteria that failed or have no check, in head order. */
  unmet: Array<{ id: string; state: 'failed' | 'no_check' }>;
}

const sameCommit = (a: string | null, b: string) => {
  if (!a) return false;
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

export function matchesShipped(input: { criteria: readonly ShippedCriterion[]; merges: readonly ShippedMerge[]; verdicts: readonly ShippedVerdict[] }): ShippedStanding {
  const { criteria, merges, verdicts } = input;
  if (!merges.length) return { merged: false, matches: false, unmet: [] };
  if (!criteria.length) return { merged: true, matches: false, unmet: [] };
  const mergeOf = new Map(merges.map((m) => [m.taskId, m.mergeSha]));
  const unmet: ShippedStanding['unmet'] = [];
  for (const c of criteria) {
    const counted = verdicts.filter((r) => r.criterionId === c.id && r.taskId != null && r.textHash === c.textHash && sameCommit(r.headSha, mergeOf.get(r.taskId) ?? ''));
    const decided = determiningVerdict(counted);
    if (decided?.verdict === 'pass') continue;
    unmet.push({ id: c.id, state: decided?.verdict === 'fail' ? 'failed' : 'no_check' });
  }
  return { merged: true, matches: unmet.length === 0, unmet };
}
