/**
 * Health › Queue's one read (spec "Health › Queue", R-14): the team's pending
 * work in claim order, each task's one wait, the lanes in their stored order,
 * live runs and the team's runner slots. The view (./health-queue-view) turns
 * it into tiles, the alert, lanes and the Waiting table.
 *
 * Not a second derivation. The rows are the runner queue's own read
 * (claim-order-queue buildRunnerQueueQuery: the claim's WHERE scope and ORDER
 * BY), the reasons are queue-wait-load's (the claim route's own gates), and the
 * lanes are serial-lanes-store's `loadLanes`, the read the claim route uses.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { LIVE_WORKER_STATUSES, type HealthQueueFilter, type HealthQueueResponse, type QueueWait } from '@buildd/shared';
import { buildRunnerQueueQuery, type RunnerQueueRow } from '@/lib/claim-order-queue';
import type { LaneRead } from '@/lib/serial-lanes-store';
import { stuckSince } from '@/lib/serial-lanes';
import { buildHealthQueueView, type HealthQueueLaneMemberInput, type HealthQueueTaskInput } from '@/lib/health-queue-view';

/** At most this many pending tasks are read; past it the tiles say so. */
export const HEALTH_QUEUE_LIMIT = 1000;

export interface HealthQueueInput {
  teamId: string;
  /** Every workspace in the team: slots and idle capacity are team-wide (R-2). */
  teamWorkspaceIds: string[];
  /** The workspace filter's scope. */
  workspaceIds: string[];
  missionId?: string | null;
  filter: HealthQueueFilter;
  page: number;
  now?: Date;
}

export interface HealthQueueDeps {
  rows?: (opts: { workspaceIds: string[]; limit: number }) => Promise<RunnerQueueRow[]>;
  waits?: (taskIds: string[], now: Date, limit: number) => Promise<Map<string, QueueWait>>;
  lanes?: (workspaceIds: string[], now: Date) => Promise<LaneRead>;
  titles?: (taskIds: string[]) => Promise<Map<string, string>>;
  /** Live runs in these workspaces, optionally in one mission. */
  live?: (workspaceIds: string[], missionId: string | null) => Promise<number>;
  /** Schedulable runner slots for the team. */
  slots?: (teamId: string, teamWorkspaceIds: string[], now: Date) => Promise<number>;
  /** For declared waits: who set each edge (the wait exit, inferred from files). */
  edges?: (taskIds: string[]) => Promise<Map<string, DeclaredEdges>>;
}

/** Where a task's declared edges came from, besides whoever filed it. */
export interface DeclaredEdges {
  /** Its agent ended its run waiting on this task (lib/task-wait-exit.ts), and why. */
  waitExit: { blockerTaskId: string; reason: string } | null;
  /** Edges added at creation because the tasks change the same files. */
  inferred: string[];
}

/** Who set the edge `taskId → blockerId`, and why when it was said. */
export function declaredSetBy(edges: DeclaredEdges | undefined, blockerId: string | null | undefined, ownerName: string | null | undefined): { setBy: string; why: string | null } {
  if (blockerId && edges?.waitExit?.blockerTaskId === blockerId) return { setBy: 'Its agent', why: edges.waitExit.reason || null };
  if (blockerId && edges?.inferred.includes(blockerId)) return { setBy: 'Shared files', why: 'Both change the same files' };
  const first = ownerName?.trim().split(/\s+/)[0];
  return { setBy: first || 'Whoever filed it', why: null };
}

async function readRows(opts: { workspaceIds: string[]; limit: number }): Promise<RunnerQueueRow[]> {
  // No runner gates: the team's queue, not one runner's. Each row's wait says what holds it.
  return (await buildRunnerQueueQuery(db, { workspaceIds: opts.workspaceIds, gates: {}, limit: opts.limit })) as unknown as RunnerQueueRow[];
}

async function readWaits(taskIds: string[], now: Date, limit: number): Promise<Map<string, QueueWait>> {
  const { loadQueueWaitMap } = await import('@/lib/queue-wait-load');
  return loadQueueWaitMap(taskIds, now, { limit });
}

async function readLanes(workspaceIds: string[], now: Date): Promise<LaneRead> {
  const { loadLanes } = await import('@/lib/serial-lanes-store');
  return loadLanes(workspaceIds, now);
}

async function readTitles(taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const found = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds));
  return new Map(found.map(r => [r.id, r.title]));
}

async function readEdges(taskIds: string[]): Promise<Map<string, DeclaredEdges>> {
  if (taskIds.length === 0) return new Map();
  const found = await db
    .select({
      id: tasks.id,
      waitExit: sql<unknown>`${tasks.context}->'waitExit'`,
      inferred: sql<unknown>`${tasks.pathDeclaration}->'inferredDependsOn'`,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));
  return new Map(found.map(r => {
    const w = r.waitExit as { blockerTaskId?: unknown; reason?: unknown } | null;
    return [r.id, {
      waitExit: w && typeof w.blockerTaskId === 'string' ? { blockerTaskId: w.blockerTaskId, reason: typeof w.reason === 'string' ? w.reason : '' } : null,
      inferred: Array.isArray(r.inferred) ? (r.inferred as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    }];
  }));
}

async function readLive(workspaceIds: string[], missionId: string | null): Promise<number> {
  if (workspaceIds.length === 0) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      inArray(workers.workspaceId, workspaceIds),
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
      missionId ? eq(tasks.missionId, missionId) : undefined,
    ));
  return Number(row?.n ?? 0);
}

async function readSlots(teamId: string, teamWorkspaceIds: string[], now: Date): Promise<number> {
  const [{ loadFleetHeartbeats }, { fleetSlotCounts, FLEET_ONLINE_WINDOW_MS }] = await Promise.all([
    import('@/lib/home-fleet'), import('@/lib/fleet-view'),
  ]);
  const beats = await loadFleetHeartbeats({ teamId, wsIds: teamWorkspaceIds, now: now.getTime() });
  return fleetSlotCounts(beats, { now: now.getTime(), onlineThresholdMs: FLEET_ONLINE_WINDOW_MS }).schedulable;
}

const isoOf = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function loadHealthQueue(input: HealthQueueInput, deps: HealthQueueDeps = {}): Promise<HealthQueueResponse> {
  const now = input.now ?? new Date();
  const missionId = input.missionId ?? null;
  const [rowsRead, lanes, live, teamBusy, slots] = await Promise.all([
    (deps.rows ?? readRows)({ workspaceIds: input.workspaceIds, limit: HEALTH_QUEUE_LIMIT }),
    (deps.lanes ?? readLanes)(input.workspaceIds, now).catch(() => null),
    (deps.live ?? readLive)(input.workspaceIds, missionId).catch(() => 0),
    (deps.live ?? readLive)(input.teamWorkspaceIds, null).catch(() => 0),
    (deps.slots ?? readSlots)(input.teamId, input.teamWorkspaceIds, now).catch(() => 0),
  ]);
  const truncated = rowsRead.length > HEALTH_QUEUE_LIMIT;
  const scoped = rowsRead.slice(0, HEALTH_QUEUE_LIMIT);
  // The mission filter's options come from the whole workspace scope, so choosing one never hides the rest.
  const missions = [...new Map(scoped.filter(r => r.missionId).map(r => [r.missionId!, r.missionTitle ?? 'Untitled mission'])).entries()]
    .map(([id, title]) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const rows = missionId ? scoped.filter(r => r.missionId === missionId) : scoped;

  const waits = rows.length > 0
    ? await (deps.waits ?? readWaits)(rows.map(r => r.id), now, HEALTH_QUEUE_LIMIT).catch(() => new Map<string, QueueWait>())
    : new Map<string, QueueWait>();

  const declaredIds = rows.filter(r => waits.get(r.id)?.kind === 'declared').map(r => r.id);
  const edges = declaredIds.length > 0
    ? await (deps.edges ?? readEdges)(declaredIds).catch(() => new Map<string, DeclaredEdges>())
    : new Map<string, DeclaredEdges>();

  const laneList: Array<{ workspaceId: string; lane: string; members: HealthQueueLaneMemberInput[] }> = [];
  if (lanes) {
    const memberIds = [...new Set([...lanes.lanes.values()].flatMap(byLane => [...byLane.values()].flatMap(v => v.members.map(m => m.taskId))))];
    const titles = await (deps.titles ?? readTitles)(memberIds).catch(() => new Map<string, string>());
    for (const byLane of lanes.lanes.values()) {
      for (const view of byLane.values()) {
        laneList.push({
          workspaceId: view.workspaceId,
          lane: view.lane,
          members: view.members.map(m => ({
            taskId: m.taskId,
            title: titles.get(m.taskId) ?? `Task ${m.taskId.slice(0, 8)}`,
            holding: m.holding,
            status: m.status,
            prNumber: m.prNumber,
            since: isoOf(m.holding ? m.heldAt : m.claimableSince),
            stuckSince: m.holding ? isoOf(stuckSince(m, now)) : null,
          })),
        });
      }
    }
  }

  const taskRows: HealthQueueTaskInput[] = rows.map(r => {
    const wait = waits.get(r.id) ?? null;
    return {
      id: r.id,
      title: r.title,
      workspaceId: r.workspaceId,
      missionTitle: r.missionTitle,
      createdAt: isoOf(r.createdAt) ?? now.toISOString(),
      wait,
      ...(wait?.kind === 'declared' ? declaredSetBy(edges.get(r.id), wait.blockerId, r.ownerName) : {}),
    };
  });

  return buildHealthQueueView({
    now: now.getTime(),
    running: live,
    slots,
    teamBusy,
    tasks: taskRows,
    lanes: laneList,
    filter: input.filter,
    page: input.page,
    truncated,
    reasonsUnavailable: rows.length > 0 && waits.size === 0,
    missions,
  });
}
