import { determiningVerdict, type CriterionVerdict, type VerifiedBy } from '@buildd/spec-contract/outcome';

/** A recorded verdict, tagged with what produced it (`baseline` = taken before the work). */
export type BaselineVerdict = CriterionVerdict & { verifiedBy?: VerifiedBy };

export const BASELINE_STATES = ['baseline-red', 'already-satisfied', 'regressed', 'fixed', 'no-baseline'] as const;
export type BaselineState = (typeof BASELINE_STATES)[number];

export interface BaselineClassification {
  criterionId: string;
  state: BaselineState;
  /** The verdict the branch settled on, or null when only a baseline (or nothing) was recorded. */
  branch: CriterionVerdict['verdict'] | null;
}

/**
 * Classify each criterion against its baseline verdict (the state it held
 * before the work):
 * - `baseline-red`: failed at baseline and the branch has not passed it.
 * - `fixed`: failed at baseline, passes on the branch.
 * - `already-satisfied`: passed at baseline and the branch does not fail it.
 * - `regressed`: passed at baseline, fails on the branch.
 * - `no-baseline`: no pass/fail baseline was recorded.
 * Branch verdicts are every non-baseline row; a test outranks a review there.
 */
export function classifyBaseline(criteria: readonly string[], verdicts: readonly BaselineVerdict[]): BaselineClassification[] {
  return criteria.map((criterionId) => {
    const rows = verdicts.filter((v) => v.criterionId === criterionId);
    const base = determiningVerdict(rows.filter((v) => v.verifiedBy === 'baseline' && (v.verdict === 'pass' || v.verdict === 'fail')));
    const branch = determiningVerdict(rows.filter((v) => v.verifiedBy !== 'baseline'))?.verdict ?? null;
    if (!base) return { criterionId, state: 'no-baseline', branch };
    if (base.verdict === 'fail') return { criterionId, state: branch === 'pass' ? 'fixed' : 'baseline-red', branch };
    return { criterionId, state: branch === 'fail' ? 'regressed' : 'already-satisfied', branch };
  });
}
