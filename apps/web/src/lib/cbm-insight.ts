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
import {
  CBM_INJECTION_KILL_DEFAULTS,
  INELIGIBLE_OUTCOMES,
  type CbmInjectionMetrics,
  type CbmInjectionOutcome,
} from '@buildd/core/cbm-injection';

export interface CbmRow {
  inputTokens: number;
  cbm: CbmMetrics;
}

/**
 * Disable reasons that are decisions, not failures. Excluded from both sides of
 * the fallback rate: a worktree-less run has nothing to index, and an opted-out
 * role asked not to have the graph.
 *
 * `codex_task` is a decision too, but a much narrower one than it used to be, and
 * the distinction is the whole reason this set is documented rather than obvious.
 * The original rationale was that "no amount of engineering makes a Codex task use
 * the graph" — that turned out to be false. CBM now mounts for Codex tasks
 * (stdio `[mcp_servers.codebase-memory]` in the worker's Codex config.toml), so a
 * Codex worker with a worktree and the binary present is `enforced`, lands in
 * `active`, and counts in BOTH the adoption numerator's denominator and the
 * eligible cohort — exactly like a Claude worker. The runner only emits
 * `codex_task` when CBM-for-Codex is deliberately switched off fleet-wide, which
 * is a configuration decision and belongs here.
 *
 * The other half of that fix is in the runner: `codex_task` used to be evaluated
 * FIRST, so a Codex task that actually hit `no_worktree`, `role_opt_out` or
 * `binary_absent` was labelled `codex_task` and — via this set — excluded from the
 * fallback rate. Genuine breakage on Codex was therefore invisible here. The
 * reason is now decided once, in `buildCbmActivation`, with `codex_task` last but
 * for the kill switch.
 *
 * `no_worktree` staying in this set is a deliberate decision, not an oversight,
 * even though `cbm-health.ts`'s fleet-disabled alert now treats `no_worktree` as
 * just as alertable as `binary_absent` (a real incident proved a worktree-creation
 * crash can produce it, see that file's header). The two consumers answer
 * different questions: the alert is "did disablement of any kind just streak",
 * which only needs the reason string for the message body. This aggregate is
 * "what's the graph's steady-state fallback rate", which needs disableReason
 * partitioned into decisions vs failures — and `CbmMetrics` carries no field that
 * distinguishes "no repo to index" from "worktree creation crashed", both of
 * which produce identical `no_worktree` rows. Folding `no_worktree` into the
 * fallback numerator here would count every legitimate coordination task as
 * platform breakage, which is a worse misreading than the one being fixed.
 * Making that distinction properly needs a new signal from the runner (e.g. did
 * this task even request a worktree), not a reclassification of the existing
 * reason string — scoped as its own follow-up, not folded into this change.
 */
export const BY_DESIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  'codex_task',
  'no_worktree',
  'role_opt_out',
  // Withheld by the cbm_access experiment. A decision, not breakage; the
  // experiment's own readout (/api/experiments/[id]/readout) is where the
  // randomised comparison lives, not this observational one.
  'experiment_withheld',
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
  let bootstrapBackgrounded = 0;
  let bootstrapBackgroundLanded = 0;
  let bootstrapSkippedWarm = 0;
  let bootstrapUnreported = 0;
  const bootstrapFailReasons: Record<string, number> = {};
  for (const r of active) {
    const result = r.cbm.bootstrapResult;
    if (result === 'ok') bootstrapOk++;
    else if (result === 'skipped_warm') bootstrapSkippedWarm++;
    else if (result === 'backgrounded') {
      bootstrapBackgrounded++;
      if (r.cbm.backgroundIndexLanded) bootstrapBackgroundLanded++;
    } else if (result === 'failed') {
      bootstrapFailed++;
      const reason = r.cbm.bootstrapFailReason ?? 'unknown';
      bootstrapFailReasons[reason] = (bootstrapFailReasons[reason] ?? 0) + 1;
    } else if (r.cbm.outcome === 'enforced') {
      bootstrapUnreported++;
    }
  }
  // A warm start is not an attempt: nothing was built, so counting it would dilute
  // the failure rate of the tasks that did build an index.
  //
  // A BACKGROUNDED build is an attempt — a build really ran — but not a failure:
  // it overran the startup wait budget and was handed off, and the graph arrives
  // mid-session. Keeping it in the denominator is what stops the hand-off from
  // improving the headline rate by arithmetic alone; backgroundIndexLandedRate is
  // the number that says whether it improved anything real.
  const bootstrapAttempted = bootstrapOk + bootstrapFailed + bootstrapBackgrounded;
  const indexBuildFailureRate = bootstrapAttempted > 0 ? bootstrapFailed / bootstrapAttempted : null;
  const indexBuildBackgroundedRate =
    bootstrapAttempted > 0 ? bootstrapBackgrounded / bootstrapAttempted : null;
  // null, not 0, when nothing was backgrounded: "never happened" must not render
  // as "never landed".
  const backgroundIndexLandedRate =
    bootstrapBackgrounded > 0 ? bootstrapBackgroundLanded / bootstrapBackgrounded : null;
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
    injection: aggregateCbmInjection(rows.map(r => r.cbm.injection)),
    fallbackRate,
    eligibleFallbackRate,
    eligibility: { eligibleCount, fallbackCount, byDesignSkipCount, byDesignSkips },
    indexBuild: {
      attempted: bootstrapAttempted,
      ok: bootstrapOk,
      failed: bootstrapFailed,
      failureRate: indexBuildFailureRate,
      /** Builds handed off because they overran the startup wait budget. */
      backgrounded: bootstrapBackgrounded,
      backgroundedRate: indexBuildBackgroundedRate,
      /** Of those, the ones that finished successfully before the session ended. */
      backgroundLanded: bootstrapBackgroundLanded,
      /** null when nothing was backgrounded — never render that as "never landed". */
      backgroundLandedRate: backgroundIndexLandedRate,
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

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * CBM search injection, across sessions (docs/design/cbm-search-injection.md,
 * "Kill metric"). Read from `resultMeta.cbm.injection`; a session without the
 * block never ran injection and is not counted anywhere here.
 *
 * - injectedRate = triggers whose diff was non-empty ÷ eligible triggers
 *   (eligible drops cap/repeat/unsupported: those never reached the graph by
 *   rule, not by anything the graph did).
 * - uptakeRate = injections followed by a Read/Edit of an injected location
 *   within the window ÷ injections tracked.
 *
 * Both null, never 0, on an empty denominator. The verdict stays
 * `insufficient_n` until enough sessions had an eligible trigger.
 */
export function aggregateCbmInjection(
  blocks: Array<CbmInjectionMetrics | undefined>,
  kill: { sessions: number; minInjectedRate: number; minUptakeRate: number } = CBM_INJECTION_KILL_DEFAULTS,
) {
  let sessions = 0;
  let enabledSessions = 0;
  let sessionsWithEligibleTrigger = 0;
  const disabledReasons: Record<string, number> = {};
  const byOutcome: Partial<Record<CbmInjectionOutcome, number>> = {};
  let triggers = 0;
  let eligibleTriggers = 0;
  let nonEmptyDiff = 0;
  let injections = 0;
  let uptakeTracked = 0;
  let uptakeTaken = 0;
  const jevLabels: Record<string, number> = {};
  const jevStatuses: Record<string, number> = {};
  const latencies: number[] = [];
  const jevLatencies: number[] = [];

  for (const b of blocks) {
    if (!b) continue;
    sessions++;
    if (b.enabled) enabledSessions++;
    else if (b.disabledReason) disabledReasons[b.disabledReason] = (disabledReasons[b.disabledReason] ?? 0) + 1;
    triggers += b.triggers ?? 0;
    let ineligible = 0;
    for (const [k, v] of Object.entries(b.byOutcome ?? {}) as [CbmInjectionOutcome, number][]) {
      byOutcome[k] = (byOutcome[k] ?? 0) + v;
      if (INELIGIBLE_OUTCOMES.has(k)) ineligible += v;
    }
    const eligible = (b.triggers ?? 0) - ineligible;
    eligibleTriggers += eligible;
    if (eligible > 0) sessionsWithEligibleTrigger++;
    nonEmptyDiff += b.nonEmptyDiff ?? 0;
    injections += b.injections ?? 0;
    uptakeTracked += b.uptake?.tracked ?? 0;
    uptakeTaken += b.uptake?.taken ?? 0;
    for (const e of b.events ?? []) {
      if (INELIGIBLE_OUTCOMES.has(e.outcome)) continue;
      latencies.push(e.latencyMs);
      if (e.jev) {
        jevStatuses[e.jev.status] = (jevStatuses[e.jev.status] ?? 0) + 1;
        if (e.jev.label) jevLabels[e.jev.label] = (jevLabels[e.jev.label] ?? 0) + 1;
        jevLatencies.push(e.jev.latencyMs);
      }
    }
  }
  latencies.sort((a, b) => a - b);
  jevLatencies.sort((a, b) => a - b);
  const jevCalls = Object.values(jevStatuses).reduce((a, b) => a + b, 0);
  const injectedRate = eligibleTriggers > 0 ? nonEmptyDiff / eligibleTriggers : null;
  const uptakeRate = uptakeTracked > 0 ? uptakeTaken / uptakeTracked : null;
  const verdict: 'insufficient_n' | 'keep' | 'kill' = sessionsWithEligibleTrigger < kill.sessions
    ? 'insufficient_n'
    : (injectedRate !== null && injectedRate < kill.minInjectedRate) || (uptakeRate !== null && uptakeRate < kill.minUptakeRate)
      ? 'kill'
      : 'keep';

  return {
    sessions,
    enabledSessions,
    disabledReasons,
    triggers,
    eligibleTriggers,
    byOutcome,
    nonEmptyDiff,
    injections,
    /** Kill metric 1: how often the graph knew something the search missed. */
    injectedRate,
    uptake: { tracked: uptakeTracked, taken: uptakeTaken },
    /** Kill metric 2: how often an injection was followed by a Read/Edit of what it named. */
    uptakeRate,
    jev: {
      calls: jevCalls,
      labels: jevLabels,
      statuses: jevStatuses,
      /** Share of Jev calls whose answer was not applied (error or below the gate). */
      fallbackShare: jevCalls > 0 ? ((jevStatuses.error ?? 0) + (jevStatuses.below_threshold ?? 0)) / jevCalls : null,
      p50LatencyMs: percentile(jevLatencies, 0.5),
    },
    hookLatencyMs: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) },
    killMetric: { ...kill, sessionsWithEligibleTrigger, verdict },
  };
}

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
  /**
   * Builds handed off at the startup wait budget rather than aborted. An attempt,
   * not a failure — reported alongside the failure rate so the reclassification
   * cannot be mistaken for an improvement on its own.
   */
  indexBackgrounded: number;
  indexBackgroundedRate: number | null;
  /** Share of handed-off builds that finished before the session ended. */
  backgroundIndexLandedRate: number | null;
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
    indexBackgrounded: agg.indexBuild.backgrounded,
    indexBackgroundedRate: agg.indexBuild.backgroundedRate,
    backgroundIndexLandedRate: agg.indexBuild.backgroundLandedRate,
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
