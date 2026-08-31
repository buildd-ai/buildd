import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workers, workspaces } from '@buildd/core/db/schema';
import type { CbmMetrics } from '@buildd/core/db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { getUserTeamIds } from '@/lib/team-access';
import { aggregateCbm, type CbmRow } from '@/lib/cbm-insight';

/** Parse a window string like "24h", "7d", "30d" into milliseconds. */
function parseWindowMs(window: string): number {
  const match = /^(\d+)([hd])$/.exec(window);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d
  const n = parseInt(match[1], 10);
  return match[2] === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
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

  // Aggregation lives in @/lib/cbm-insight so the health page renders exactly what
  // this endpoint reports. Cohort rules and their rationale are documented there.
  const cbmRows: CbmRow[] = [];
  for (const row of rows) {
    const cbm = (row.resultMeta as { cbm?: CbmMetrics } | null)?.cbm;
    if (!cbm) continue; // pre-CBM worker — excluded from both cohorts
    cbmRows.push({ inputTokens: row.inputTokens ?? 0, cbm });
  }

  return NextResponse.json(aggregateCbm(cbmRows, windowParam, windowStart));
}

function emptyResponse(window: string, windowStart: Date) {
  return {
    window,
    windowStart: windowStart.toISOString(),
    totalTracked: 0,
    fallbackRate: null,
    eligibleFallbackRate: null,
    eligibility: { eligibleCount: 0, fallbackCount: 0, byDesignSkipCount: 0, byDesignSkips: {} },
    indexBuild: { attempted: 0, ok: 0, failed: 0, failureRate: null, skippedWarm: 0, warmStartRate: null, unreported: 0, failReasons: {} },
    cbmActive: { count: 0, byOutcome: {}, avgInputTokens: null, avgFileAccessCalls: null, avgToolCalls: {}, activeWithZeroToolCalls: 0, mechanismObserved: false, adoptionRate: null, totalGraphCalls: 0 },
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
