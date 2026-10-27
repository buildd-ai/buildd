// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Verify's Requirements, as data (Navigation d25d923d R-17, R-18, AC-11).
 *
 * ```
 * Requirements                                   18 of 21 met
 * From Cloud runner: deploy from Settings              15 of 18
 *   ✗ A cloud runner bundle on every release
 *     Not met · Test output · Fixing: Publish the bundle, running 8m
 *   ○ The release publishes an image digest
 *     Couldn't tell · rechecks after Publish the bundle merges
 *   15 met ›
 * From Settings: Runners · the 3 this mission adds      ✓ 3 of 3
 * ```
 *
 * One group per selected outcome spec, counting only the criteria the
 * mission has in scope. Only the unmet are listed, each with its result in
 * words, the evidence behind it and what is being done; the met fold into one
 * row, and a group that is all met is one line. Standards are not here: they
 * are Verify's Standards line.
 *
 * Pure: the page reads the evaluated state and the evidence
 * (`loadMissionEvidence`) and hands both in. Only `pass` is met; waived is
 * neither met nor counted, and a check made for an earlier selection is not
 * counted at all.
 */
import type { GoalCriteriaState, GoalCriterion, LivingSpecCriterionStanding, LivingSpecGoalCriterion } from '@buildd/shared';
import { criterionFingerprint, isStandardCriterion } from '@buildd/core/mission-helpers';
import type { RepairInFlight, VerdictEvidence } from './specs/mission-evidence';

type StateEntry = GoalCriteriaState['criteria'][number];
type Standing = LivingSpecCriterionStanding['standing'];

/** What the page loaded behind the verdicts: their evidence by verdict id, and the repairs in play. */
export interface VerifyEvidence {
  verdicts: ReadonlyMap<string, VerdictEvidence>;
  repairs: readonly RepairInFlight[];
}

export type UnmetResult = 'Not met' | "Couldn't tell" | 'Not checked' | 'Out of date';

export interface VerifyLink { label: string; href: string }

/** What is being done about an unmet requirement: a repair at work, or the one it rechecks after. */
export interface VerifyAction {
  kind: 'fixing' | 'rechecks';
  taskId: string;
  title: string;
  href: string;
  /** `running 8m`, `queued`, or null for `rechecks`. */
  detail: string | null;
  /** The whole line, for a reader and for tests. */
  text: string;
}

export interface UnmetRequirement {
  id: string;
  /** The criterion's own words; null on a state evaluated before they were kept. */
  text: string | null;
  result: UnmetResult;
  evidence: VerifyLink[];
  action: VerifyAction | null;
}

export interface VerifyGroup {
  key: string;
  specId: string;
  /** `From <title>`. */
  title: string;
  /** The spec at the revision the mission selected. */
  href: string;
  /** `the 3 this mission adds`, when the mission narrowed its scope. */
  scope: string | null;
  /** Whether a check for the current selection has run. */
  checked: boolean;
  /** A verification is running now. */
  checking: boolean;
  metCount: number;
  /** In-scope requirements, waived left out. Null before a check when the scope is the whole spec. */
  total: number | null;
  /** `15 of 18`; null before a check. */
  count: string | null;
  allMet: boolean;
  unmet: UnmetRequirement[];
  met: { id: string; text: string | null }[];
  waived: number;
}

export interface MissionVerifyView {
  groups: VerifyGroup[];
  metCount: number;
  total: number;
  /** `18 of 21 met`, or `Not checked` before any group is checked. */
  summary: string;
  allMet: boolean;
}

const UNMET_WORDS: Record<Exclude<Standing, 'pass' | 'waived'>, UnmetResult> = {
  fail: 'Not met',
  inconclusive: "Couldn't tell",
  unsupported: "Couldn't tell",
  missing: 'Not checked',
  stale: 'Out of date',
};

/** Not met first, then what could not be told, then what has not been checked. */
const UNMET_ORDER: readonly Standing[] = ['fail', 'inconclusive', 'unsupported', 'stale', 'missing'];

const TASK_IN_RECORDER = /^(?:final-verification|check):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** `8m`, `1h 12m`. */
export function runningFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function specTitle(c: LivingSpecGoalCriterion, titles: Readonly<Record<string, string>>): string {
  return titles[c.specId] ?? c.label ?? `Spec revision ${c.revision}`;
}

function evidenceLinks(s: LivingSpecCriterionStanding, ev: VerdictEvidence | undefined, specHref: string, missionId: string): VerifyLink[] {
  if (!ev) return [];
  const task = ev.recordedBy ? TASK_IN_RECORDER.exec(ev.recordedBy)?.[1] ?? null : null;
  const where = task ? `/app/tasks/${task}` : `${specHref}#${encodeURIComponent(s.criterionId)}`;
  const out: VerifyLink[] = [];
  if (ev.stdoutExcerpt) out.push({ label: 'Test output', href: where });
  const shots = ev.refs.filter(r => r.kind === 'screenshot').length;
  if (shots > 0) out.push({ label: shots === 1 ? 'Screenshot' : `${shots} screenshots`, href: `/app/missions/${encodeURIComponent(missionId)}?visualReview=1` });
  if (ev.observed && !ev.stdoutExcerpt && s.source !== 'test') out.push({ label: 'Reviewer note', href: where });
  return out;
}

function repairAction(r: RepairInFlight, now: number, own: boolean): VerifyAction {
  const href = `/app/tasks/${r.taskId}`;
  // Finished with its PR still open, or another criterion's repair: the check runs again once it merges.
  if (!own || r.status === 'completed') {
    return { kind: 'rechecks', taskId: r.taskId, title: r.title, href, detail: null, text: `rechecks after ${r.title} merges` };
  }
  const detail = r.workerStartedAt ? `running ${runningFor(now - Date.parse(r.workerStartedAt))}` : 'queued';
  return { kind: 'fixing', taskId: r.taskId, title: r.title, href, detail, text: `Fixing: ${r.title}, ${detail}` };
}

function actionFor(specId: string, criterionId: string, evidence: VerifyEvidence | null, now: number): VerifyAction | null {
  if (!evidence) return null;
  const own = evidence.repairs.find(r => r.criterionId === criterionId && r.specId === specId)
    ?? evidence.repairs.find(r => r.criterionId === criterionId && r.specId === null);
  if (own) return repairAction(own, now, true);
  // Another requirement's repair changes the merged result: this one is checked again after it.
  const other = evidence.repairs.find(r => r.specId === specId) ?? evidence.repairs[0];
  return other ? repairAction(other, now, false) : null;
}

/** One selected spec as a Verify group. `entry` is its evaluated state, or null before the first check. */
export function specGroup(
  c: LivingSpecGoalCriterion,
  entry: StateEntry | null | undefined,
  ctx: { missionId: string; titles: Readonly<Record<string, string>>; evidence: VerifyEvidence | null; now: number },
): VerifyGroup {
  const href = `/app/specs/${c.specId}?revision=${c.revision}`;
  const narrowed = c.criteria?.length ?? 0;
  const current = !!entry && (!entry.fingerprint || entry.fingerprint === criterionFingerprint(c));
  const standings = current ? entry!.spec?.standings ?? [] : [];
  const checked = current && standings.length > 0;
  const waivedIds = new Set((c.waived ?? []).map(w => w.criterionId));
  const isWaived = (s: LivingSpecCriterionStanding) => s.standing === 'waived' || waivedIds.has(s.criterionId);

  const counted = standings.filter(s => !isWaived(s));
  const met = counted.filter(s => s.standing === 'pass');
  const unmet = counted
    .filter(s => s.standing !== 'pass')
    .sort((a, b) => UNMET_ORDER.indexOf(a.standing) - UNMET_ORDER.indexOf(b.standing))
    .map((s): UnmetRequirement => ({
      id: s.criterionId,
      text: s.text ?? null,
      result: UNMET_WORDS[s.standing as keyof typeof UNMET_WORDS],
      evidence: evidenceLinks(s, s.verdictId ? ctx.evidence?.verdicts.get(s.verdictId) : undefined, href, ctx.missionId),
      action: actionFor(c.specId, s.criterionId, ctx.evidence, ctx.now),
    }));
  const total = checked ? counted.length : narrowed > 0 ? narrowed : null;

  return {
    key: `spec-${c.specId}`,
    specId: c.specId,
    title: specTitle(c, ctx.titles),
    href,
    scope: narrowed > 0 ? `the ${narrowed} this mission adds` : null,
    checked,
    checking: current && entry!.verdict === 'PENDING',
    metCount: met.length,
    total,
    count: checked ? `${met.length} of ${counted.length}` : null,
    allMet: checked && unmet.length === 0,
    unmet,
    met: met.map(s => ({ id: s.criterionId, text: s.text ?? null })),
    waived: standings.length - counted.length,
  };
}

/**
 * The mission's Requirements: one group per selected outcome spec, in the
 * order they were selected. Null when the mission selects no spec (a legacy
 * mission's hand-written criteria are listed on their own, read-only).
 */
export function missionVerifyView(input: {
  missionId: string;
  criteria: readonly GoalCriterion[];
  state: GoalCriteriaState | null;
  titles: Readonly<Record<string, string>>;
  evidence: VerifyEvidence | null;
  now: number;
}): MissionVerifyView | null {
  const byIndex = new Map((input.state?.criteria ?? []).map(e => [e.index, e]));
  const groups: VerifyGroup[] = [];
  input.criteria.forEach((c, i) => {
    if (c.type !== 'living_spec' || isStandardCriterion(c)) return;
    groups.push(specGroup(c, byIndex.get(i), input));
  });
  if (groups.length === 0) return null;
  const checked = groups.filter(g => g.checked);
  const metCount = checked.reduce((n, g) => n + g.metCount, 0);
  const total = checked.reduce((n, g) => n + (g.total ?? 0), 0);
  return {
    groups,
    metCount,
    total,
    summary: checked.length === 0 ? 'Not checked' : `${metCount} of ${total} met`,
    allMet: checked.length === groups.length && groups.every(g => g.allMet),
  };
}
