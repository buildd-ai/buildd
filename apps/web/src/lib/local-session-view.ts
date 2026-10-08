import { db } from '@buildd/core/db';
import { localSessions, localSessionWorkers, tasks, workers } from '@buildd/core/db/schema';
import { and, asc, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
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
 * - `bound`: online and holding at least one live worker for a task.
 * - `online`: online, presence only. Holds no seat.
 * - `offline`: no hook or MCP activity for LOCAL_SESSION_ONLINE_MS, never ended.
 * - `ended`: the client reported the session closed.
 *
 * "Seen" is the later of the presence's own last hook event and its live held
 * workers' last MCP activity: any of them keeps the session online.
 *
 * A session can hold several tasks (its subagents each claim one). `tasks`
 * lists them all, oldest claim first; `task` / `workerId` are the primary one:
 * the newest live claim, else the newest claim.
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
  /** True while any held worker is in the live set (holds the seat its claim took). */
  workerLive: boolean;
  tasks: LocalSessionTaskView[];
}

export interface LocalSessionTaskView {
  id: string;
  title: string;
  status: string;
  workerId: string;
  /** The worker still holds its seat. */
  live: boolean;
}

/** One worker a session holds, with its task. */
export interface LocalSessionHeldRow {
  workerId: string;
  workerStatus: string | null;
  workerUpdatedAt: Date | null;
  taskId: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
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
  /** Oldest claim first. */
  held: LocalSessionHeldRow[];
}

const isLive = (status: string | null) => !!status && (LIVE_WORKER_STATUSES as readonly string[]).includes(status);

export function classifyLocalSession(row: LocalSessionRow, now: Date): LocalSessionView {
  const live = row.held.filter(h => isLive(h.workerStatus));
  const workerLive = live.length > 0;
  const seen = Math.max(row.lastSeenAt.getTime(), ...live.map(h => h.workerUpdatedAt?.getTime() ?? 0));
  const primary = live[live.length - 1] ?? row.held[row.held.length - 1] ?? null;
  const tasks: LocalSessionTaskView[] = row.held
    .filter(h => h.taskId)
    .map(h => ({ id: h.taskId!, title: h.taskTitle ?? 'Untitled task', status: h.taskStatus ?? 'unknown', workerId: h.workerId, live: isLive(h.workerStatus) }));
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
    task: primary?.taskId ? { id: primary.taskId, title: primary.taskTitle ?? 'Untitled task', status: primary.taskStatus ?? 'unknown' } : null,
    workerId: primary?.workerId ?? null,
    workerLive,
    tasks,
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
  // Recent: the presence's own hooks, or any worker it holds (join rows or the legacy column).
  const heldRecently = sql`EXISTS (
    SELECT 1 FROM ${localSessionWorkers} lsw JOIN ${workers} hw ON hw.id = lsw."worker_id"
    WHERE lsw."local_session_id" = ${localSessions.id} AND hw."updated_at" > ${since.toISOString()}::timestamptz
  ) OR EXISTS (
    SELECT 1 FROM ${workers} lw WHERE lw.id = ${localSessions.boundWorkerId} AND lw."updated_at" > ${since.toISOString()}::timestamptz
  )`;
  const presences = await db
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
    })
    .from(localSessions)
    .where(and(scope, or(gt(localSessions.lastSeenAt, since), heldRecently)))
    .orderBy(desc(localSessions.lastSeenAt))
    .limit(opts.limit ?? 50);
  if (presences.length === 0) return [];

  const ids = presences.map(p => p.id);
  const heldColumns = {
    workerId: workers.id,
    workerStatus: workers.status,
    workerUpdatedAt: workers.updatedAt,
    taskId: tasks.id,
    taskTitle: tasks.title,
    taskStatus: tasks.status,
  };
  const [joined, legacy] = await Promise.all([
    db.select({ sessionId: localSessionWorkers.localSessionId, boundAt: localSessionWorkers.boundAt, ...heldColumns })
      .from(localSessionWorkers)
      .innerJoin(workers, eq(workers.id, localSessionWorkers.workerId))
      .leftJoin(tasks, eq(tasks.id, workers.taskId))
      .where(inArray(localSessionWorkers.localSessionId, ids))
      .orderBy(asc(localSessionWorkers.boundAt)),
    // A session bound before multi-claim: its single worker, from the legacy column.
    db.select({ sessionId: localSessions.id, boundAt: localSessions.boundAt, ...heldColumns })
      .from(localSessions)
      .innerJoin(workers, eq(workers.id, localSessions.boundWorkerId))
      .leftJoin(tasks, eq(tasks.id, workers.taskId))
      .where(and(inArray(localSessions.id, ids), isNotNull(localSessions.boundWorkerId))),
  ]);
  const heldBySession = new Map<string, Array<LocalSessionHeldRow & { at: number }>>();
  for (const h of [...legacy, ...joined]) {
    const list = heldBySession.get(h.sessionId) ?? [];
    if (list.some(x => x.workerId === h.workerId)) continue;
    const { sessionId: _s, boundAt, ...rest } = h;
    list.push({ ...rest, at: boundAt?.getTime() ?? 0 });
    heldBySession.set(h.sessionId, list);
  }
  const rows: LocalSessionRow[] = presences.map(p => ({
    ...p,
    held: (heldBySession.get(p.id) ?? []).sort((a, b) => a.at - b.at).map(({ at: _a, ...h }) => h),
  }));
  return sortLocalSessions(rows.map(r => classifyLocalSession(r, now)).filter(shownInSessionList));
}

/**
 * A headless session (`claude -p`, an SDK run, a Cursor background agent) is
 * nobody's interactive session, so its bare presence is not listed. Once it
 * has claimed a task it is shown: it holds a worker and real work.
 */
export function shownInSessionList(v: LocalSessionView): boolean {
  return v.interactive || v.task !== null;
}

/** "Interactive sessions" count: online presences. Never part of agent capacity. */
export function countInteractiveSessions(views: LocalSessionView[]): number {
  return views.filter(v => shownInSessionList(v) && (v.state === 'bound' || v.state === 'online')).length;
}
