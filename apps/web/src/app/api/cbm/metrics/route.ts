import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import type { CbmMetrics } from '@buildd/core/db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';

/** Parse a window string like "24h", "7d", "30d" into milliseconds. */
function parseWindowMs(window: string): number {
  const match = /^(\d+)([hd])$/.exec(window);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d
  const n = parseInt(match[1], 10);
  return match[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * GET /api/cbm/metrics
 *
 * Returns aggregate CBM observability metrics for a time window.
 *
 * Query params:
 *   window   - time window: "24h" | "7d" | "30d" (default "7d")
 *   workspace - workspaceId filter (optional)
 *
 * The three questions this answers (per the CBM spec):
 *   1. Are input tokens per task down?   → cbmActive.avgInputTokens vs cbmDisabled.avgInputTokens
 *   2. Are Read/Grep/Glob calls down?    → cbmActive.avgFileAccessCalls vs cbmDisabled.avgFileAccessCalls
 *   3. What is the index fallback rate?  → eligibleFallbackRate (0–1; target <0.05)
 *                                          plus indexBuild.failureRate for a
 *                                          graph that was built and failed.
 *
 * Cohort rules (both are load-bearing — see the inline comments below):
 *   - ACTIVE  = outcome 'enforced' OR 'legacy_mcp_json' (CBM was mounted, however
 *     it got mounted). Anything not explicitly 'disabled' is treated as active so
 *     a future outcome value can never silently land in the control group.
 *   - BASELINE (`comparable`) = outcome 'disabled' AND reason is not
 *     'binary_absent' AND the row recorded ZERO CBM tool calls.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = apiKey ? await authenticateApiKey(apiKey) : null;

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (apiAccount && apiAccount.level !== 'admin') {
    return NextResponse.json({ error: 'Admin API key required' }, { status: 403 });
  }

  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window') ?? '7d';
  const workspaceParam = url.searchParams.get('workspace') ?? null;

  const windowMs = parseWindowMs(windowParam);
  const windowStart = new Date(Date.now() - windowMs);

  // Determine which workspaces the caller can see.
  let allowedWorkspaceIds: string[] | null = null;
  if (user && !apiAccount) {
    const teamIds = await getUserTeamIds(user.id);
    if (teamIds.length > 0) {
      const ws = await db.query.workspaces.findMany({
        where: inArray(workspaces.teamId, teamIds),
        columns: { id: true },
      });
      allowedWorkspaceIds = ws.map(w => w.id);
    } else {
      allowedWorkspaceIds = [];
    }
  }

  // Build query conditions.
  const conditions = [
    eq(workers.status, 'completed'),
    gte(workers.completedAt, windowStart),
  ];
  if (workspaceParam) {
    conditions.push(eq(workers.workspaceId, workspaceParam));
  } else if (allowedWorkspaceIds !== null) {
    if (allowedWorkspaceIds.length === 0) {
      return NextResponse.json(emptyResponse(windowParam, windowStart));
    }
    conditions.push(inArray(workers.workspaceId, allowedWorkspaceIds));
  }

  const rows = await db.query.workers.findMany({
    where: and(...conditions),
    columns: {
      id: true,
      inputTokens: true,
      resultMeta: true,
    },
    limit: 5000,
  });

  // Partition rows into CBM-active and CBM-disabled.
  //
  // 'legacy_mcp_json' means codebase-memory was mounted by a connector or a
  // project .mcp.json without the harness enforcing it. It is ACTIVE: the
  // capability was present and the agent could query it. Putting it in the
  // baseline (which is what happened while the runner never assigned the value)
  // seeds the control group with rows that had CBM the whole time.
  type Row = { inputTokens: number; cbm: CbmMetrics };
  const active: Row[] = [];
  const disabled: Row[] = [];
  const activeByOutcome: Record<string, number> = {};

  for (const row of rows) {
    const cbm = (row.resultMeta as { cbm?: CbmMetrics } | null)?.cbm;
    if (!cbm) continue; // pre-CBM worker — exclude from both buckets
    const entry: Row = { inputTokens: row.inputTokens ?? 0, cbm };
    if (cbm.outcome === 'disabled') {
      disabled.push(entry);
    } else {
      // 'enforced', 'legacy_mcp_json', or any future non-disabled outcome.
      active.push(entry);
      const key = cbm.outcome ?? 'unknown';
      activeByOutcome[key] = (activeByOutcome[key] ?? 0) + 1;
    }
  }

  const totalTracked = active.length + disabled.length;
  /**
   * DEPRECATED. Retained verbatim so existing readers are not silently
   * redefined: it counts every disabled row — including by-design skips — over
   * every tracked row, which makes the documented <0.05 target unreachable.
   * Use `eligibleFallbackRate` instead.
   */
  const fallbackRate = totalTracked > 0 ? disabled.length / totalTracked : null;

  // --- Eligibility: "cases where CBM should have worked" ---------------------
  // codex_task / no_worktree / role_opt_out are decisions, not failures. They
  // are removed from BOTH the numerator and the denominator; a fleet that runs
  // mostly Codex tasks must not read as a 100% fallback rate.
  const byDesignSkips: Record<string, number> = {};
  let fallbackCount = 0;
  for (const r of disabled) {
    const reason = r.cbm.disableReason;
    if (reason && BY_DESIGN_SKIP_REASONS.has(reason)) {
      byDesignSkips[reason] = (byDesignSkips[reason] ?? 0) + 1;
    } else {
      // binary_absent, or a disabled row with no reason recorded at all: CBM
      // should have worked here and did not.
      fallbackCount++;
    }
  }
  const byDesignSkipCount = disabled.length - fallbackCount;
  const eligibleCount = active.length + fallbackCount;
  const eligibleFallbackRate = eligibleCount > 0 ? fallbackCount / eligibleCount : null;

  // --- Index build: the failure that never reached fallbackRate --------------
  // The runner sets bootstrapResult='failed' inside the ENFORCED branch, so a
  // broken index is recorded as outcome='enforced' and was invisible to every
  // aggregate on this endpoint. bootstrapResult had one writer and zero readers.
  let bootstrapOk = 0;
  let bootstrapFailed = 0;
  let bootstrapUnreported = 0;
  const bootstrapFailReasons: Record<string, number> = {};
  for (const r of active) {
    const result = r.cbm.bootstrapResult;
    if (result === 'ok') bootstrapOk++;
    else if (result === 'failed') {
      bootstrapFailed++;
      const reason = r.cbm.bootstrapFailReason ?? 'unknown';
      bootstrapFailReasons[reason] = (bootstrapFailReasons[reason] ?? 0) + 1;
    } else if (r.cbm.outcome === 'enforced') {
      // Enforced but no bootstrapResult recorded — an older runner, or the
      // bootstrap never ran. Reported so `attempted` is never mistaken for
      // "every enforced task".
      bootstrapUnreported++;
    }
  }
  const bootstrapAttempted = bootstrapOk + bootstrapFailed;
  const indexBuildFailureRate = bootstrapAttempted > 0 ? bootstrapFailed / bootstrapAttempted : null;

  // Aggregate CBM-active stats.
  const activeInputTokens = active.map(r => r.inputTokens);
  const activeFileAccess = active.map(r => r.cbm.readCount + r.cbm.grepCount + r.cbm.globCount);
  const activeToolBreakdown: Record<string, number[]> = {};
  for (const r of active) {
    for (const [tool, count] of Object.entries(r.cbm.toolCalls)) {
      (activeToolBreakdown[tool] ??= []).push(count);
    }
  }

  // Mechanism check. A worker can have CBM mounted and never query it — which is
  // what actually happened on first rollout: 5 active workers, zero graph calls,
  // while the deltas below showed -80% input tokens. Those deltas had no mechanism
  // behind them. Surface the mechanism explicitly so efficacy is never inferred
  // from a cohort difference alone.
  // Deliberately counts only the toolCalls map (not cbmUsage): this field's
  // published meaning is "recorded no per-tool calls", and cbmUsage is the
  // wider, protect-the-control-group definition used for baseline exclusion.
  const activeWithZeroToolCalls = active.filter(
    r => Object.values(r.cbm.toolCalls ?? {}).reduce((a, b) => a + (b ?? 0), 0) === 0
  ).length;
  const mechanismObserved = active.length > 0 && activeWithZeroToolCalls < active.length;

  // Comparison baseline. binary_absent is EXCLUDED: it means the binary was missing
  // from the image, so those workers come from a different infrastructure regime,
  // not from a control group that could have used CBM and didn't. Including them
  // made post-fix actives look ~80% better than a population that never had the
  // capability at all.
  //
  // Second exclusion: a row that recorded ANY CBM tool call is not a control,
  // whatever its outcome says. Tool counting in the runner is unconditional, so
  // a worker with codebase-memory mounted by a connector / project .mcp.json —
  // but not enforced by the harness — is labelled 'disabled' and still carries
  // genuine graph usage. Such a row is quarantined from the baseline and NOT
  // promoted into the active cohort either: its label and its behaviour
  // disagree, so its harness state is unknown.
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

  // Reported as-is over ALL disabled tasks: this is the health view, and narrowing
  // it would silently change the meaning of an existing field. Only the deltas use
  // the comparable subset.
  const disabledInputTokens = disabled.map(r => r.inputTokens);
  const disabledFileAccess = disabled.map(r => r.cbm.readCount + r.cbm.grepCount + r.cbm.globCount);

  /** Minimum cohort size on BOTH sides before a delta is reported at all. */
  const MIN_COHORT = 5;
  const cohortsSufficient = active.length >= MIN_COHORT && comparable.length >= MIN_COHORT;

  // Disable-reason breakdown.
  const disableReasons: Record<string, number> = {};
  for (const r of disabled) {
    const reason = r.cbm.disableReason ?? 'unknown';
    disableReasons[reason] = (disableReasons[reason] ?? 0) + 1;
  }

  return NextResponse.json({
    window: windowParam,
    windowStart: windowStart.toISOString(),
    totalTracked,
    /**
     * Fallback rate: fraction of tracked tasks where CBM was not active.
     * Target: <0.05 (spec). null when no tracked tasks exist yet.
     */
    fallbackRate,
    /**
     * Fallback rate over the cases where CBM SHOULD have worked:
     *   denominator = active tasks + disabled tasks whose reason is not a
     *                 by-design skip (codex_task / no_worktree / role_opt_out)
     *   numerator   = those non-by-design disabled tasks
     * This is the number the spec's <0.05 target applies to. Index-build
     * failures are not counted here — they have their own metric below.
     */
    eligibleFallbackRate,
    /** How the eligible denominator was formed, so the rate can be audited. */
    eligibility: {
      eligibleCount,
      fallbackCount,
      byDesignSkipCount,
      byDesignSkips,
    },
    /**
     * Index-build health, aggregated from cbm.bootstrapResult (previously
     * written by the runner and read by nothing). A failed pre-index leaves the
     * outcome at 'enforced', so without this a broken graph is invisible.
     */
    indexBuild: {
      attempted: bootstrapAttempted,
      ok: bootstrapOk,
      failed: bootstrapFailed,
      failureRate: indexBuildFailureRate,
      /** Enforced tasks that reported no bootstrapResult at all. */
      unreported: bootstrapUnreported,
      failReasons: bootstrapFailReasons,
    },
    /** Tasks where CBM MCP was active (enforced or legacy .mcp.json). */
    cbmActive: {
      count: active.length,
      /** Active tasks split by how CBM got mounted. */
      byOutcome: activeByOutcome,
      avgInputTokens: avg(activeInputTokens),
      avgFileAccessCalls: avg(activeFileAccess),
      /** Average per-task calls broken down by CBM tool name. */
      avgToolCalls: Object.fromEntries(
        Object.entries(activeToolBreakdown).map(([tool, counts]) => [tool, avg(counts)])
      ),
      /** Active tasks that never called a single CBM tool. */
      activeWithZeroToolCalls,
      /**
       * False when every active task made zero graph calls. While false, the
       * deltas in specTargets are NOT attributable to CBM — there is no mechanism.
       */
      mechanismObserved,
    },
    /** Tasks where CBM was not active — serves as the comparison baseline. */
    cbmDisabled: {
      count: disabled.length,
      /**
       * Disabled tasks usable as a control: binary_absent excluded, and any row
       * that recorded CBM tool usage excluded (see above).
       */
      comparableCount: comparable.length,
      /** Why baseline rows were dropped, so the control group is auditable. */
      excludedFromComparable: {
        binary_absent: excludedBinaryAbsent,
        recorded_cbm_usage: excludedCbmUsage,
        total: excludedBinaryAbsent + excludedCbmUsage,
      },
      avgInputTokens: avg(disabledInputTokens),
      avgFileAccessCalls: avg(disabledFileAccess),
      disableReasons,
    },
    /**
     * Spec targets for quick health-check:
     *   inputTokens:    -30% on structural work (cbmActive vs cbmDisabled)
     *   fileAccessCalls: -40%
     *   fallbackRate:   <5%
     */
    specTargets: {
      /**
       * Deltas are null unless BOTH cohorts clear MIN_COHORT and at least one
       * active task actually called a graph tool. Without the mechanism, a delta
       * is a cohort artifact, and reporting it as efficacy is worse than
       * reporting nothing.
       */
      inputTokenDeltaPct: cohortsSufficient && mechanismObserved
        ? computeDeltaPct(avg(activeInputTokens), avg(comparableInputTokens))
        : null,
      fileAccessDeltaPct: cohortsSufficient && mechanismObserved
        ? computeDeltaPct(avg(activeFileAccess), avg(comparableFileAccess))
        : null,
      /** Why deltas are suppressed, when they are. */
      deltasSuppressedBecause: cohortsSufficient && mechanismObserved
        ? null
        : !mechanismObserved
          ? 'no_graph_tool_calls_observed'
          : 'insufficient_cohort',
      fallbackRateTarget: 0.05,
      /**
       * DEPRECATED — evaluated against the deprecated `fallbackRate`, which
       * counts by-design skips and therefore can effectively never be met.
       * Kept so existing readers see the same number they saw before. Use
       * `eligibleFallbackRateMet`.
       */
      fallbackRateMet: fallbackRate !== null ? fallbackRate < 0.05 : null,
      /** The spec target, evaluated against the honest denominator. */
      eligibleFallbackRateMet:
        eligibleFallbackRate !== null ? eligibleFallbackRate < 0.05 : null,
      indexBuildFailureRateTarget: 0.05,
      /** null when no task ever attempted a pre-index in this window. */
      indexBuildFailureRateMet:
        indexBuildFailureRate !== null ? indexBuildFailureRate < 0.05 : null,
    },
  });
}

/**
 * Disable reasons that are decisions, not failures. Excluded from both sides of
 * the fallback rate: no amount of engineering makes a Codex task or a
 * worktree-less run use the graph.
 */
const BY_DESIGN_SKIP_REASONS: ReadonlySet<string> = new Set([
  'codex_task',
  'no_worktree',
  'role_opt_out',
]);

/**
 * Total CBM tool calls recorded for a task. Uses whichever of totalCbmCalls /
 * toolCalls is larger so a row cannot look unused because one of the two was
 * written by an older runner.
 */
function cbmUsage(cbm: CbmMetrics): number {
  const fromMap = Object.values(cbm.toolCalls ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  return Math.max(fromMap, cbm.totalCbmCalls ?? 0);
}

function computeDeltaPct(active: number | null, baseline: number | null): number | null {
  if (active === null || baseline === null || baseline === 0) return null;
  return (active - baseline) / baseline;
}

function emptyResponse(window: string, windowStart: Date) {
  return {
    window,
    windowStart: windowStart.toISOString(),
    totalTracked: 0,
    fallbackRate: null,
    eligibleFallbackRate: null,
    eligibility: { eligibleCount: 0, fallbackCount: 0, byDesignSkipCount: 0, byDesignSkips: {} },
    indexBuild: { attempted: 0, ok: 0, failed: 0, failureRate: null, unreported: 0, failReasons: {} },
    cbmActive: { count: 0, byOutcome: {}, avgInputTokens: null, avgFileAccessCalls: null, avgToolCalls: {}, activeWithZeroToolCalls: 0, mechanismObserved: false },
    cbmDisabled: {
      count: 0,
      comparableCount: 0,
      excludedFromComparable: { binary_absent: 0, recorded_cbm_usage: 0, total: 0 },
      avgInputTokens: null,
      avgFileAccessCalls: null,
      disableReasons: {},
    },
    specTargets: {
      inputTokenDeltaPct: null,
      fileAccessDeltaPct: null,
      deltasSuppressedBecause: 'insufficient_cohort' as const,
      fallbackRateTarget: 0.05,
      fallbackRateMet: null,
      eligibleFallbackRateMet: null,
      indexBuildFailureRateTarget: 0.05,
      indexBuildFailureRateMet: null,
    },
  };
}
