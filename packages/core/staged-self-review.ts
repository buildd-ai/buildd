/**
 * Staged self-review before complete_task: the shared half (Living Spec
 * f3742450). Pure functions: mode switch, arm draw, rubber-stamp readout and
 * the pre-registered kill criterion. Off means no footprint (AC-9).
 */
import { assignExperimentArm } from './experiment-randomizer';

export const STAGED_SELF_REVIEW_FEATURE = 'staged_self_review';

export type StagedReviewMode = 'off' | 'recording' | 'acting';
export type StagedReviewArm = 'control' | 'treatment';

export interface StagedReviewRow {
  mode?: string | null;
  /** Acting rows are pinned to the checklist version they were approved on. */
  checklistVersion?: string | null;
}

/** No stored row = off. Acting pinned to another checklist version = recording. */
export function resolveStagedReviewMode(
  row: StagedReviewRow | null | undefined,
  current?: { checklistVersion?: string | null },
): StagedReviewMode {
  if (!row) return 'off';
  if (row.mode === 'recording') return 'recording';
  if (row.mode === 'acting') {
    if (row.checklistVersion && current?.checklistVersion && row.checklistVersion !== current.checklistVersion) return 'recording';
    return 'acting';
  }
  return 'off';
}

export interface StagedExperimentRef {
  id: string;
  policyVersion: string | number;
  treatmentFraction: unknown;
}

/** Per-task arm draw with the shared randomiser; propensity recorded. */
export function assignStagedReviewArm(args: { taskId: string; experiment: StagedExperimentRef }) {
  return assignExperimentArm<StagedReviewArm>({
    experimentId: args.experiment.id,
    policyVersion: String(args.experiment.policyVersion),
    controlArm: 'control',
    treatmentArm: 'treatment',
    unitId: args.taskId,
    fraction: args.experiment.treatmentFraction,
  });
}

export interface StagedAssignmentRow {
  experimentId: string;
  taskId: string;
  unitType: 'task';
  unitId: string;
  arm: StagedReviewArm;
  propensity: number;
  policyVersion: number;
  served: boolean;
}

/**
 * The assignment row the server records for one staged draw. Mirrors the
 * runner's resolveStagedConfig (same mode, same draw inputs), so the recorded
 * arm is the arm the runner acts on. Null unless acting with a registered
 * experiment: recording and off never write a row, so the treatment arm holds
 * only tasks where the stage could act.
 */
export function stagedAssignmentRow(
  taskId: string,
  gitConfig: { selfReview?: unknown; selfReviewExperiment?: any } | null | undefined,
): StagedAssignmentRow | null {
  const exp = gitConfig?.selfReviewExperiment;
  if (!exp?.id || !taskId) return null;
  const mode = resolveStagedReviewMode(
    gitConfig?.selfReview === 'acting' || gitConfig?.selfReview === 'recording'
      ? { mode: String(gitConfig.selfReview), checklistVersion: exp.checklistVersion }
      : null,
    { checklistVersion: undefined },
  );
  if (mode !== 'acting') return null;
  const policyVersion = Number(exp.policyVersion ?? 1);
  const drawn = assignStagedReviewArm({
    taskId,
    experiment: { id: String(exp.id), policyVersion, treatmentFraction: exp.treatmentFraction },
  });
  const arm = effectiveStagedArm({ mode, arm: drawn.arm });
  return {
    experimentId: String(exp.id),
    taskId,
    unitType: 'task',
    unitId: taskId,
    arm,
    propensity: drawn.propensity,
    policyVersion,
    served: arm === 'treatment',
  };
}

/** Only acting mode lets the treatment arm act; otherwise the task sees no stage. */
export function effectiveStagedArm(args: { mode: StagedReviewMode; arm: StagedReviewArm }): StagedReviewArm {
  return args.mode === 'acting' && args.arm === 'treatment' ? 'treatment' : 'control';
}

export interface StagedReviewRecord {
  taskId?: string;
  toolCallsBetween: string[];
  changedAfterDenial: boolean;
  answers: string[];
  evidenceEchoesSummary?: boolean;
  laterIntentFinding?: boolean;
}

export interface StagedReviewReadout {
  /** Share answered without any tool call in between: the checklist was not touched. */
  touchRate: number;
  /** Share where the stage changed something: work changed, or an answer was not "met". */
  flipRate: number;
  /** Share of all-"met" answers later contradicted by a reviewer intent finding. */
  contradictionRate: number;
  rubberStamped: boolean;
  n: number;
}

export const RUBBER_STAMP_TOUCH_RATE = 0.8;
export const RUBBER_STAMP_FLIP_RATE = 0.05;

export function classifyStagedReview(
  rows: readonly StagedReviewRecord[],
  limits: { touchRate?: number; flipRate?: number } = {},
): StagedReviewReadout {
  const n = rows.length;
  if (n === 0) return { touchRate: 0, flipRate: 0, contradictionRate: 0, rubberStamped: false, n: 0 };
  const untouched = rows.filter(r => r.toolCallsBetween.length === 0 && !r.changedAfterDenial).length;
  const flipped = rows.filter(r => r.changedAfterDenial || r.answers.some(a => a !== 'met')).length;
  const contradicted = rows.filter(r => r.laterIntentFinding && r.answers.every(a => a === 'met')).length;
  const touchRate = untouched / n;
  const flipRate = flipped / n;
  return {
    touchRate,
    flipRate,
    contradictionRate: contradicted / n,
    rubberStamped: touchRate >= (limits.touchRate ?? RUBBER_STAMP_TOUCH_RATE) && flipRate <= (limits.flipRate ?? RUBBER_STAMP_FLIP_RATE),
    n,
  };
}

export interface KillCriterion {
  minSample: number;
  maxAddedCostPerTask: number;
  rubberStampTouchRate: number;
  rubberStampFlipRate: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** An experiment cannot start without its kill criterion stored up front. */
export function validateStagedExperimentConfig(config: Record<string, unknown> | null | undefined): { ok: boolean; error?: string } {
  const k = config?.killCriterion as Partial<KillCriterion> | undefined;
  if (!k || typeof k !== 'object') return { ok: false, error: 'killCriterion is required before a staged_self_review experiment can start' };
  for (const f of ['minSample', 'maxAddedCostPerTask', 'rubberStampTouchRate', 'rubberStampFlipRate'] as const) {
    if (!isNum(k[f])) return { ok: false, error: `killCriterion.${f} must be a number` };
  }
  return { ok: true };
}

/** Meeting any limb means switch off. There is no "tune the checklist" outcome. */
export function evaluateKillCriterion(args: {
  readout: { verdict?: string; touchRate?: number; flipRate?: number };
  criterion: KillCriterion;
  measuredAddedCost: number;
}): { kill: boolean; action: 'switch_off' | 'continue'; reasons: string[] } {
  const { readout, criterion, measuredAddedCost } = args;
  const reasons: string[] = [];
  if (readout.verdict === 'no_detectable_difference') reasons.push('no detectable difference against control');
  if (isNum(readout.touchRate) && isNum(readout.flipRate)
    && readout.touchRate >= criterion.rubberStampTouchRate && readout.flipRate <= criterion.rubberStampFlipRate) {
    reasons.push('rubber-stamped: agents answer without touching the work');
  }
  if (measuredAddedCost > criterion.maxAddedCostPerTask) reasons.push('added cost per task exceeds the pre-registered limit');
  const kill = reasons.length > 0;
  return { kill, action: kill ? 'switch_off' : 'continue', reasons };
}

/** Off creates nothing: no arm draw, no state, no log row. */
export function stagedReviewFootprint<T>(
  mode: StagedReviewMode,
  deps: { draw: () => T; record?: (entry: unknown) => void; initState?: () => void },
): T | null {
  if (mode === 'off') return null;
  deps.initState?.();
  return deps.draw();
}

const SELF_REVIEW_PREFIX = 'Self-review: {';

/**
 * Stored records -> readout input. The runner writes each stage outcome as a
 * `Self-review: {json}` status milestone; only `answered` entries carry a
 * checklist answer. Labels with the prefix that do not parse (e.g. truncated) are
 * counted in `skipped`; labels without the prefix are ignored.
 */
export function stagedReviewRecordsFromMilestones(
  workersRows: readonly { taskId?: string | null; milestones?: unknown }[],
): { records: StagedReviewRecord[]; skipped: number } {
  const records: StagedReviewRecord[] = [];
  let skipped = 0;
  for (const w of workersRows) {
    if (!Array.isArray(w.milestones)) continue;
    for (const m of w.milestones as { label?: unknown }[]) {
      const text = typeof m?.label === 'string' ? m.label : '';
      if (!text.startsWith(SELF_REVIEW_PREFIX)) continue;
      try {
        // Runner caps labels at 300 chars, so long records arrive truncated and fail here: counted as skipped.
        const e = JSON.parse(text.slice('Self-review: '.length)) as Record<string, unknown>;
        if (e.outcome !== 'answered') continue;
        const answers = Array.isArray(e.answers)
          ? e.answers.map(a => String((a as { answer?: unknown })?.answer ?? 'unanswered'))
          : ['unanswered'];
        records.push({
          taskId: w.taskId ?? undefined,
          toolCallsBetween: Array.isArray(e.toolCallsBetween) ? e.toolCallsBetween.map(String) : [],
          changedAfterDenial: e.workChangedAfterDenial === true,
          answers,
        });
      } catch { skipped++; }
    }
  }
  return { records, skipped };
}

/**
 * Stored records from `workers.resultMeta.stagedSelfReview` (full structured
 * entries the runner persists). Workers without that array fall back to the
 * legacy JSON milestone labels. Only `answered` entries become records.
 */
export function stagedReviewRecordsFromWorkers(
  workersRows: readonly { taskId?: string | null; milestones?: unknown; resultMeta?: unknown }[],
): { records: StagedReviewRecord[]; skipped: number } {
  const records: StagedReviewRecord[] = [];
  let skipped = 0;
  const legacy: { taskId?: string | null; milestones?: unknown }[] = [];
  for (const w of workersRows) {
    const entries = (w.resultMeta as { stagedSelfReview?: unknown } | null | undefined)?.stagedSelfReview;
    if (!Array.isArray(entries)) { legacy.push(w); continue; }
    for (const raw of entries) {
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e !== 'object') { skipped++; continue; }
      if (e.outcome !== 'answered') continue;
      records.push({
        taskId: w.taskId ?? undefined,
        toolCallsBetween: Array.isArray(e.toolCallsBetween) ? e.toolCallsBetween.map(String) : [],
        changedAfterDenial: e.workChangedAfterDenial === true,
        answers: Array.isArray(e.answers)
          ? e.answers.map(a => String((a as { answer?: unknown })?.answer ?? 'unanswered'))
          : ['unanswered'],
      });
    }
  }
  const old = stagedReviewRecordsFromMilestones(legacy);
  return { records: [...records, ...old.records], skipped: skipped + old.skipped };
}
