import type { CriterionVerdict, LivingSpecCriterionStanding } from '@buildd/shared';

/**
 * The mission-level half of Living Specs Slice 12 (D-19/D-20, R-49..R-53),
 * pure: no database, no network. Given the mission's selected outcome spec
 * (its in-scope criteria and the ones a person waived), the mission-level
 * verdicts recorded so far and the integrated target, answer the `living_spec`
 * goal criterion.
 *
 * The rule is `foldGovernedOutcome`'s, applied to the mission's integrated
 * result instead of one task's PR head:
 *  - pass only when every in-scope, unwaived criterion's newest verdict is
 *    `pass` on the current target;
 *  - fail when any such criterion's newest verdict is `fail`;
 *  - otherwise not a pass: a criterion with no verdict, an `inconclusive` or
 *    `unsupported` one, a pass on a commit the target has moved past, or no
 *    known target at all.
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
}): MissionSpecFold {
  const waived = new Set(input.waived);
  const newest = new Map<string, MissionVerdictRow>();
  for (const r of input.rows) {
    const prev = newest.get(r.criterionId);
    if (!prev || new Date(r.at).getTime() >= new Date(prev.at).getTime()) newest.set(r.criterionId, r);
  }
  const targetSha = input.target.kind === 'integration' ? input.target.headSha : null;

  const standings: LivingSpecCriterionStanding[] = input.scope.map((criterionId) => {
    const row = newest.get(criterionId);
    if (waived.has(criterionId)) return { criterionId, standing: 'waived', headSha: row?.headSha ?? null, ...(row ? { verdictId: row.id } : {}) };
    if (!row) return { criterionId, standing: 'missing', headSha: null };
    // A fail stands until someone re-checks it, at whatever commit it judged.
    if (row.verdict === 'fail') return { criterionId, standing: 'fail', headSha: row.headSha, verdictId: row.id };
    if (!verdictIsCurrent(input.target, row.headSha)) return { criterionId, standing: 'stale', headSha: row.headSha, verdictId: row.id };
    return { criterionId, standing: row.verdict, headSha: row.headSha, verdictId: row.id };
  });

  const judged = standings.filter((s) => s.standing !== 'waived');
  const failed = judged.filter((s) => s.standing === 'fail');
  const passing = judged.filter((s) => s.standing === 'pass');
  const open = judged.filter((s) => s.standing !== 'pass');
  const waivedNote = waived.size > 0 ? ` ${count(standings.length - judged.length)} waived by a person.` : '';

  if (failed.length > 0) {
    return { verdict: 'fail', targetSha, standings, evidence: `${failed.map((s) => s.criterionId).join(', ')} failed. ${describeOpen(open.filter((s) => s.standing !== 'fail'))}${waivedNote}`.trim() };
  }
  if (input.target.kind === 'unknown') {
    return { verdict: 'UNVERIFIED', targetSha, standings, evidence: `No integrated target to verify against: ${input.target.reason}.${waivedNote}` };
  }
  if (judged.length === 0) {
    return { verdict: 'UNVERIFIED', targetSha, standings, evidence: `Nothing left to verify: every criterion is waived. Remove the outcome spec if the mission no longer answers to it.` };
  }
  const where = input.target.kind === 'integration' ? `on ${short(input.target.headSha)}` : 'on a commit holding every merged mission PR';
  if (open.length === 0) {
    return { verdict: 'pass', targetSha, standings, evidence: `All ${count(judged.length)} criteria pass ${where}.${waivedNote}` };
  }
  return {
    verdict: 'UNVERIFIED',
    targetSha,
    standings,
    evidence: `${capital(count(passing.length))} of ${count(judged.length)} pass ${where}. ${describeOpen(open)}${waivedNote}`.trim(),
  };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeOpen(open: LivingSpecCriterionStanding[]): string {
  if (open.length === 0) return '';
  const by = (k: LivingSpecCriterionStanding['standing']) => open.filter((s) => s.standing === k).map((s) => s.criterionId);
  const parts: string[] = [];
  const missing = by('missing'); const stale = by('stale'); const inconclusive = by('inconclusive'); const unsupported = by('unsupported');
  if (missing.length) parts.push(`${list(missing)} ${missing.length === 1 ? 'has' : 'have'} no verdict`);
  if (stale.length) parts.push(`${list(stale)} passed on an older commit`);
  if (inconclusive.length) parts.push(`${list(inconclusive)} ${inconclusive.length === 1 ? 'is' : 'are'} inconclusive`);
  if (unsupported.length) parts.push(`${list(unsupported)} could not be checked here`);
  return parts.length ? `${capital(parts.join('; '))}.` : '';
}

function list(ids: string[]): string {
  return ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', ');
}
