/**
 * CBM aggregation shared by /api/cbm/metrics and the health page.
 *
 * This logic used to live only in the route handler, which had one reader: nobody.
 * The health page showed CBM as a row in a generic top-tools list, so the numbers
 * that actually matter — is the graph mounted, warm, and *used* — were computed and
 * discarded. Extracted here so the page and the endpoint cannot drift: the route
 * returns `aggregateCbm(...)` verbatim, and the page renders `summarizeCbm(...)` of
 * the same object.
 *
 * The cohort rules are load-bearing and documented at each site below; they were
 * derived from real misreadings (a control group seeded with rows that had CBM the
 * whole time, and an -80% token delta with no mechanism behind it).
 */
import type { CbmMetrics } from '@buildd/core/db/schema';

export interface CbmRow {
  inputTokens: number;
  cbm: CbmMetrics;
}

/**
 * Disable reasons that are decisions, not failures. Excluded from both sides of
 * the fallback rate: no amount of engineering makes a Codex task or a
 * worktree-less run use the graph.
 */
export const BY_DESIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  'codex_task',
  'no_worktree',
  'role_opt_out',
]);

/** Minimum cohort size on BOTH sides before a delta is reported at all. */
export const MIN_COHORT = 5;

export function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Total CBM tool calls recorded for a task. Uses whichever of totalCbmCalls /
 * toolCalls is larger so a row cannot look unused because one of the two was
 * written by an older runner.
 */
export function cbmUsage(cbm: CbmMetrics): number {
  const fromMap = Object.values(cbm.toolCalls ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  return Math.max(fromMap, cbm.totalCbmCalls ?? 0);
}

export function computeDeltaPct(active: number | null, baseline: number | null): number | null {
  if (active === null || baseline === null || baseline === 0) return null;
  return (active - baseline) / baseline;
}

export function aggregateCbm(rows: CbmRow[], windowParam: string, windowStart: Date) {
  const active: CbmRow[] = [];
  const disabled: CbmRow[] = [];
  const activeByOutcome: Record<string, number> = {};

  for (const entry of rows) {
    const cbm = entry.cbm;
    if (cbm.outcome === 'disabled') {
      disabled.push(entry);
    } else {
      active.push(entry);
      const key = cbm.outcome ?? 'unknown';
      activeByOutcome[key] = (activeByOutcome[key] ?? 0) + 1;
    }
  }

  const totalTracked = active.length + disabled.length;
  const fallbackRate = totalTracked > 0 ? disabled.length / totalTracked : null;

  const byDesignSkips: Record<string, number> = {};
  let fallbackCount = 0;
  for (const r of disabled) {
    const reason = r.cbm.disableReason;
    if (reason && BY_DESIGN_SKIP_REASONS.has(reason)) {
      byDesignSkips[reason] = (byDesignSkips[reason] ?? 0) + 1;
    } else {
      fallbackCount++;
    }
  }
  const byDesignSkipCount = disabled.length - fallbackCount;
  const eligibleCount = active.length + fallbackCount;
  const eligibleFallbackRate = eligibleCount > 0 ? fallbackCount / eligibleCount : null;

  let bootstrapOk = 0;
  let bootstrapFailed = 0;
  let bootstrapSkippedWarm = 0;
  let bootstrapUnreported = 0;
  const bootstrapFailReasons: Record<string, number> = {};
  for (const r of active) {
    const result = r.cbm.bootstrapResult;
    if (result === 'ok') bootstrapOk++;
    else if (result === 'skipped_warm') bootstrapSkippedWarm++;
    else if (result === 'failed') {
      bootstrapFailed++;
      const reason = r.cbm.bootstrapFailReason ?? 'unknown';
      bootstrapFailReasons[reason] = (bootstrapFailReasons[reason] ?? 0) + 1;
    } else if (r.cbm.outcome === 'enforced') {
      bootstrapUnreported++;
    }
  }
  // A warm start is not an attempt: nothing was built, so counting it would dilute
  // the failure rate of the tasks that did build an index.
  const bootstrapAttempted = bootstrapOk + bootstrapFailed;
  const indexBuildFailureRate = bootstrapAttempted > 0 ? bootstrapFailed / bootstrapAttempted : null;
  const warmStartRate = active.length > 0 ? bootstrapSkippedWarm / active.length : null;

  const activeInputTokens = active.map(r => r.inputTokens);
  const activeFileAccess = active.map(r => r.cbm.readCount + r.cbm.grepCount + r.cbm.globCount);
  const activeToolBreakdown: Record<string, number[]> = {};
  for (const r of active) {
    for (const [tool, count] of Object.entries(r.cbm.toolCalls)) {
      (activeToolBreakdown[tool] ??= []).push(count);
    }
  }

  const activeWithZeroToolCalls = active.filter(
    r => Object.values(r.cbm.toolCalls ?? {}).reduce((a, b) => a + (b ?? 0), 0) === 0,
  ).length;
  const mechanismObserved = active.length > 0 && activeWithZeroToolCalls < active.length;
  const adoptionRate = active.length > 0
    ? (active.length - activeWithZeroToolCalls) / active.length
    : null;
  const totalGraphCalls = active.reduce((sum, r) => sum + cbmUsage(r.cbm), 0);

  let excludedBinaryAbsent = 0;
  let excludedCbmUsage = 0;
  const comparable = disabled.filter(r => {
    if (r.cbm.disableReason === 'binary_absent') {
      excludedBinaryAbsent++;
      return false;
    }
    if (cbmUsage(r.cbm) > 0) {
      excludedCbmUsage++;
      return false;
    }
    return true;
  });
  const comparableInputTokens = comparable.map(r => r.inputTokens);
  const comparableFileAccess = comparable.map(r => r.cbm.readCount + r.cbm.grepCount + r.cbm.globCount);
  const disabledInputTokens = disabled.map(r => r.inputTokens);
  const disabledFileAccess = disabled.map(r => r.cbm.readCount + r.cbm.grepCount + r.cbm.globCount);

  const cohortsSufficient = active.length >= MIN_COHORT && comparable.length >= MIN_COHORT;

  const disableReasons: Record<string, number> = {};
  for (const r of disabled) {
    const reason = r.cbm.disableReason ?? 'unknown';
    disableReasons[reason] = (disableReasons[reason] ?? 0) + 1;
  }

  return {
    window: windowParam,
    windowStart: windowStart.toISOString(),
    totalTracked,
    fallbackRate,
    eligibleFallbackRate,
    eligibility: { eligibleCount, fallbackCount, byDesignSkipCount, byDesignSkips },
    indexBuild: {
      attempted: bootstrapAttempted,
      ok: bootstrapOk,
      failed: bootstrapFailed,
      failureRate: indexBuildFailureRate,
      /** Tasks that needed no index because a shared seeded cache was already warm. */
      skippedWarm: bootstrapSkippedWarm,
      /** Share of active tasks that started warm — the payoff of the shared cache. */
      warmStartRate,
      unreported: bootstrapUnreported,
      failReasons: bootstrapFailReasons,
    },
    cbmActive: {
      count: active.length,
      byOutcome: activeByOutcome,
      avgInputTokens: avg(activeInputTokens),
      avgFileAccessCalls: avg(activeFileAccess),
      avgToolCalls: Object.fromEntries(
        Object.entries(activeToolBreakdown).map(([tool, counts]) => [tool, avg(counts)]),
      ),
      activeWithZeroToolCalls,
      mechanismObserved,
      /** Share of CBM-mounted tasks that made at least one graph call. */
      adoptionRate,
      /** Absolute graph calls in the window — 0 is the number worth alarming on. */
      totalGraphCalls,
    },
    cbmDisabled: {
      count: disabled.length,
      comparableCount: comparable.length,
      excludedFromComparable: {
        binary_absent: excludedBinaryAbsent,
        recorded_cbm_usage: excludedCbmUsage,
        total: excludedBinaryAbsent + excludedCbmUsage,
      },
      avgInputTokens: avg(disabledInputTokens),
      avgFileAccessCalls: avg(disabledFileAccess),
      disableReasons,
    },
    specTargets: {
      inputTokenDeltaPct: cohortsSufficient && mechanismObserved
        ? computeDeltaPct(avg(activeInputTokens), avg(comparableInputTokens))
        : null,
      fileAccessDeltaPct: cohortsSufficient && mechanismObserved
        ? computeDeltaPct(avg(activeFileAccess), avg(comparableFileAccess))
        : null,
      deltasSuppressedBecause: cohortsSufficient && mechanismObserved
        ? null
        : !mechanismObserved
          ? 'no_graph_tool_calls_observed'
          : 'insufficient_cohort',
      fallbackRateTarget: 0.05,
      fallbackRateMet: fallbackRate !== null ? fallbackRate < 0.05 : null,
      eligibleFallbackRateMet:
        eligibleFallbackRate !== null ? eligibleFallbackRate < 0.05 : null,
      indexBuildFailureRateTarget: 0.05,
      indexBuildFailureRateMet:
        indexBuildFailureRate !== null ? indexBuildFailureRate < 0.05 : null,
    },
  };
}

export type CbmAggregate = ReturnType<typeof aggregateCbm>;

export interface CbmHealthSummary {
  tracked: number;
  activeCount: number;
  /** null when nothing was tracked — rendered as an em-dash, never as 0%. */
  adoptionRate: number | null;
  totalGraphCalls: number;
  zeroCallTasks: number;
  /** 'unused' is the state that matters: mounted, warm, and never queried. */
  state: 'no_data' | 'unused' | 'partial' | 'healthy' | 'unavailable';
  warmStartRate: number | null;
  warmStarts: number;
  indexAttempted: number;
  indexFailed: number;
  indexFailureRate: number | null;
  topIndexFailReason: { reason: string; count: number } | null;
  eligibleFallbackRate: number | null;
  byDesignSkips: Record<string, number>;
  binaryAbsent: number;
  /**
   * Sandbox mount CBM cannot work without was missing, so CBM was dropped for the
   * task. Breakage, not a decision — it belongs next to binaryAbsent and must NOT
   * join BY_DESIGN_SKIP_REASONS, or a broken mount stops counting as a fallback.
   */
  mountUnavailable: number;
  avgFileAccessOnActive: number | null;
  avgGraphCallsOnActive: number | null;
  inputTokenDeltaPct: number | null;
  fileAccessDeltaPct: number | null;
  deltasSuppressedBecause: string | null;
  topTools: { tool: string; avgCalls: number }[];
}

/**
 * Shape the aggregate for the health panel.
 *
 * Deliberately opinionated about `state`: the failure this page missed for weeks
 * was "mounted, indexed, never queried", which reads as perfect health under any
 * availability-only summary.
 */
export function summarizeCbm(agg: CbmAggregate): CbmHealthSummary {
  const active = agg.cbmActive;
  const binaryAbsent = agg.cbmDisabled.disableReasons.binary_absent ?? 0;
  const mountUnavailable = agg.cbmDisabled.disableReasons.mount_unavailable ?? 0;

  let state: CbmHealthSummary['state'];
  if (agg.totalTracked === 0) state = 'no_data';
  else if (active.count === 0) state = 'unavailable';
  else if (active.totalGraphCalls === 0) state = 'unused';
  else if (active.adoptionRate !== null && active.adoptionRate < 0.5) state = 'partial';
  else state = 'healthy';

  const failEntries = Object.entries(agg.indexBuild.failReasons)
    .sort((a, b) => b[1] - a[1]);

  return {
    tracked: agg.totalTracked,
    activeCount: active.count,
    adoptionRate: active.adoptionRate,
    totalGraphCalls: active.totalGraphCalls,
    zeroCallTasks: active.activeWithZeroToolCalls,
    state,
    warmStartRate: agg.indexBuild.warmStartRate,
    warmStarts: agg.indexBuild.skippedWarm,
    indexAttempted: agg.indexBuild.attempted,
    indexFailed: agg.indexBuild.failed,
    indexFailureRate: agg.indexBuild.failureRate,
    topIndexFailReason: failEntries.length > 0
      ? { reason: failEntries[0][0], count: failEntries[0][1] }
      : null,
    eligibleFallbackRate: agg.eligibleFallbackRate,
    byDesignSkips: agg.eligibility.byDesignSkips,
    binaryAbsent,
    mountUnavailable,
    avgFileAccessOnActive: active.avgFileAccessCalls,
    avgGraphCallsOnActive: active.count > 0 ? active.totalGraphCalls / active.count : null,
    inputTokenDeltaPct: agg.specTargets.inputTokenDeltaPct,
    fileAccessDeltaPct: agg.specTargets.fileAccessDeltaPct,
    deltasSuppressedBecause: agg.specTargets.deltasSuppressedBecause,
    topTools: Object.entries(active.avgToolCalls)
      .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, avgCalls]) => ({ tool, avgCalls })),
  };
}
