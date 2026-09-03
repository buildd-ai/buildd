import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { inArray } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveAccountTeamIds } from '@/lib/team-access';
import { parseWindowMs } from '@/lib/usage-stats';
import {
  ACTION_EVENTS_CAPTURED_SINCE,
  ACTION_EVENTS_ROW_LIMIT,
  countWorkersInWindow,
  fetchActionEvents,
} from '@/lib/action-events';

const WINDOWS = ['24h', '7d', '30d'] as const;
type Window = (typeof WINDOWS)[number];

/**
 * GET /api/stats/actions
 *
 * Raw per-call event stream for the buildd MCP tool's `action` param
 * (health-analytics-spec §4.3 item 1 / WU-4). Each event is
 * {workerId, taskId, action, ts} — no RUNTIME/WORK classification, because
 * that classification is task-conditional (create_pr/create_artifact/
 * upload_artifact/merge_pr are RUNTIME only under a specific
 * outputRequirement/loopConfig) and has to be computed by joining each event
 * to its task at query time, by whoever builds the drill-down panel. This
 * route does not do that join or render anything — it only makes the raw
 * events reachable.
 *
 * Query params:
 *   window    - "24h" | "7d" | "30d" (default "7d") — closed set, 400 on
 *               anything else (get_usage_stats's ?window=banana bug is not
 *               repeated here, see health-analytics-spec §2.4)
 *   workspace - workspaceId filter (optional; must be one the caller can see)
 *
 * `coverage.workersWithEvents / coverage.workers` is a THIRD coverage class,
 * distinct from tools.coverage's histogram/derived/none split in
 * usage-stats.ts: there is no derived fallback here, only "captured" or
 * "not yet". Read it against `capturedSince` — a quiet window entirely before
 * that date is "not yet captured", not "no buildd calls happened".
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const apiAccount = apiKey ? await authenticateApiKey(apiKey) : null;

  if (!user && !apiAccount) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window') ?? '7d';
  if (!WINDOWS.includes(windowParam as Window)) {
    return NextResponse.json(
      { error: `window must be one of ${WINDOWS.join('|')}` },
      { status: 400 },
    );
  }
  const workspaceParam = url.searchParams.get('workspace');
  const windowStart = new Date(Date.now() - parseWindowMs(windowParam));

  // Both auth types resolve to the same team scope, so an API key can't read a
  // team it isn't on even when it passes an explicit ?workspace=.
  const teamIds = await resolveAccountTeamIds(user, apiAccount ?? null);
  const scopedWorkspaces = teamIds.length > 0
    ? await db.query.workspaces.findMany({
        where: inArray(workspaces.teamId, teamIds),
        columns: { id: true },
      })
    : [];
  const allowedIds = scopedWorkspaces.map(w => w.id);

  if (workspaceParam && !allowedIds.includes(workspaceParam)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const workspaceIds = workspaceParam ? [workspaceParam] : allowedIds;

  if (workspaceIds.length === 0) {
    return NextResponse.json(emptyResponse(windowParam, windowStart));
  }

  const [events, totalWorkers] = await Promise.all([
    fetchActionEvents({ workspaceIds, windowStart }),
    countWorkersInWindow({ workspaceIds, windowStart }),
  ]);

  const workersWithEvents = new Set(events.map(e => e.workerId)).size;

  return NextResponse.json({
    window: windowParam,
    windowStart: windowStart.toISOString(),
    workspaceIds,
    capturedSince: ACTION_EVENTS_CAPTURED_SINCE,
    /**
     * True when the event-row cap was hit — `events` is then the newest
     * `limit` rows, not the complete window, and `coverage.workersWithEvents`
     * (derived from this same capped set) is a floor for the same reason.
     */
    truncated: events.length >= ACTION_EVENTS_ROW_LIMIT,
    coverage: {
      workers: totalWorkers,
      workersWithEvents,
    },
    events: events.map(e => ({
      workerId: e.workerId,
      taskId: e.taskId,
      action: e.action,
      ts: e.ts.toISOString(),
    })),
  });
}

function emptyResponse(window: string, windowStart: Date) {
  return {
    window,
    windowStart: windowStart.toISOString(),
    workspaceIds: [] as string[],
    capturedSince: ACTION_EVENTS_CAPTURED_SINCE,
    truncated: false,
    coverage: { workers: 0, workersWithEvents: 0 },
    events: [] as unknown[],
  };
}
