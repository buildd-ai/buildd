/**
 * Experiment readout — the pure half. Turns per-task rows into a per-arm
 * comparison with intervals and a verdict. No db, no clock.
 *
 * Analysis rules, each load-bearing:
 *
 * - **Intent-to-treat.** Rows are grouped by the arm that was ASSIGNED, never
 *   by what was served. A treatment task that fell back to the control model
 *   (old runner client) stays in the treatment arm; dropping or moving it
 *   would select on runner age. `servedRate` is reported so the dilution is
 *   visible.
 * - **Attempts are not units.** Rows that inherited their arm (CI retries,
 *   rework) are part of their parent's outcome — the primary metric already
 *   penalises a parent that needed a CI retry — so counting them again would
 *   double-count the failure. They are excluded and reported as a count.
 * - **Unresolved rows are not failures.** A task still running, or completed
 *   with its PR still open, has no outcome yet; it is `pending` and sits out
 *   of the denominator rather than dragging the rate down early.
 * - **"Not enough data" is a verdict**, not an error: below `minSamplePerArm`
 *   resolved rows in either arm the verdict is `insufficient_n` whatever the
 *   point estimates say.
 *
 * Caveat the intervals do not correct for: units are missions when a task has
 * one, so tasks within a mission are correlated and a task-level Wilson
 * interval is narrower than the truth. The per-unit-type strata make that
 * visible; a cluster-robust interval is a follow-up.
 */

export type Arm = 'control' | 'treatment';
export type RowOutcome = 'clean' | 'unclean' | 'pending';

/**
 * Exit causes that describe the platform, not the model. A failure with one
 * of these is excluded from "model-attributable failure". NOTE: `code_failure`
 * is still the classifier's catch-all, so model-attributable failure is an
 * upper bound until that taxonomy is split (follow-up).
 */
export const INFRA_EXIT_CAUSES: ReadonlySet<string> = new Set([
  'budget_limited', 'infra_failure', 'never_started', 'silent_start', 'reassigned',
  'sandbox_mount_gap', 'server_refused', 'needs_input', 'task_cancelled',
]);

/** One enrolled task, with everything the readout needs already joined. */
export interface ReadoutRow {
  taskId: string;
  arm: Arm;
  served: boolean;
  unitType: 'mission' | 'task';
  unitId: string;
  /** True when the arm was inherited from a parent task (an attempt). */
  inherited: boolean;
  kind: string | null;
  taskStatus: string;
  hasPr: boolean;
  prMerged: boolean;
  /** PR closed without merge, or given up on as unresolvable. */
  prAbandoned: boolean;
  ciRetryDispatched: boolean;
  /** Attempt children other than CI retries (reviewer rework, conflict retries). */
  reworkRounds: number;
  /** Reviewer requested changes at least once. */
  reviewerRework: boolean;
  turns: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  exitCause: string | null;
}

/**
 * Clean completion = task completed AND no CI retry dispatched AND (no PR OR
 * PR merged). A completed task whose PR is still open is pending, not unclean.
 */
export function classifyRow(r: Pick<ReadoutRow, 'taskStatus' | 'hasPr' | 'prMerged' | 'prAbandoned' | 'ciRetryDispatched'>): RowOutcome {
  if (r.taskStatus === 'failed') return 'unclean';
  if (r.taskStatus !== 'completed') return 'pending';
  if (r.ciRetryDispatched) return 'unclean';
  if (!r.hasPr) return 'clean';
  if (r.prMerged) return 'clean';
  if (r.prAbandoned) return 'unclean';
  return 'pending';
}

// ── Intervals ───────────────────────────────────────────────────────────────

const Z95 = 1.959963984540054;

export interface Interval { lower: number; upper: number }

/** Wilson score interval for k successes in n trials. n = 0 → [0, 1]. */
export function wilsonInterval(k: number, n: number, z = Z95): Interval {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * Newcombe's hybrid score interval (method 10) for p1 − p2, built from each
 * proportion's Wilson interval. Better behaved than the Wald difference at
 * small n and near 0/1, which is where early readouts live.
 */
export function newcombeInterval(k1: number, n1: number, k2: number, n2: number, z = Z95): Interval & { difference: number } {
  const p1 = n1 > 0 ? k1 / n1 : 0;
  const p2 = n2 > 0 ? k2 / n2 : 0;
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  const d = p1 - p2;
  return {
    difference: d,
    lower: d - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2),
    upper: d + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2),
  };
}

// ── Readout ─────────────────────────────────────────────────────────────────

export interface ArmSummary {
  /** Assigned, non-inherited rows. */
  assigned: number;
  /** Rows with an outcome (clean or unclean) — the primary denominator. */
  n: number;
  pending: number;
  clean: number;
  cleanRate: number | null;
  cleanInterval: Interval;
  /** Share of assigned rows whose arm model actually ran. */
  servedRate: number | null;
  secondary: {
    /** Share of resolved rows with no reviewer-requested rework. */
    firstPassReviewRate: number | null;
    meanReworkRounds: number | null;
    meanTurns: number | null;
    meanTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    /** Failed rows whose exit cause is not an infra class, over resolved rows. */
    modelAttributableFailureRate: number | null;
  };
}

export type ReadoutVerdict = 'insufficient_n' | 'no_detectable_difference' | 'treatment_better' | 'treatment_worse';

export interface StratumReadout {
  control: Pick<ArmSummary, 'n' | 'clean' | 'cleanRate' | 'cleanInterval'>;
  treatment: Pick<ArmSummary, 'n' | 'clean' | 'cleanRate' | 'cleanInterval'>;
  difference: (Interval & { difference: number }) | null;
}

export interface ExperimentReadout {
  minSamplePerArm: number;
  control: ArmSummary;
  treatment: ArmSummary;
  /** treatment − control clean-completion rate, Newcombe 95%. Null when either arm has n = 0. */
  difference: (Interval & { difference: number }) | null;
  verdict: ReadoutVerdict;
  /** Inherited (attempt) rows excluded from the unit count. */
  inheritedExcluded: number;
  strata: {
    unitType: Record<'mission' | 'task', StratumReadout>;
    kind: Record<'stated' | 'unstated', StratumReadout>;
  };
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function summariseArm(rows: ReadoutRow[]): ArmSummary {
  const outcomes = rows.map(r => ({ r, o: classifyRow(r) }));
  const resolved = outcomes.filter(x => x.o !== 'pending');
  const clean = resolved.filter(x => x.o === 'clean').length;
  const n = resolved.length;

  const withTokens = rows.map(r => r.tokens).filter((t): t is NonNullable<ReadoutRow['tokens']> => t !== null);
  const meanTokens = withTokens.length
    ? {
        input: mean(withTokens.map(t => t.input))!,
        output: mean(withTokens.map(t => t.output))!,
        cacheRead: mean(withTokens.map(t => t.cacheRead))!,
        cacheWrite: mean(withTokens.map(t => t.cacheWrite))!,
      }
    : null;

  const attributable = resolved.filter(x =>
    x.r.taskStatus === 'failed'
    && !(x.r.exitCause && INFRA_EXIT_CAUSES.has(x.r.exitCause)),
  ).length;

  return {
    assigned: rows.length,
    n,
    pending: rows.length - n,
    clean,
    cleanRate: n ? clean / n : null,
    cleanInterval: wilsonInterval(clean, n),
    servedRate: rows.length ? rows.filter(r => r.served).length / rows.length : null,
    secondary: {
      firstPassReviewRate: n ? resolved.filter(x => !x.r.reviewerRework).length / n : null,
      meanReworkRounds: mean(resolved.map(x => x.r.reworkRounds)),
      meanTurns: mean(rows.map(r => r.turns).filter((t): t is number => t !== null)),
      meanTokens,
      modelAttributableFailureRate: n ? attributable / n : null,
    },
  };
}

function stratum(rows: ReadoutRow[]): StratumReadout {
  const pick = (a: ArmSummary) => ({ n: a.n, clean: a.clean, cleanRate: a.cleanRate, cleanInterval: a.cleanInterval });
  const c = summariseArm(rows.filter(r => r.arm === 'control'));
  const t = summariseArm(rows.filter(r => r.arm === 'treatment'));
  return {
    control: pick(c),
    treatment: pick(t),
    difference: c.n && t.n ? newcombeInterval(t.clean, t.n, c.clean, c.n) : null,
  };
}

export function computeExperimentReadout(rows: ReadoutRow[], opts: { minSamplePerArm: number }): ExperimentReadout {
  const units = rows.filter(r => !r.inherited);
  const control = summariseArm(units.filter(r => r.arm === 'control'));
  const treatment = summariseArm(units.filter(r => r.arm === 'treatment'));
  const difference = control.n && treatment.n
    ? newcombeInterval(treatment.clean, treatment.n, control.clean, control.n)
    : null;

  let verdict: ReadoutVerdict;
  if (control.n < opts.minSamplePerArm || treatment.n < opts.minSamplePerArm || !difference) {
    verdict = 'insufficient_n';
  } else if (difference.lower > 0) {
    verdict = 'treatment_better';
  } else if (difference.upper < 0) {
    verdict = 'treatment_worse';
  } else {
    verdict = 'no_detectable_difference';
  }

  return {
    minSamplePerArm: opts.minSamplePerArm,
    control,
    treatment,
    difference,
    verdict,
    inheritedExcluded: rows.length - units.length,
    strata: {
      unitType: {
        mission: stratum(units.filter(r => r.unitType === 'mission')),
        task: stratum(units.filter(r => r.unitType === 'task')),
      },
      kind: {
        stated: stratum(units.filter(r => r.kind !== null)),
        unstated: stratum(units.filter(r => r.kind === null)),
      },
    },
  };
}

// ── Row assembly (pure; the source module feeds it) ─────────────────────────

export interface AssignmentJoinRow {
  taskId: string;
  arm: Arm;
  served: boolean;
  unitType: 'mission' | 'task';
  unitId: string;
  eligibility: unknown;
  kind: string | null;
  taskStatus: string;
}

export interface WorkerFactRow {
  taskId: string | null;
  prUrl: string | null;
  mergedAt: Date | string | null;
  prLifecycleStatus: string | null;
  turns: number | null;
  resultMeta: unknown;
  createdAt: Date | string;
}

export interface AttemptChildRow {
  parentTaskId: string | null;
  ciRetryPrNumber: number | null;
  reviewerRetryPrNumber: number | null;
}

export interface OutcomeFactRow {
  taskId: string;
  exitCause: string | null;
  createdAt: Date | string;
}

function time(v: Date | string): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

function sumModelUsage(resultMeta: unknown): NonNullable<ReadoutRow['tokens']> | null {
  const mu = (resultMeta as { modelUsage?: unknown } | null)?.modelUsage;
  if (!mu || typeof mu !== 'object') return null;
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let any = false;
  for (const u of Object.values(mu as Record<string, Record<string, unknown>>)) {
    if (!u || typeof u !== 'object') continue;
    any = true;
    acc.input += Number(u.inputTokens) || 0;
    acc.output += Number(u.outputTokens) || 0;
    acc.cacheRead += Number(u.cacheReadInputTokens) || 0;
    acc.cacheWrite += Number(u.cacheCreationInputTokens) || 0;
  }
  return any ? acc : null;
}

/**
 * Join the four fetched row sets into ReadoutRows. A task can have several
 * workers (requeues); turns and tokens sum across them, the PR is taken from
 * the newest worker that opened one, and the exit cause from the newest
 * outcome row.
 */
export function assembleReadoutRows(
  assignments: AssignmentJoinRow[],
  workers: WorkerFactRow[],
  children: AttemptChildRow[],
  outcomes: OutcomeFactRow[],
): ReadoutRow[] {
  const workersByTask = new Map<string, WorkerFactRow[]>();
  for (const w of workers) {
    if (!w.taskId) continue;
    const list = workersByTask.get(w.taskId) ?? [];
    list.push(w);
    workersByTask.set(w.taskId, list);
  }
  const childrenByParent = new Map<string, AttemptChildRow[]>();
  for (const c of children) {
    if (!c.parentTaskId) continue;
    const list = childrenByParent.get(c.parentTaskId) ?? [];
    list.push(c);
    childrenByParent.set(c.parentTaskId, list);
  }
  const latestOutcome = new Map<string, OutcomeFactRow>();
  for (const o of outcomes) {
    const prev = latestOutcome.get(o.taskId);
    if (!prev || time(o.createdAt) > time(prev.createdAt)) latestOutcome.set(o.taskId, o);
  }

  return assignments.map(a => {
    const ws = (workersByTask.get(a.taskId) ?? []).slice().sort((x, y) => time(y.createdAt) - time(x.createdAt));
    const prWorker = ws.find(w => !!w.prUrl) ?? null;
    const kids = childrenByParent.get(a.taskId) ?? [];
    const ciRetries = kids.filter(k => k.ciRetryPrNumber !== null).length;

    let turns: number | null = null;
    let tokens: ReadoutRow['tokens'] = null;
    for (const w of ws) {
      if (typeof w.turns === 'number') turns = (turns ?? 0) + w.turns;
      const t = sumModelUsage(w.resultMeta);
      if (t) {
        tokens = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        tokens.input += t.input; tokens.output += t.output;
        tokens.cacheRead += t.cacheRead; tokens.cacheWrite += t.cacheWrite;
      }
    }

    const elig = a.eligibility && typeof a.eligibility === 'object' ? a.eligibility as Record<string, unknown> : {};
    return {
      taskId: a.taskId,
      arm: a.arm,
      served: a.served,
      unitType: a.unitType,
      unitId: a.unitId,
      inherited: typeof elig.inheritedFromTaskId === 'string',
      kind: a.kind,
      taskStatus: a.taskStatus,
      hasPr: prWorker !== null,
      prMerged: prWorker?.mergedAt != null || prWorker?.prLifecycleStatus === 'merged',
      prAbandoned: prWorker !== null && prWorker.mergedAt == null
        && (prWorker.prLifecycleStatus === 'closed' || prWorker.prLifecycleStatus === 'unresolvable'),
      ciRetryDispatched: ciRetries > 0,
      reworkRounds: kids.length - ciRetries,
      reviewerRework: kids.some(k => k.reviewerRetryPrNumber !== null),
      turns,
      tokens,
      exitCause: latestOutcome.get(a.taskId)?.exitCause ?? null,
    };
  });
}
