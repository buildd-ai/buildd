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
 *   3. What is the index fallback rate?  → fallbackRate (0–1; target <0.05)
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
  type Row = { inputTokens: number; cbm: CbmMetrics };
  const active: Row[] = [];
  const disabled: Row[] = [];

  for (const row of rows) {
    const cbm = (row.resultMeta as { cbm?: CbmMetrics } | null)?.cbm;
    if (!cbm) continue; // pre-CBM worker — exclude from both buckets
    const entry: Row = { inputTokens: row.inputTokens ?? 0, cbm };
    if (cbm.outcome === 'disabled') {
      disabled.push(entry);
    } else {
      active.push(entry);
    }
  }

  const totalTracked = active.length + disabled.length;
  const fallbackRate = totalTracked > 0 ? disabled.length / totalTracked : null;

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
  const activeWithZeroToolCalls = active.filter(
    r => Object.values(r.cbm.toolCalls).reduce((a, b) => a + b, 0) === 0
  ).length;
  const mechanismObserved = active.length > 0 && activeWithZeroToolCalls < active.length;

  // Comparison baseline. binary_absent is EXCLUDED: it means the binary was missing
  // from the image, so those workers come from a different infrastructure regime,
  // not from a control group that could have used CBM and didn't. Including them
  // made post-fix actives look ~80% better than a population that never had the
  // capability at all.
  const comparable = disabled.filter(r => r.cbm.disableReason !== 'binary_absent');
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
    /** Tasks where CBM MCP was active (enforced or legacy .mcp.json). */
    cbmActive: {
      count: active.length,
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
      /** Disabled tasks usable as a control (binary_absent excluded — see above). */
      comparableCount: comparable.length,
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
      fallbackRateMet: fallbackRate !== null ? fallbackRate < 0.05 : null,
    },
  });
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
    cbmActive: { count: 0, avgInputTokens: null, avgFileAccessCalls: null, avgToolCalls: {}, activeWithZeroToolCalls: 0, mechanismObserved: false },
    cbmDisabled: { count: 0, comparableCount: 0, avgInputTokens: null, avgFileAccessCalls: null, disableReasons: {} },
    specTargets: {
      inputTokenDeltaPct: null,
      fileAccessDeltaPct: null,
      deltasSuppressedBecause: 'insufficient_cohort' as const,
      fallbackRateTarget: 0.05,
      fallbackRateMet: null,
    },
  };
}
