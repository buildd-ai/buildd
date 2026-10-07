import { db } from '@buildd/core/db';
import { localSessions, tasks, workers } from '@buildd/core/db/schema';
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import {
  LIVE_WORKER_STATUSES,
  LOCAL_SESSION_ONLINE_MS,
  LOCAL_SESSION_RECENT_MS,
  localClientLabel,
} from '@buildd/shared';

/**
 * How a local interactive session reads on the dashboard. Pure, so the
 * Activity view and the API agree and tests can pin it.
 *
 * - `bound`: online and tracking a live worker for a task.
 * - `online`: online, presence only. Holds no seat.
 * - `offline`: no hook or MCP activity for LOCAL_SESSION_ONLINE_MS, never ended.
 * - `ended`: the client reported the session closed.
 *
 * "Seen" is the later of the presence's own last hook event and its bound
 * worker's last MCP activity: either keeps the session online.
 */
export type LocalSessionState = 'bound' | 'online' | 'offline' | 'ended';

export interface LocalSessionView {
  id: string;
  workspaceId: string | null;
  client: string;
  clientLabel: string;
  clientVersion: string | null;
  repo: string | null;
  interactive: boolean;
  state: LocalSessionState;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  task: { id: string; title: string; status: string } | null;
  workerId: string | null;
  /** True while the bound worker is in the live set (holds the seat its claim took). */
  workerLive: boolean;
}

export interface LocalSessionRow {
  id: string;
  workspaceId: string | null;
  clientKind: string;
  clientVersion: string | null;
  repo: string | null;
  interactive: boolean;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt: Date | null;
  boundWorkerId: string | null;
  workerStatus: string | null;
  workerUpdatedAt: Date | null;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
}

export function classifyLocalSession(row: LocalSessionRow, now: Date): LocalSessionView {
  const workerLive = !!row.workerStatus && (LIVE_WORKER_STATUSES as readonly string[]).includes(row.workerStatus);
  const seen = Math.max(row.lastSeenAt.getTime(), workerLive && row.workerUpdatedAt ? row.workerUpdatedAt.getTime() : 0);
  const online = now.getTime() - seen < LOCAL_SESSION_ONLINE_MS;
  const state: LocalSessionState = row.endedAt
    ? 'ended'
    : !online
      ? 'offline'
      : workerLive
        ? 'bound'
        : 'online';
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    client: row.clientKind,
    clientLabel: localClientLabel(row.clientKind),
    clientVersion: row.clientVersion,
    repo: row.repo,
    interactive: row.interactive,
    state,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: new Date(seen).toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    task: row.taskId ? { id: row.taskId, title: row.taskTitle ?? 'Untitled task', status: row.taskStatus ?? 'unknown' } : null,
    workerId: row.boundWorkerId,
    workerLive,
  };
}

/** Online first, then most recently seen. */
export function sortLocalSessions(views: LocalSessionView[]): LocalSessionView[] {
  const rank: Record<LocalSessionState, number> = { bound: 0, online: 1, offline: 2, ended: 3 };
  return [...views].sort((a, b) => rank[a.state] - rank[b.state] || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** Sessions with any activity in the last day, in these workspaces or of these accounts. */
export async function listLocalSessions(opts: {
  workspaceIds: string[];
  accountIds?: string[];
  now?: Date;
  limit?: number;
}): Promise<LocalSessionView[]> {
  const now = opts.now ?? new Date();
  if (opts.workspaceIds.length === 0 && (opts.accountIds?.length ?? 0) === 0) return [];
  const since = new Date(now.getTime() - LOCAL_SESSION_RECENT_MS);
  const scope = or(
    opts.workspaceIds.length > 0 ? inArray(localSessions.workspaceId, opts.workspaceIds) : undefined,
    opts.accountIds?.length ? inArray(localSessions.accountId, opts.accountIds) : undefined,
  );
  const rows = await db
    .select({
      id: localSessions.id,
      workspaceId: localSessions.workspaceId,
      clientKind: localSessions.clientKind,
      clientVersion: localSessions.clientVersion,
      repo: localSessions.repo,
      interactive: localSessions.interactive,
      startedAt: localSessions.startedAt,
      lastSeenAt: localSessions.lastSeenAt,
      endedAt: localSessions.endedAt,
      boundWorkerId: localSessions.boundWorkerId,
      workerStatus: workers.status,
      workerUpdatedAt: workers.updatedAt,
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
    })
    .from(localSessions)
    .leftJoin(workers, eq(workers.id, localSessions.boundWorkerId))
    .leftJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(scope, or(gt(localSessions.lastSeenAt, since), gt(workers.updatedAt, since))))
    .orderBy(desc(localSessions.lastSeenAt))
    .limit(opts.limit ?? 50);
  return sortLocalSessions(rows.map(r => classifyLocalSession(r as LocalSessionRow, now)));
}

/** "Interactive sessions" count: online presences. Never part of agent capacity. */
export function countInteractiveSessions(views: LocalSessionView[]): number {
  return views.filter(v => v.state === 'bound' || v.state === 'online').length;
}
