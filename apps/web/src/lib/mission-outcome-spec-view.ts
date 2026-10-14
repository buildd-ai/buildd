// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * A mission's selected outcome spec (Living Specs Slice 12, spec f7f67f1a
 * R-29..R-31) as words, from the one `GoalCriteriaState` entry the evaluator
 * wrote for its `living_spec` criterion. Pure: the goal criteria row and the
 * Overview's Verify row both read it, so the two never disagree.
 *
 * Only `pass` counts as passed. A waived criterion is listed as waived, a
 * stale pass as out of date: neither is ever counted with the passes.
 */
import type { CriterionVerdict, GoalCriteriaState, LivingSpecCriterionStanding, LivingSpecGoalCriterion } from '@buildd/shared';

type Standing = LivingSpecCriterionStanding['standing'];
type StateEntry = GoalCriteriaState['criteria'][number];

/** What still stands between the spec and a pass, in the order to fix it. */
export const OPEN_STANDINGS = ['fail', 'missing', 'stale', 'inconclusive', 'unsupported'] as const;
export type OpenStanding = (typeof OPEN_STANDINGS)[number];

const OPEN_WORDS: Record<OpenStanding, string> = {
  fail: 'Not met',
  missing: 'Not checked',
  stale: 'Out of date',
  inconclusive: 'Could not tell',
  unsupported: 'Cannot be checked',
};

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** A count in words up to twelve, digits after. */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface OutcomeSpecView {
  specId: string;
  revision: number;
  provisional: boolean;
  /** e.g. "Revision 7, proposed". */
  revisionLine: string;
  /** e.g. "Nine of twelve pass on abc1234." Null before any check has run. */
  coverage: string | null;
  /** e.g. "9 of 12 pass". The short form, for a row's right edge. */
  short: string;
  passed: number;
  total: number;
  open: { standing: OpenStanding; label: string; criterionIds: string[] }[];
  waived: { criterionId: string; reason: string }[];
  narrowed: { criterionIds: string[]; reason: string } | null;
  /** The final verification task, when one is filed. */
  verificationTaskId: string | null;
  /** Who acts next, as a sentence. */
  next: string;
  verdict: CriterionVerdict;
}

/**
 * The view of one `living_spec` criterion. `entry` is its evaluated state, or
 * null before the criteria were first checked (then everything in scope reads
 * not checked). `opts.buildDone` is the caller's own reading of the build and
 * wins over the one stored with the evaluation; with neither, the view does
 * not claim the build is still running.
 */
export function outcomeSpecView(
  c: LivingSpecGoalCriterion,
  entry: StateEntry | null | undefined,
  opts: { buildDone?: boolean } = {},
): OutcomeSpecView {
  const standings = entry?.spec?.standings ?? [];
  const waived = (c.waived ?? []).map(w => ({ criterionId: w.criterionId, reason: w.reason }));
  const waivedIds = new Set(waived.map(w => w.criterionId));
  const by = new Map<Standing, string[]>();
  for (const s of standings) {
    // The criterion's own waiver list wins: a waived criterion never counts as a pass.
    const standing: Standing = waivedIds.has(s.criterionId) ? 'waived' : s.standing;
    by.set(standing, [...(by.get(standing) ?? []), s.criterionId]);
  }
  const passed = (by.get('pass') ?? []).length;
  const total = standings.length;
  const open = OPEN_STANDINGS.filter(s => (by.get(s) ?? []).length > 0).map(s => ({ standing: s, label: OPEN_WORDS[s], criterionIds: by.get(s)! }));
  const target = entry?.spec?.targetSha ? entry.spec.targetSha.slice(0, 7) : null;
  const verdict: CriterionVerdict = entry?.verdict ?? 'UNVERIFIED';
  const verificationTaskId = entry?.workerTaskId ?? null;

  const coverage = total === 0
    ? null
    : `${capital(countWord(passed))} of ${countWord(total)} pass${target ? ` on ${target}` : ''}.`;

  let next: string;
  if (verdict === 'pass') next = 'Every requirement in scope passes on the integrated result.';
  else if (by.get('fail')?.length) next = 'A repair task fixes what is not met, then the check runs again.';
  else if (verificationTaskId) next = 'The final verification checks each requirement on the integrated result.';
  else {
    const buildDone = opts.buildDone ?? entry?.spec?.buildDone;
    if (buildDone === false) next = target ? 'Checked once the build work is done.' : 'Checked once the build is done and the integrated branch is known.';
    else if (buildDone === true) next = target ? 'The build is done. The final verification starts on the next check.' : 'The build is done. Checked once the integrated branch is known.';
    else next = 'The final verification has not started.';
  }

  return {
    specId: c.specId,
    revision: c.revision,
    provisional: !!c.provisional,
    revisionLine: `Revision ${c.revision}${c.provisional ? ', proposed' : ''}`,
    coverage,
    short: total === 0 ? 'not checked' : `${passed} of ${total} pass`,
    passed,
    total,
    open,
    waived,
    narrowed: c.criteria && c.narrowedReason ? { criterionIds: [...c.criteria], reason: c.narrowedReason } : null,
    verificationTaskId,
    next,
    verdict,
  };
}
