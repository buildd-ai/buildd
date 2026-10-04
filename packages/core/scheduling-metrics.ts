/**
 * §6 scheduling metrics (knowledge-base: buildd/design/jev-scheduling.md §6).
 *
 * Per workspace and ISO week, compares `apply`/`record` weeks against a
 * rule-only (`off`) baseline on the primary metrics (claim-loop deferrals per
 * claimed task, stranded tasks, time-to-merge, conflict tasks per merged PR)
 * and the guardrails (unsafe co-schedule rate, idle capacity while claimable
 * work existed, silent completions, supersession cancels later reverted by a
 * human). `record`-mode weeks additionally report plan-vs-actual divergence.
 *
 * Pure: every input row here is already grouped and counted by the loader
 * (./orchestration-readout-source.ts) from `gate_events`, `tasks` and
 * `workers`. This module does rate/percentile math and the baseline
 * comparison only — nothing here reads a path, a title or an id, and nothing
 * here does I/O.
 *
 * Provider capacity is read off the SAME claim-plan samples the primary idle-
 * capacity guardrail uses, sliced by `ClaimPlanSample.backend`, rather than a
 * second capacity model: Codex is intentionally single-flight (≤1 active
 * worker per workspace), so its own slice never reads as 9 idle Claude-shaped
 * slots. `codex_single_flight` deferrals are reported distinctly from the
 * three primary reasons, never folded into the per-claim rate.
 */
import { percentile } from '@builddai/ai-kit/decide';

export type SchedulingPlannerMode = 'off' | 'record' | 'apply';
export type AgentBackend = 'claude' | 'codex';

/** A rate with its sample size, so a readout can tell "0%" from "no data". */
export interface Rate {
  value: number | null;
  sampleCount: number;
}

export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function rateOf(numerator: number, denominator: number): Rate {
  return { value: rate(numerator, denominator), sampleCount: denominator };
}

// ── ISO week bucketing ──────────────────────────────────────────────────────

/** Monday 00:00 UTC of `d`'s ISO week — the bucket key every row is grouped by. */
export function isoWeekStart(d: Date): Date {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const isoDay = utc.getUTCDay() || 7; // Mon=1 .. Sun=7
  utc.setUTCDate(utc.getUTCDate() - isoDay + 1);
  return utc;
}

/** `YYYY-MM-DD` of the week's Monday — a stable, sortable bucket identifier. */
export function weekKey(d: Date): string {
  return isoWeekStart(d).toISOString().slice(0, 10);
}

/** `YYYY-Www` display label for a week-start date, per ISO 8601 week numbering. */
export function isoWeekLabel(weekStart: Date): string {
  const thursday = new Date(weekStart.getTime());
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 1));
  const firstDay = firstThursday.getUTCDay() || 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() + (firstDay <= 4 ? 1 - firstDay : 8 - firstDay));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ── Raw weekly input (already aggregated by the loader) ────────────────────

export interface DeferralReasonCounts {
  path_overlap: number;
  advisory_manifest: number;
  ordered_behind: number;
  /** Reported distinctly — never folded into the primary per-claim rate. */
  codex_single_flight: number;
}

/**
 * One claim-batch planner record (`claim_plan` gate_events row, recorded in
 * both `record` and `apply` mode). `backend` is the effective backend shared
 * by every candidate the plan considered, or `'mixed'` when they differed —
 * a mixed sample is excluded from the per-backend split but still counts
 * toward the overall idle-capacity guardrail.
 */
export interface ClaimPlanSample {
  mode: Exclude<SchedulingPlannerMode, 'off'>;
  backend: AgentBackend | 'mixed';
  /** Whether the rule's actual picks matched the plan's picks exactly. */
  agree: boolean;
  candidateCount: number;
  pickedCount: number;
  /** Null when the recording predates capacity being carried on the row. */
  capacity: number | null;
}

/** A labelled would-be pick, when a stored overlap/touch-label answer exists for it. */
export interface PlannerWouldBePickLabel {
  unsafe: boolean;
}

export interface WeeklySchedulingRawInput {
  workspaceId: string;
  weekStart: Date;
  mode: SchedulingPlannerMode;
  deferrals: DeferralReasonCounts;
  claimedTaskCount: number;
  strandedCount: number;
  /** ms from created to merged, one entry per editing task merged this week. */
  mergeLatenciesMs: number[];
  /** Tasks created this week with creationSource = 'conflict'. */
  conflictTaskCount: number;
  /** PRs merged this week (denominator for conflict tasks per merged PR). */
  mergedPrCount: number;
  /** Two co-running tasks whose touch labels overlapped. */
  unsafeCoScheduleCount: number;
  /** Total sampled co-running task pairs (denominator for the above). */
  coScheduleSampleCount: number;
  silentCompletionCount: number;
  /** Tasks cancelled by the supersession reconciler this week. */
  supersessionCancelCount: number;
  /** Of those, how many a human later un-cancelled. */
  supersessionRevertedCount: number;
  claimPlans: ClaimPlanSample[];
  /** Would-be-pick labels where a stored overlap/touch-label answer exists. */
  plannerWouldBePickLabels: PlannerWouldBePickLabel[];
}

// ── Per-week derived metrics ────────────────────────────────────────────────

export interface PrimaryWeekMetrics {
  deferralsPerClaimedTask: Rate;
  strandedCount: number;
  timeToMergeMs: { p50: number | null; p90: number | null };
  conflictTasksPerMergedPr: Rate;
}

export interface GuardrailWeekMetrics {
  unsafeCoScheduleRate: Rate;
  /** From the recorded plans: capacity known, unused, while candidates remained unpicked. */
  idleCapacityWhileClaimableRate: Rate;
  silentCompletionCount: number;
  supersessionCancelCount: number;
  supersessionRevertedCount: number;
  supersessionRevertedRate: Rate;
}

export interface ProviderCapacityWeekMetrics {
  codexSingleFlightDeferrals: number;
  /** Same claim-plan samples as the guardrail above, sliced by effective backend. */
  idleCapacityByBackend: Record<AgentBackend, Rate>;
}

export type PlannerGuardrailVerdict =
  | { status: 'insufficient_n' }
  | { status: 'observed'; unsafeCoScheduleRate: number; sampleCount: number };

export interface RecordOnlyWeekMetrics {
  /** Share of record-mode plans whose picks did not match the rule's actual picks. */
  planDivergenceRate: Rate;
  /** Guardrail values on the planner's would-be picks, only where labels exist. */
  plannerWouldBePickGuardrail: PlannerGuardrailVerdict;
}

export interface WeekMetrics {
  primary: PrimaryWeekMetrics;
  guardrails: GuardrailWeekMetrics;
  providerCapacity: ProviderCapacityWeekMetrics;
  /** Non-null only for `mode: 'record'` weeks. */
  recordOnly: RecordOnlyWeekMetrics | null;
}

function idleCapacitySamples(plans: readonly ClaimPlanSample[]): ClaimPlanSample[] {
  return plans.filter(p => p.capacity !== null);
}

/** Capacity unused AND claimable work remained — not simply "capacity > picked". */
function isIdleWhileClaimable(p: ClaimPlanSample): boolean {
  return p.capacity !== null && p.pickedCount < p.capacity && p.candidateCount > p.pickedCount;
}

function idleCapacityRate(plans: readonly ClaimPlanSample[]): Rate {
  const withCapacity = idleCapacitySamples(plans);
  return rateOf(withCapacity.filter(isIdleWhileClaimable).length, withCapacity.length);
}

function idleCapacityByBackend(plans: readonly ClaimPlanSample[]): Record<AgentBackend, Rate> {
  const of = (backend: AgentBackend) => idleCapacityRate(plans.filter(p => p.backend === backend));
  return { claude: of('claude'), codex: of('codex') };
}

export function buildWeekMetrics(w: WeeklySchedulingRawInput): WeekMetrics {
  const primaryDeferrals = w.deferrals.path_overlap + w.deferrals.advisory_manifest + w.deferrals.ordered_behind;

  const primary: PrimaryWeekMetrics = {
    deferralsPerClaimedTask: rateOf(primaryDeferrals, w.claimedTaskCount),
    strandedCount: w.strandedCount,
    timeToMergeMs: {
      p50: w.mergeLatenciesMs.length ? percentile(w.mergeLatenciesMs, 50) : null,
      p90: w.mergeLatenciesMs.length ? percentile(w.mergeLatenciesMs, 90) : null,
    },
    conflictTasksPerMergedPr: rateOf(w.conflictTaskCount, w.mergedPrCount),
  };

  const guardrails: GuardrailWeekMetrics = {
    unsafeCoScheduleRate: rateOf(w.unsafeCoScheduleCount, w.coScheduleSampleCount),
    idleCapacityWhileClaimableRate: idleCapacityRate(w.claimPlans),
    silentCompletionCount: w.silentCompletionCount,
    supersessionCancelCount: w.supersessionCancelCount,
    supersessionRevertedCount: w.supersessionRevertedCount,
    supersessionRevertedRate: rateOf(w.supersessionRevertedCount, w.supersessionCancelCount),
  };

  const providerCapacity: ProviderCapacityWeekMetrics = {
    codexSingleFlightDeferrals: w.deferrals.codex_single_flight,
    idleCapacityByBackend: idleCapacityByBackend(w.claimPlans),
  };

  let recordOnly: RecordOnlyWeekMetrics | null = null;
  if (w.mode === 'record') {
    const recordPlans = w.claimPlans.filter(p => p.mode === 'record');
    const labels = w.plannerWouldBePickLabels;
    recordOnly = {
      planDivergenceRate: rateOf(recordPlans.filter(p => !p.agree).length, recordPlans.length),
      plannerWouldBePickGuardrail: labels.length === 0
        ? { status: 'insufficient_n' }
        : { status: 'observed', unsafeCoScheduleRate: labels.filter(l => l.unsafe).length / labels.length, sampleCount: labels.length },
    };
  }

  return { primary, guardrails, providerCapacity, recordOnly };
}

// ── Whole readout: group by workspace/week, compare against the off baseline ─

export interface BaselineComparison {
  baseline: number;
  treatment: number;
  delta: number;
}

export interface WeekReadoutRow {
  weekKey: string;
  weekLabel: string;
  mode: SchedulingPlannerMode;
  metrics: WeekMetrics;
  /** Null for `off` weeks, and for any week whose workspace has no `off` week in the window. */
  vsBaseline: {
    deferralsPerClaimedTask: BaselineComparison | null;
    strandedCount: BaselineComparison | null;
    timeToMergeP50Ms: BaselineComparison | null;
    timeToMergeP90Ms: BaselineComparison | null;
    conflictTasksPerMergedPr: BaselineComparison | null;
    unsafeCoScheduleRate: BaselineComparison | null;
    idleCapacityWhileClaimableRate: BaselineComparison | null;
  } | null;
}

export interface WorkspaceSchedulingReadout {
  workspaceId: string;
  weeks: WeekReadoutRow[];
}

export interface SchedulingMetricsReadout {
  workspaces: WorkspaceSchedulingReadout[];
}

/** Pools raw weekly rows (sums counts, concatenates latency/plan samples) into one baseline week. */
function poolBaseline(rows: readonly WeeklySchedulingRawInput[]): WeeklySchedulingRawInput | null {
  if (rows.length === 0) return null;
  return rows.reduce<WeeklySchedulingRawInput>((acc, r) => ({
    ...acc,
    deferrals: {
      path_overlap: acc.deferrals.path_overlap + r.deferrals.path_overlap,
      advisory_manifest: acc.deferrals.advisory_manifest + r.deferrals.advisory_manifest,
      ordered_behind: acc.deferrals.ordered_behind + r.deferrals.ordered_behind,
      codex_single_flight: acc.deferrals.codex_single_flight + r.deferrals.codex_single_flight,
    },
    claimedTaskCount: acc.claimedTaskCount + r.claimedTaskCount,
    strandedCount: acc.strandedCount + r.strandedCount,
    mergeLatenciesMs: [...acc.mergeLatenciesMs, ...r.mergeLatenciesMs],
    conflictTaskCount: acc.conflictTaskCount + r.conflictTaskCount,
    mergedPrCount: acc.mergedPrCount + r.mergedPrCount,
    unsafeCoScheduleCount: acc.unsafeCoScheduleCount + r.unsafeCoScheduleCount,
    coScheduleSampleCount: acc.coScheduleSampleCount + r.coScheduleSampleCount,
    silentCompletionCount: acc.silentCompletionCount + r.silentCompletionCount,
    supersessionCancelCount: acc.supersessionCancelCount + r.supersessionCancelCount,
    supersessionRevertedCount: acc.supersessionRevertedCount + r.supersessionRevertedCount,
    claimPlans: [...acc.claimPlans, ...r.claimPlans],
    plannerWouldBePickLabels: [...acc.plannerWouldBePickLabels, ...r.plannerWouldBePickLabels],
  }), {
    workspaceId: rows[0].workspaceId,
    weekStart: rows[0].weekStart,
    mode: 'off',
    deferrals: { path_overlap: 0, advisory_manifest: 0, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 0,
    strandedCount: 0,
    mergeLatenciesMs: [],
    conflictTaskCount: 0,
    mergedPrCount: 0,
    unsafeCoScheduleCount: 0,
    coScheduleSampleCount: 0,
    silentCompletionCount: 0,
    supersessionCancelCount: 0,
    supersessionRevertedCount: 0,
    claimPlans: [],
    plannerWouldBePickLabels: [],
  });
}

function comparison(baseline: number | null, treatment: number | null): BaselineComparison | null {
  if (baseline === null || treatment === null) return null;
  return { baseline, treatment, delta: treatment - baseline };
}

export function buildSchedulingMetricsReadout(rows: readonly WeeklySchedulingRawInput[]): SchedulingMetricsReadout {
  const byWorkspace = new Map<string, WeeklySchedulingRawInput[]>();
  for (const r of rows) byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), r]);

  const workspaces: WorkspaceSchedulingReadout[] = [];
  for (const [workspaceId, wsRows] of byWorkspace) {
    const baselineRow = poolBaseline(wsRows.filter(r => r.mode === 'off'));
    const baselineMetrics = baselineRow ? buildWeekMetrics(baselineRow) : null;

    const weeks: WeekReadoutRow[] = wsRows
      .slice()
      .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
      .map(r => {
        const metrics = buildWeekMetrics(r);
        const vsBaseline = r.mode === 'off' || !baselineMetrics ? null : {
          deferralsPerClaimedTask: comparison(baselineMetrics.primary.deferralsPerClaimedTask.value, metrics.primary.deferralsPerClaimedTask.value),
          strandedCount: comparison(baselineMetrics.primary.strandedCount, metrics.primary.strandedCount),
          timeToMergeP50Ms: comparison(baselineMetrics.primary.timeToMergeMs.p50, metrics.primary.timeToMergeMs.p50),
          timeToMergeP90Ms: comparison(baselineMetrics.primary.timeToMergeMs.p90, metrics.primary.timeToMergeMs.p90),
          conflictTasksPerMergedPr: comparison(baselineMetrics.primary.conflictTasksPerMergedPr.value, metrics.primary.conflictTasksPerMergedPr.value),
          unsafeCoScheduleRate: comparison(baselineMetrics.guardrails.unsafeCoScheduleRate.value, metrics.guardrails.unsafeCoScheduleRate.value),
          idleCapacityWhileClaimableRate: comparison(baselineMetrics.guardrails.idleCapacityWhileClaimableRate.value, metrics.guardrails.idleCapacityWhileClaimableRate.value),
        };
        return { weekKey: weekKey(r.weekStart), weekLabel: isoWeekLabel(r.weekStart), mode: r.mode, metrics, vsBaseline };
      });

    workspaces.push({ workspaceId, weeks });
  }

  return { workspaces };
}
