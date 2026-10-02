/**
 * Hold/start-at-claim readout inputs (knowledge-base: buildd/design/conflict-aware-orchestration.md
 * §5b labelling, §6 evaluation). Pure: the stores are in
 * ./orchestration-claim-source.ts; the outcome join is ./orchestration-outcomes.ts.
 *
 * Two rules shape every number here:
 *
 *  1. **A task the rule held is censored, never safe.** In shadow every
 *     decision is about a task the deterministic rule deferred, so nothing
 *     started at decision time. Its later run (once the holder cleared) says
 *     nothing about what starting *then* would have done. Only an applied
 *     START (the gated cohort, recorded with its propensity) is graded on the
 *     observed outcome: conflict-task creation, collision and merge-base
 *     refusal, separately, and the composite risk.
 *  2. **HOLD-everything must not look good.** Unsafe-start rate sits next to
 *     wait time (first decision to first start), stranded rate (cancelled
 *     while held, or still pending past a threshold) and throughput (starts),
 *     and the censored/missing share is reported, not dropped.
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import type { DecisionOutcomeLabels } from './orchestration-outcomes';

/** A pending task held this long with no start counts as stranded. */
export const CLAIM_HOLD_STRANDED_AFTER_MS = 24 * 60 * 60_000;

export interface ClaimDecisionForReadout {
  id: string;
  taskId: string | null;
  workspaceId: string;
  decisionId: string;
  fingerprint: string;
  candidatePolicyVersion: string;
  model: string | null;
  experimentArm: 'apply' | 'observe';
  propensity: number;
  applied: boolean;
  effective: string | null;
  suggested: string | null;
  status: string;
  reason: string | null;
  createdAt: Date;
}

export interface TaskStartForReadout {
  taskId: string;
  /** A worker for the task was created (the claim happened). */
  startedAt: Date;
}

export interface TaskForReadout {
  id: string;
  status: string;
}

export interface ClaimHoldReadoutInput {
  decisions: ClaimDecisionForReadout[];
  /** `labelDecisionOutcomes` output for the same decisions. */
  labels: DecisionOutcomeLabels[];
  tasks: TaskForReadout[];
  starts: TaskStartForReadout[];
  windowEnd: Date;
  strandedAfterMs?: number;
}

type HeldCensored = { status: 'censored'; reason: 'held_by_rule' | string };
type Missing = { status: 'missing'; reason: string };
type Flag = { status: 'observed'; value: boolean } | HeldCensored | Missing | { status: 'not_applicable'; reason: string };

export interface ClaimHoldDecisionLabel {
  decisionId: string;
  /** A START was applied: the task started because of this decision. */
  startedAtDecision: boolean;
  /** Composite risk of the start this decision made; censored when it made none. */
  startSafety: Flag;
  conflictCreated: Flag;
  collision: Flag;
  mergeBaseRefusal: Flag;
}

const HELD: HeldCensored = { status: 'censored', reason: 'held_by_rule' };

const isAppliedStart = (d: ClaimDecisionForReadout) => d.applied && d.effective === 'START';

function flagOf(part: DecisionOutcomeLabels[keyof Omit<DecisionOutcomeLabels, 'decisionId' | 'task' | 'touched'>]): Flag {
  if (part.status === 'observed') return { status: 'observed', value: part.value };
  return { status: part.status, reason: part.reason } as Flag;
}

export function labelClaimHoldDecisions(input: Pick<ClaimHoldReadoutInput, 'decisions' | 'labels'>): ClaimHoldDecisionLabel[] {
  const byId = new Map(input.labels.map(l => [l.decisionId, l]));
  return input.decisions.map((d) => {
    if (!isAppliedStart(d)) {
      return { decisionId: d.id, startedAtDecision: false, startSafety: HELD, conflictCreated: HELD, collision: HELD, mergeBaseRefusal: HELD };
    }
    const l = byId.get(d.id);
    if (!l) {
      const m: Missing = { status: 'missing', reason: 'no_label' };
      return { decisionId: d.id, startedAtDecision: true, startSafety: m, conflictCreated: m, collision: m, mergeBaseRefusal: m };
    }
    return {
      decisionId: d.id,
      startedAtDecision: true,
      startSafety: flagOf(l.risk),
      conflictCreated: flagOf(l.conflictCreated),
      collision: flagOf(l.collision),
      mergeBaseRefusal: flagOf(l.mergeBaseRefusal),
    };
  });
}

export interface ClaimHoldGroupSummary {
  decisionId: string;
  fingerprint: string;
  candidatePolicyVersion: string;
  model: string | null;
  experimentArm: 'apply' | 'observe';
  decisions: number;
  tasks: number;
  suggestions: { HOLD: number; START: number; none: number };
  appliedStarts: number;
  meanPropensity: number | null;
  startSafety: { observedUnsafe: number; observedSafe: number; censored: number; missing: number };
  /** observedUnsafe / (observedUnsafe + observedSafe); null with no observed start. */
  unsafeStartRate: number | null;
  /** Observed bad outcomes among applied starts, each label on its own. */
  separate: { conflictCreated: number; collision: number; mergeBaseRefusal: number };
  /** Per task: first decision to first start at or after it. */
  wait: { n: number; p50Ms: number | null; p90Ms: number | null };
  /** Per task: stranded = cancelled while never started, or pending past the threshold. */
  stranded: { stranded: number; resolved: number; censored: number; rate: number | null };
  throughput: { starts: number; perDay: number | null };
  censoredShare: number;
  missingShare: number;
}

const quantile = (sorted: number[], q: number): number | null => {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
};

const TERMINAL: ReadonlySet<string> = new Set<string>(TERMINAL_TASK_STATUSES);

export function summarizeClaimHoldReadout(input: ClaimHoldReadoutInput): ClaimHoldGroupSummary[] {
  const strandedAfter = input.strandedAfterMs ?? CLAIM_HOLD_STRANDED_AFTER_MS;
  const labels = new Map(labelClaimHoldDecisions(input).map(l => [l.decisionId, l]));
  const taskStatus = new Map(input.tasks.map(t => [t.id, t.status]));
  const startsByTask = new Map<string, Date[]>();
  for (const s of input.starts) {
    const list = startsByTask.get(s.taskId) ?? [];
    list.push(s.startedAt);
    startsByTask.set(s.taskId, list);
  }

  const groups = new Map<string, ClaimDecisionForReadout[]>();
  for (const d of input.decisions) {
    const key = [d.decisionId, d.fingerprint, d.candidatePolicyVersion, d.model ?? '', d.experimentArm].join('\u0000');
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }

  const out: ClaimHoldGroupSummary[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const suggestions = { HOLD: 0, START: 0, none: 0 };
    const safety = { observedUnsafe: 0, observedSafe: 0, censored: 0, missing: 0 };
    const separate = { conflictCreated: 0, collision: 0, mergeBaseRefusal: 0 };
    let appliedStarts = 0;
    let propensitySum = 0;
    for (const d of rows) {
      if (d.suggested === 'HOLD' || d.suggested === 'START') suggestions[d.suggested]++;
      else suggestions.none++;
      propensitySum += d.propensity;
      const l = labels.get(d.id)!;
      if (l.startedAtDecision) appliedStarts++;
      const s = l.startSafety;
      if (s.status === 'observed') s.value ? safety.observedUnsafe++ : safety.observedSafe++;
      else if (s.status === 'missing') safety.missing++;
      else safety.censored++;
      if (l.conflictCreated.status === 'observed' && l.conflictCreated.value) separate.conflictCreated++;
      if (l.collision.status === 'observed' && l.collision.value) separate.collision++;
      if (l.mergeBaseRefusal.status === 'observed' && l.mergeBaseRefusal.value) separate.mergeBaseRefusal++;
    }

    // Per task: the first decision in this group is when it started waiting.
    const firstByTask = new Map<string, Date>();
    for (const d of rows) {
      if (!d.taskId) continue;
      const prev = firstByTask.get(d.taskId);
      if (!prev || d.createdAt < prev) firstByTask.set(d.taskId, d.createdAt);
    }
    const waits: number[] = [];
    const stranded = { stranded: 0, resolved: 0, censored: 0 };
    let starts = 0;
    let earliest = Infinity;
    for (const [taskId, since] of firstByTask) {
      earliest = Math.min(earliest, since.getTime());
      const start = (startsByTask.get(taskId) ?? [])
        .filter(s => s.getTime() >= since.getTime())
        .sort((a, b) => a.getTime() - b.getTime())[0];
      if (start) {
        starts++;
        waits.push(start.getTime() - since.getTime());
        stranded.resolved++;
        continue;
      }
      const status = taskStatus.get(taskId);
      if (status === 'cancelled') stranded.stranded++;
      else if (status && TERMINAL.has(status)) stranded.resolved++;
      else if (input.windowEnd.getTime() - since.getTime() >= strandedAfter) stranded.stranded++;
      else stranded.censored++;
    }
    waits.sort((a, b) => a - b);
    const known = stranded.stranded + stranded.resolved;
    const observedStarts = safety.observedUnsafe + safety.observedSafe;
    const spanDays = Number.isFinite(earliest) ? (input.windowEnd.getTime() - earliest) / 86_400_000 : 0;

    out.push({
      decisionId: first.decisionId,
      fingerprint: first.fingerprint,
      candidatePolicyVersion: first.candidatePolicyVersion,
      model: first.model,
      experimentArm: first.experimentArm,
      decisions: rows.length,
      tasks: firstByTask.size,
      suggestions,
      appliedStarts,
      meanPropensity: rows.length ? propensitySum / rows.length : null,
      startSafety: safety,
      unsafeStartRate: observedStarts > 0 ? safety.observedUnsafe / observedStarts : null,
      separate,
      wait: { n: waits.length, p50Ms: quantile(waits, 0.5), p90Ms: quantile(waits, 0.9) },
      stranded: { ...stranded, rate: known > 0 ? stranded.stranded / known : null },
      throughput: { starts, perDay: spanDays > 0 ? starts / spanDays : null },
      censoredShare: rows.length ? safety.censored / rows.length : 0,
      missingShare: rows.length ? safety.missing / rows.length : 0,
    });
  }
  return out;
}
