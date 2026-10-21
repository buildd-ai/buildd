import type { CriterionVerdict, LivingSpecCriterionStanding } from '@buildd/shared';
import { determiningVerdict, type VerdictSource } from '@buildd/spec-contract/outcome';

/**
 * The mission-level half of Living Specs Slice 12 (D-19/D-20, R-49..R-53),
 * pure: no database, no network. Given the mission's selected outcome spec
 * (its in-scope criteria and the ones a person waived), the mission-level
 * verdicts recorded so far and the integrated target, answer the `living_spec`
 * goal criterion.
 *
 * Achievement counts only test results on the integrated target (R-83).
 * Judged results remain in standings beside them, but never decide achievement.
 * Missing verdicts remain unverified; no tests or no known target is never a
 * pass. Tests at an older target must run again, including earlier failures.
 * Task-subject verdicts (a PR review's) are never an input, so a union of PR
 * passes cannot stand in for the integrated audit (AC-38).
 */

export type MissionTarget =
  /** mission-branch: the integration branch's head. Any new commit stales every verdict. */
  | { kind: 'integration'; headSha: string; branch: string }
  /**
   * direct: no single head. A verdict at commit H holds while H contains every
   * merged mission deliverable (the caller checks ancestry and passes the
   * commits that do as `validHeads`).
   */
  | { kind: 'direct'; mergeShas: string[]; validHeads: ReadonlySet<string> }
  | { kind: 'unknown'; reason: string };

export interface MissionVerdictRow {
  id: string;
  criterionId: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'unsupported';
  headSha: string | null;
  at: Date | string;
  /** Absent reads as a review; a test result outranks one (determiningVerdict). */
  source?: VerdictSource;
  /** The verdict's evidence, for filtering unaccepted acceptance test edits. */
  evidence?: Record<string, unknown>;
}

export interface MissionSpecFold {
  verdict: CriterionVerdict;
  evidence: string;
  targetSha: string | null;
  standings: LivingSpecCriterionStanding[];
}

const sameHead = (a: string | null, b: string | null) => {
  if (!a || !b) return false;
  const x = a.toLowerCase(); const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** Does a verdict recorded at `headSha` speak for the target as it is now? */
export function verdictIsCurrent(target: MissionTarget, headSha: string | null): boolean {
  if (!headSha) return false;
  if (target.kind === 'integration') return sameHead(headSha, target.headSha);
  if (target.kind === 'direct') return [...target.validHeads].some((h) => sameHead(h, headSha));
  return false;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (n: number) => (n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n));

export function foldMissionSpec(input: {
  /** Every in-scope criterion id (the narrowed scope, else all of the revision). */
  scope: readonly string[];
  /** Criteria a person waived: shown as waived, left out of the fold. */
  waived: readonly string[];
  rows: readonly MissionVerdictRow[];
  target: MissionTarget;
  /** Acceptance test file paths that have been edited but not accepted yet (R-80). */
  unacceptedTestPaths?: readonly string[];
}): MissionSpecFold {
  const waived = new Set(input.waived);
  // If any building task edited acceptance tests without accepting, drop acceptance test verdicts (R-80).
  const hasUnacceptedEdits = (input.unacceptedTestPaths?.length ?? 0) > 0;
  const filtered = hasUnacceptedEdits ? input.rows.filter((r) => {
    if (r.source !== 'test') return true;
    const evidence = r.evidence as Record<string, unknown> | undefined;
    return evidence?.kind !== 'acceptance-test';
  }) : input.rows;
  const grouped = new Map<string, MissionVerdictRow[]>();
  for (const r of filtered) grouped.set(r.criterionId, [...(grouped.get(r.criterionId) ?? []), r]);
  const newest = new Map<string, MissionVerdictRow>();
  const outranked = new Map<string, number>();
  for (const [id, rows] of grouped) {
    // A review cannot turn a test that could not settle the check into an
    // achieved result. Keep those test results open as well as test failures.
    const tests = rows.filter((r) => r.source === 'test');
    const d = determiningVerdict(tests.length ? tests : rows)!;
    newest.set(id, d);
    if (d.source === 'test') outranked.set(id, rows.filter((r) => (r.source ?? 'review') === 'review').length);
  }
  const targetSha = input.target.kind === 'integration' ? input.target.headSha : null;
  const staleFails = new Set<string>();

  const fold = (criterionId: string): LivingSpecCriterionStanding => {
    const row = newest.get(criterionId);
    if (waived.has(criterionId)) return { criterionId, standing: 'waived', headSha: row?.headSha ?? null, ...(row ? { verdictId: row.id, source: row.source ?? 'review' } : {}) };
    if (!row) return { criterionId, standing: 'missing', headSha: null };
    // A fail stands while it judged the target as it is now. Once the target
    // moves past it (a repair or any other mission PR merged), it is stale and
    // checked again, like a pass (c5a2c67b R-4). With no known target it stands.
    if (row.verdict === 'fail' && (input.target.kind === 'unknown' || verdictIsCurrent(input.target, row.headSha))) {
      return { criterionId, standing: 'fail', headSha: row.headSha, verdictId: row.id, source: row.source ?? 'review' };
    }
    if (!verdictIsCurrent(input.target, row.headSha)) {
      if (row.verdict === 'fail') staleFails.add(criterionId);
      return { criterionId, standing: 'stale', headSha: row.headSha, verdictId: row.id, source: row.source ?? 'review' };
    }
    return { criterionId, standing: row.verdict, headSha: row.headSha, verdictId: row.id, source: row.source ?? 'review' };
  };
  const standings: LivingSpecCriterionStanding[] = input.scope.map((criterionId) => {
    const s = fold(criterionId);
    const n = outranked.get(criterionId);
    return n ? { ...s, overriddenReviews: n } : s;
  });

  const active = standings.filter((s) => s.standing !== 'waived');
  // Missing results remain open rather than silently shrinking the scope.
  const tested = active.filter((s) => s.source === 'test' || s.standing === 'missing');
  const failed = tested.filter((s) => s.standing === 'fail');
  const passing = tested.filter((s) => s.standing === 'pass');
  const open = tested.filter((s) => s.standing !== 'pass');
  const waivedNote = waived.size > 0 ? ` ${count(standings.length - active.length)} waived by a person.` : '';

  if (failed.length > 0) {
    return { verdict: 'fail', targetSha, standings, evidence: `${failed.map((s) => s.criterionId).join(', ')} failed. ${describeOpen(open.filter((s) => s.standing !== 'fail'), staleFails)}${waivedNote}`.trim() };
  }
  if (input.target.kind === 'unknown') {
    return { verdict: 'UNVERIFIED', targetSha, standings, evidence: `No integrated target to verify against: ${input.target.reason}.${waivedNote}` };
  }
  if (active.length === 0) {
    return { verdict: 'UNVERIFIED', targetSha, standings, evidence: `Nothing left to verify: every criterion is waived. Remove the outcome spec if the mission no longer answers to it.` };
  }
  if (!tested.some((s) => s.source === 'test')) {
    return { verdict: 'UNVERIFIED', targetSha, standings, evidence: `No tested checks on the integrated result. Judged results do not count toward achievement.${waivedNote}` };
  }
  const where = input.target.kind === 'integration' ? `on ${short(input.target.headSha)}` : 'on a commit holding every merged mission PR';
  if (open.length === 0) {
    return { verdict: 'pass', targetSha, standings, evidence: `${tested.length === 1 ? 'The tested check passes' : `All ${count(tested.length)} tested checks pass`} ${where}.${waivedNote}` };
  }
  return {
    verdict: 'UNVERIFIED',
    targetSha,
    standings,
    evidence: `${capital(count(passing.length))} of ${count(tested.length)} pass ${where}. ${describeOpen(open, staleFails)}${waivedNote}`.trim(),
  };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeOpen(open: LivingSpecCriterionStanding[], staleFails: ReadonlySet<string> = new Set()): string {
  if (open.length === 0) return '';
  const by = (k: LivingSpecCriterionStanding['standing']) => open.filter((s) => s.standing === k).map((s) => s.criterionId);
  const parts: string[] = [];
  const missing = by('missing'); const inconclusive = by('inconclusive'); const unsupported = by('unsupported');
  const staleAll = by('stale');
  const staleFailed = staleAll.filter((id) => staleFails.has(id)); const stale = staleAll.filter((id) => !staleFails.has(id));
  if (missing.length) parts.push(`${list(missing)} ${missing.length === 1 ? 'has' : 'have'} no verdict`);
  if (staleFailed.length) parts.push(`${list(staleFailed)} failed on an older commit`);
  if (stale.length) parts.push(`${list(stale)} passed on an older commit`);
  if (inconclusive.length) parts.push(`${list(inconclusive)} ${inconclusive.length === 1 ? 'is' : 'are'} inconclusive`);
  if (unsupported.length) parts.push(`${list(unsupported)} could not be checked here`);
  return parts.length ? `${capital(parts.join('; '))}.` : '';
}

function list(ids: string[]): string {
  return ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', ');
}
