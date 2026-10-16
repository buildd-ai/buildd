/**
 * Verdicts and the governed outcome (Living Specs D-5): whether work satisfies
 * the criteria of the spec revision it is pinned to, kept apart from whether
 * the task completed or its PR merged.
 *
 * Pure: no database, no network. A host stores verdicts however it likes and
 * passes them in.
 */

/**
 * `inconclusive`: the check could run but the evidence could not settle it.
 * `unsupported`: this host cannot run the check at all (missing capability).
 * Neither ever counts as a pass or a fail.
 */
export const VERDICTS = ['pass', 'fail', 'inconclusive', 'unsupported'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);

/**
 * The outcome of work governed by a set of criteria (Living Specs V1: the
 * acceptance criteria of the approved spec revision a task is pinned to),
 * kept apart from whether the task completed or its PR merged.
 *
 *  - `verified`: every criterion's newest verdict is `pass`, bound to the
 *    current head;
 *  - `fail`: some criterion's newest verdict is `fail`, at whatever head;
 *  - `unverified`: anything else — a criterion with no verdict, an
 *    `inconclusive` or `unsupported` one, a pass on an older head, no known
 *    head, or no criteria at all. Never a pass by default.
 */
export const GOVERNED_OUTCOMES = ['verified', 'fail', 'unverified'] as const;
export type GovernedOutcome = (typeof GOVERNED_OUTCOMES)[number];

export interface CriterionVerdict {
  criterionId: string;
  verdict: Verdict;
  headSha: string | null;
  at: Date | string;
}

export interface CriterionStanding {
  criterionId: string;
  /** The newest verdict, or null when none was recorded. */
  verdict: Verdict | null;
  headSha: string | null;
  /** The newest verdict judged a head other than the current one. */
  stale: boolean;
  /** Counts toward `verified`: a pass on the current head. */
  holds: boolean;
}

export interface GovernedOutcomeReadout {
  outcome: GovernedOutcome;
  currentHeadSha: string | null;
  criteria: CriterionStanding[];
  reason: string;
}

const sameHead = (a: string | null, b: string | null) => {
  if (!a || !b) return false;
  const x = a.toLowerCase(); const y = b.toLowerCase();
  // A short SHA binds when it is a prefix of the full one (7+ hex chars).
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** Fold recorded verdicts (any order, any criteria) into the outcome for `criteria`. */
export function foldGovernedOutcome(
  criteria: readonly string[],
  verdicts: readonly CriterionVerdict[],
  currentHeadSha: string | null,
): GovernedOutcomeReadout {
  const newest = new Map<string, CriterionVerdict>();
  for (const v of verdicts) {
    if (!isVerdict(v.verdict)) continue;
    const prev = newest.get(v.criterionId);
    if (!prev || new Date(v.at).getTime() >= new Date(prev.at).getTime()) newest.set(v.criterionId, v);
  }
  const standings: CriterionStanding[] = criteria.map((id) => {
    const v = newest.get(id);
    if (!v) return { criterionId: id, verdict: null, headSha: null, stale: false, holds: false };
    const onHead = sameHead(v.headSha, currentHeadSha);
    return { criterionId: id, verdict: v.verdict, headSha: v.headSha, stale: !onHead, holds: v.verdict === 'pass' && onHead };
  });
  const failed = standings.filter((s) => s.verdict === 'fail').map((s) => s.criterionId);
  if (failed.length > 0) return { outcome: 'fail', currentHeadSha, criteria: standings, reason: `${failed.join(', ')} failed` };
  if (criteria.length === 0) return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: 'no criteria to verify' };
  if (!currentHeadSha) return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: 'no PR head to verify against' };
  const open = standings.filter((s) => !s.holds);
  if (open.length === 0) return { outcome: 'verified', currentHeadSha, criteria: standings, reason: `all ${criteria.length} criteria pass on the current head` };
  const describe = (s: CriterionStanding) => (s.verdict === null ? `${s.criterionId} has no verdict` : s.verdict === 'pass' ? `${s.criterionId} passed on an older head` : `${s.criterionId} is ${s.verdict}`);
  return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: open.map(describe).join('; ') };
}
