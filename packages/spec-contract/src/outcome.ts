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

/**
 * Which signal produced a verdict. `test`: a criterion check run, whose exit
 * code is the verdict. `review`: anything a person or an agent judged (a
 * reviewer, a final verification, a visual audit).
 */
export const VERDICT_SOURCES = ['test', 'review'] as const;
export type VerdictSource = (typeof VERDICT_SOURCES)[number];

/** The source of a verdict from its `recordedBy` author; check runs author `check:<task id>`, everything else is a review. */
export const verdictSourceOf = (recordedBy: unknown): VerdictSource =>
  typeof recordedBy === 'string' && recordedBy.startsWith('check:') ? 'test' : 'review';

/**
 * The source of a stored verdict row from its evidence blob. A registered
 * `verify:` result is a review whatever its method (kept in `evidence.method`),
 * including rows recorded before that rule under a `check:registered:` author.
 */
export const verdictSourceOfEvidence = (evidence: unknown): VerdictSource => {
  const e = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : null;
  return e?.kind === 'registered' ? 'review' : verdictSourceOf(e?.recordedBy ?? null);
};

/**
 * What verified a criterion, as kept on a verdict_criteria link. `test` and
 * `review` are the two VerdictSources; `baseline` is a verdict taken from the
 * state a criterion already held before the work (author `baseline:<id>`). A
 * baseline verdict ranks as a review when the deciding verdict is chosen.
 */
export const VERIFIED_BY = ['test', 'review', 'baseline'] as const;
export type VerifiedBy = (typeof VERIFIED_BY)[number];

/** The verified_by of a verdict from its `recordedBy` author. */
export const verifiedByOf = (recordedBy: unknown): VerifiedBy =>
  typeof recordedBy === 'string' && recordedBy.startsWith('baseline:') ? 'baseline' : verdictSourceOf(recordedBy);

/** The verified_by of a stored verdict row from its evidence blob. */
export const verifiedByOfEvidence = (evidence: unknown): VerifiedBy => {
  const e = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>) : null;
  return e?.kind === 'registered' ? 'review' : verifiedByOf(e?.recordedBy ?? null);
};

export interface CriterionVerdict {
  criterionId: string;
  verdict: Verdict;
  headSha: string | null;
  at: Date | string;
  /** Absent reads as `review`. */
  source?: VerdictSource;
  /** Approved immutable verifier binding; absent for legacy command/review rows. */
  bindingFingerprint?: string | null;
}

/**
 * The one verdict that decides a criterion (Living Specs: a test result
 * outranks a reviewer's opinion). Among a criterion's verdicts: if any test
 * produced a result (pass or fail), the newest such test decides and no review
 * can override it, whenever the review was recorded; a later test supersedes
 * it. A test that settled nothing (inconclusive, unsupported) does not
 * suppress a review. With no test result, the newest verdict stands.
 */
export function determiningVerdict<T extends { verdict: Verdict; at: Date | string; source?: VerdictSource }>(rows: readonly T[]): T | null {
  const newest = (xs: readonly T[]) => xs.reduce<T | null>((best, x) => (!best || new Date(x.at).getTime() >= new Date(best.at).getTime() ? x : best), null);
  const tests = rows.filter((x) => x.source === 'test' && (x.verdict === 'pass' || x.verdict === 'fail'));
  return newest(tests) ?? newest(rows);
}

export interface CriterionStanding {
  criterionId: string;
  /** The deciding verdict (see determiningVerdict), or null when none was recorded. */
  verdict: Verdict | null;
  /** Which signal decided it; null when there is no verdict. */
  source: VerdictSource | null;
  headSha: string | null;
  /** The newest verdict judged a head other than the current one. */
  stale: boolean;
  /** Counts toward `verified`: a pass on the current head. */
  holds: boolean;
  /**
   * Model results on the same commit that a test result outranked: kept and
   * shown beside the deciding test, never replacing it. Empty unless a test decides.
   */
  notes: CriterionNote[];
  /** Review verdicts a deciding test result outranks (R-85); 0 unless a test decided. */
  overriddenReviews: number;
}

export interface CriterionNote {
  verdict: Verdict;
  source: VerdictSource;
  headSha: string | null;
  at: Date | string;
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
  requiredBindings?: ReadonlyMap<string, readonly string[]>,
): GovernedOutcomeReadout {
  const byCriterion = new Map<string, CriterionVerdict[]>();
  for (const v of verdicts) {
    if (!isVerdict(v.verdict)) continue;
    byCriterion.set(v.criterionId, [...(byCriterion.get(v.criterionId) ?? []), v]);
  }
  const newest = new Map<string, CriterionVerdict>();
  const overridden = new Map<string, number>();
  for (const [id, rows] of byCriterion) {
    const legacy = rows.filter((r) => !r.bindingFingerprint);
    const d = determiningVerdict(legacy);
    if (!d) continue;
    newest.set(id, d);
    overridden.set(id, d.source === 'test' ? legacy.filter((r) => (r.source ?? 'review') === 'review').length : 0);
  }
  const requiredFailures = new Set<string>();
  const standings: CriterionStanding[] = criteria.map((id) => {
    const required = requiredBindings?.get(id) ?? [];
    if (required.length) {
      const rows = byCriterion.get(id) ?? [];
      // Every binding has independent authority. Legacy commands/reviews keep
      // their own precedence, so a registered pass cannot hide a command fail.
      const checks = [...new Set(required)].map((fingerprint) => {
        const matching = rows.filter((r) => r.bindingFingerprint === fingerprint);
        const current = matching.filter((r) => sameHead(r.headSha, currentHeadSha));
        return foldGovernedOutcome([id], (current.length ? current : matching).map(({ bindingFingerprint: _b, ...r }) => r), currentHeadSha).criteria[0]!;
      });
      const legacy = rows.filter((r) => !r.bindingFingerprint);
      const base = legacy.length ? foldGovernedOutcome([id], legacy, currentHeadSha).criteria[0]! : null;
      const failed = base?.verdict === 'fail' ? base : checks.find((s) => s.verdict === 'fail' && !s.stale);
      if (failed) { requiredFailures.add(id); return failed; }
      if (base) checks.push(base);
      return checks.find((s) => !s.holds) ?? checks[0]!;
    }
    const v = newest.get(id);
    if (!v) return { criterionId: id, verdict: null, source: null, headSha: null, stale: false, holds: false, notes: [], overriddenReviews: 0 };
    const onHead = sameHead(v.headSha, currentHeadSha);
    const notes: CriterionNote[] = v.source === 'test'
      ? (byCriterion.get(id) ?? [])
        .filter((x) => !x.bindingFingerprint && x.source !== 'test' && sameHead(x.headSha, v.headSha))
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .map((x) => ({ verdict: x.verdict, source: x.source ?? 'review', headSha: x.headSha, at: x.at }))
      : [];
    return { criterionId: id, verdict: v.verdict, source: v.source ?? 'review', headSha: v.headSha, stale: !onHead, holds: v.verdict === 'pass' && onHead, notes, overriddenReviews: overridden.get(id) ?? 0 };
  });
  const failed = standings.filter((s) => requiredBindings?.get(s.criterionId)?.length ? requiredFailures.has(s.criterionId) : s.verdict === 'fail').map((s) => s.criterionId);
  if (failed.length > 0) return { outcome: 'fail', currentHeadSha, criteria: standings, reason: `${failed.join(', ')} failed` };
  if (criteria.length === 0) return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: 'no criteria to verify' };
  if (!currentHeadSha) return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: 'no PR head to verify against' };
  const open = standings.filter((s) => !s.holds);
  if (open.length === 0) return { outcome: 'verified', currentHeadSha, criteria: standings, reason: `all ${criteria.length} criteria pass on the current head` };
  const describe = (s: CriterionStanding) => (s.verdict === null ? `${s.criterionId} has no verdict` : s.stale && s.verdict === 'fail' ? `${s.criterionId} failed on an older head` : s.verdict === 'pass' ? `${s.criterionId} passed on an older head` : `${s.criterionId} is ${s.verdict}`);
  return { outcome: 'unverified', currentHeadSha, criteria: standings, reason: open.map(describe).join('; ') };
}
