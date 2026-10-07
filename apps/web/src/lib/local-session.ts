import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { localSessions, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  INTERACTIVE_WORKER_RUNNER,
  LIVE_WORKER_STATUSES,
  LOCAL_SESSION_TOUCH_THROTTLE_MS,
  type LocalSessionEvent,
  type LocalSessionEventResult,
} from '@buildd/shared';
import { INTERACTIVE_LIVE_STATUSES } from '@/lib/interactive-worker-liveness';

/**
 * Presence for a person's interactive coding session, fed by the buildd agent
 * plugin's lifecycle hooks (POST /api/workers/local-sessions). The contract is
 * in packages/shared/src/local-session.ts; the behaviour is
 * docs/specs/local-agent-presence.md.
 *
 * Three rules hold everything up:
 *
 *  1. Presence is not a worker. A `start`/`touch` writes only `local_sessions`:
 *     no `workers` row, no `accounts.activeSessions`, no task. It never counts
 *     against any capacity.
 *  2. A presence is bound only to a worker that already exists and that the
 *     server itself marked interactive: `workers.runner = 'mcp'`, which the
 *     claim route writes only after verifying the signed MCP session marker
 *     (lib/interactive-session.ts). The hook can name a worker; it cannot make
 *     one, and it cannot make a runner's worker look interactive. One worker is
 *     bound to at most one presence, ever (unique index), and only to a
 *     presence of the account that claimed it.
 *  3. Ending a session never completes anything. A bound worker is detached
 *     through the same exactly-once primitive "Release slot" uses
 *     (lib/interactive-detach.ts): a terminal task keeps its status and PR, an
 *     open task goes back to pending.
 *
 * Every write is coalesced to one a minute per session (and a hook touch and an
 * MCP touch of the same worker coalesce on the same `updated_at` guard), and
 * every event is idempotent, so replays are harmless.
 */

export interface LocalSessionAccount {
  id: string;
  teamId: string;
  /** A workspace-restricted token only ever resolves to one of these. */
  workspaceIds?: string[] | null;
}

/** The presence row fields the handler reads. */
export interface PresenceRow {
  id: string;
  boundWorkerId: string | null;
  endedAt: Date | null;
}

export interface BindableWorker {
  id: string;
  accountId: string | null;
  runner: string;
  status: string;
  taskId: string | null;
  workspaceId: string;
}

/** Storage seam. The default is Drizzle; tests use an in-memory stand-in. */
export interface LocalSessionStore {
  /** Insert or refresh the presence (re-opening an ended one). */
  upsertStart(input: {
    accountId: string;
    clientKind: string;
    clientSessionHash: string;
    clientVersion: string | null;
    repo: string | null;
    workspaceId: string | null;
    interactive: boolean;
    now: Date;
  }): Promise<PresenceRow>;
  find(accountId: string, clientKind: string, clientSessionHash: string): Promise<PresenceRow | null>;
  /** Bump last_seen_at if older than the throttle window. True if written. */
  touchPresence(id: string, now: Date): Promise<boolean>;
  /** Keep the bound interactive worker alive, same guard as the MCP touch. True if written. */
  touchBoundWorker(workerId: string, accountId: string, now: Date): Promise<boolean>;
  findWorker(workerId: string): Promise<BindableWorker | null>;
  /**
   * CAS: bind when the presence is open and holds no OTHER live worker.
   * Returns false when another presence already holds this worker (unique) or
   * this presence still holds a different live one.
   */
  bind(presenceId: string, workerId: string, workspaceId: string, now: Date): Promise<boolean>;
  /** CAS on `ended_at IS NULL`. Returns the row it ended, or null if already ended. */
  end(presenceId: string, reason: string, now: Date): Promise<PresenceRow | null>;
  /** Whether the worker has an instruction queued that no consumer picked up. */
  workerState(workerId: string): Promise<{ taskId: string | null; pendingInstructions: boolean; live: boolean } | null>;
}

export interface LocalSessionDeps {
  store?: LocalSessionStore;
  resolveWorkspace?: (account: LocalSessionAccount, repo: string) => Promise<string | null>;
  detach?: (workerId: string, reason: string) => Promise<{ detached: boolean }>;
  now?: Date;
}

/** The client session id is stored only as this hash. */
export function hashClientSessionId(clientKind: string, clientSessionId: string): string {
  return createHash('sha256').update(`${clientKind}:${clientSessionId}`).digest('hex');
}

const result = (
  outcome: string,
  presence: PresenceRow | null,
  state: { taskId: string | null; pendingInstructions: boolean } | null = null,
): LocalSessionEventResult => ({
  ok: true,
  sessionId: presence?.id ?? null,
  taskId: state?.taskId ?? null,
  pendingInstructions: state?.pendingInstructions ?? false,
  outcome,
});

export class LocalSessionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Apply one session event for the authenticated account. Throws
 * LocalSessionError for a refusal the route answers as non-2xx; the hook
 * ignores it either way (fail open).
 */
export async function handleLocalSessionEvent(
  account: LocalSessionAccount,
  event: LocalSessionEvent,
  deps: LocalSessionDeps = {},
): Promise<LocalSessionEventResult> {
  const store = deps.store ?? drizzleLocalSessionStore;
  const now = deps.now ?? new Date();
  const hash = hashClientSessionId(event.client, event.clientSessionId);

  const ensurePresence = async (): Promise<PresenceRow> => {
    const workspaceId = event.repo && deps.resolveWorkspace !== undefined
      ? await deps.resolveWorkspace(account, event.repo)
      : event.repo
        ? await resolveWorkspaceForRepo(account, event.repo)
        : null;
    return store.upsertStart({
      accountId: account.id,
      clientKind: event.client,
      clientSessionHash: hash,
      clientVersion: event.clientVersion ?? null,
      repo: event.repo ?? null,
      workspaceId,
      interactive: event.interactive ?? true,
      now,
    });
  };

  const boundState = async (presence: PresenceRow) =>
    presence.boundWorkerId ? store.workerState(presence.boundWorkerId) : null;

  switch (event.event) {
    case 'start': {
      const presence = await ensurePresence();
      return result('started', presence, await boundState(presence));
    }

    case 'touch': {
      let presence = await store.find(account.id, event.client, hash);
      // A missed or failed start heals here, so presence never depends on one hook firing.
      if (!presence || presence.endedAt) {
        presence = await ensurePresence();
        return result('started', presence, await boundState(presence));
      }
      const wrote = await store.touchPresence(presence.id, now);
      if (presence.boundWorkerId) await store.touchBoundWorker(presence.boundWorkerId, account.id, now);
      return result(wrote ? 'touched' : 'coalesced', presence, await boundState(presence));
    }

    case 'bind': {
      const workerId = event.workerId!;
      const worker = await store.findWorker(workerId);
      // Same answer for "no such worker" and "someone else's", so this cannot probe ids.
      if (!worker || worker.accountId !== account.id) {
        throw new LocalSessionError(404, 'worker_not_found', 'No worker with that id for this account');
      }
      if (worker.runner !== INTERACTIVE_WORKER_RUNNER) {
        throw new LocalSessionError(409, 'not_interactive', 'Only a worker minted by a verified interactive claim_task can be bound');
      }
      if (!(LIVE_WORKER_STATUSES as readonly string[]).includes(worker.status)) {
        throw new LocalSessionError(409, 'worker_not_live', 'That worker has already ended');
      }
      let presence = await store.find(account.id, event.client, hash);
      if (!presence || presence.endedAt) presence = await ensurePresence();
      if (presence.boundWorkerId === workerId) {
        return result('already_bound', presence, await store.workerState(workerId));
      }
      const won = await store.bind(presence.id, workerId, worker.workspaceId, now);
      if (!won) {
        throw new LocalSessionError(409, 'bound_elsewhere', 'That worker is bound to another session, or this session still holds a live one');
      }
      const bound = { ...presence, boundWorkerId: workerId };
      return result('bound', bound, await store.workerState(workerId));
    }

    case 'end': {
      const presence = await store.find(account.id, event.client, hash);
      if (!presence) return result('unknown_session', null);
      const ended = await store.end(presence.id, event.reason ?? 'other', now);
      // Already ended: the release (if any) happened on the first end. Exactly once.
      if (!ended) return result('already_ended', presence);
      if (!ended.boundWorkerId) return result('ended', ended);
      // `clear` keeps the conversation's process (and its MCP connection, which
      // made the claim and keeps it alive) running under a new session id.
      if (event.reason === 'clear') return result('ended_kept_claim', ended);
      const detach = deps.detach ?? defaultDetach;
      const r = await detach(ended.boundWorkerId, `local ${event.client} session ended`);
      return result(r.detached ? 'ended_released' : 'ended', ended);
    }
  }
}

async function defaultDetach(workerId: string, reason: string): Promise<{ detached: boolean }> {
  const { detachInteractiveWorker } = await import('@/lib/interactive-detach');
  return detachInteractiveWorker({ workerId, actor: { kind: 'system' }, reason });
}

/** Workspace for a repo among those the account reaches; null when none. */
export async function resolveWorkspaceForRepo(account: LocalSessionAccount, repo: string): Promise<string | null> {
  try {
    const { listReachableWorkspaceIds } = await import('@/lib/workspace-access');
    const { workspaceRepoMatches } = await import('@/lib/repo-scope');
    const reachable = (await listReachableWorkspaceIds({ account: { id: account.id, teamId: account.teamId } }))
      .filter(id => account.workspaceIds == null || account.workspaceIds.includes(id));
    if (reachable.length === 0) return null;
    const ws = await db.query.workspaces.findFirst({
      where: and(workspaceRepoMatches(repo), inArray(workspaces.id, reachable)),
      columns: { id: true },
    });
    return ws && reachable.includes(ws.id) ? ws.id : null;
  } catch (err) {
    console.warn('[local-session] workspace resolution failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── SQL predicates (exported so tests render them with the real dialect) ─────

const throttleCutoff = (now: Date) => new Date(now.getTime() - LOCAL_SESSION_TOUCH_THROTTLE_MS);

/** Presence write coalescing: only an open row not written this minute. */
export function presenceTouchWhere(id: string, now: Date): SQL {
  return and(eq(localSessions.id, id), isNull(localSessions.endedAt), lt(localSessions.lastSeenAt, throttleCutoff(now)))!;
}

/**
 * The bound worker's keep-alive. Same shape as the MCP touch
 * (interactiveTouchScope): this account's own live interactive row, skipped
 * when anything (hook or MCP) already touched it this minute.
 */
export function boundWorkerTouchWhere(workerId: string, accountId: string, now: Date): SQL {
  return and(
    eq(workers.id, workerId),
    eq(workers.accountId, accountId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    inArray(workers.status, [...INTERACTIVE_LIVE_STATUSES]),
    lt(workers.updatedAt, throttleCutoff(now)),
  )!;
}

/** Bind CAS: open presence, holding nothing or only a worker that is no longer live. */
export function bindWhere(presenceId: string, workerId: string): SQL {
  return and(
    eq(localSessions.id, presenceId),
    isNull(localSessions.endedAt),
    or(
      isNull(localSessions.boundWorkerId),
      eq(localSessions.boundWorkerId, workerId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${workers} w_bound
        WHERE w_bound.id = ${localSessions.boundWorkerId}
        AND w_bound.status IN (${sql.join(LIVE_WORKER_STATUSES.map(s => sql`${s}`), sql`, `)})
      )`,
    ),
  )!;
}

const presenceColumns = { id: localSessions.id, boundWorkerId: localSessions.boundWorkerId, endedAt: localSessions.endedAt };

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

export const drizzleLocalSessionStore: LocalSessionStore = {
  async upsertStart(i) {
    const [row] = await db
      .insert(localSessions)
      .values({
        accountId: i.accountId,
        clientKind: i.clientKind,
        clientSessionHash: i.clientSessionHash,
        clientVersion: i.clientVersion,
        repo: i.repo,
        workspaceId: i.workspaceId,
        interactive: i.interactive,
        startedAt: i.now,
        lastSeenAt: i.now,
      })
      .onConflictDoUpdate({
        target: [localSessions.accountId, localSessions.clientKind, localSessions.clientSessionHash],
        set: {
          lastSeenAt: i.now,
          endedAt: null,
          endReason: null,
          ...(i.clientVersion ? { clientVersion: i.clientVersion } : {}),
          ...(i.repo ? { repo: i.repo } : {}),
          ...(i.workspaceId ? { workspaceId: i.workspaceId } : {}),
          interactive: i.interactive,
        },
      })
      .returning(presenceColumns);
    return row;
  },
  async find(accountId, clientKind, clientSessionHash) {
    const [row] = await db
      .select(presenceColumns)
      .from(localSessions)
      .where(and(
        eq(localSessions.accountId, accountId),
        eq(localSessions.clientKind, clientKind),
        eq(localSessions.clientSessionHash, clientSessionHash),
      ))
      .limit(1);
    return row ?? null;
  },
  async touchPresence(id, now) {
    const rows = await db.update(localSessions).set({ lastSeenAt: now }).where(presenceTouchWhere(id, now)).returning({ id: localSessions.id });
    return rows.length > 0;
  },
  async touchBoundWorker(workerId, accountId, now) {
    try {
      const rows = await db.update(workers).set({ updatedAt: now }).where(boundWorkerTouchWhere(workerId, accountId, now)).returning({ id: workers.id });
      return rows.length > 0;
    } catch (err) {
      console.warn('[local-session] bound worker touch failed:', err instanceof Error ? err.message : err);
      return false;
    }
  },
  async findWorker(workerId) {
    const w = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { id: true, accountId: true, runner: true, status: true, taskId: true, workspaceId: true },
    });
    return w ?? null;
  },
  async bind(presenceId, workerId, workspaceId, now) {
    try {
      const rows = await db
        .update(localSessions)
        .set({ boundWorkerId: workerId, boundAt: now, workspaceId, lastSeenAt: now })
        .where(bindWhere(presenceId, workerId))
        .returning({ id: localSessions.id });
      return rows.length > 0;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  },
  async end(presenceId, reason, now) {
    const [row] = await db
      .update(localSessions)
      .set({ endedAt: now, endReason: reason, lastSeenAt: now })
      .where(and(eq(localSessions.id, presenceId), isNull(localSessions.endedAt)))
      .returning(presenceColumns);
    return row ?? null;
  },
  async workerState(workerId) {
    const w = await db.query.workers.findFirst({
      where: eq(workers.id, workerId),
      columns: { taskId: true, pendingInstructions: true, status: true },
    });
    if (!w) return null;
    const live = (LIVE_WORKER_STATUSES as readonly string[]).includes(w.status);
    return { taskId: w.taskId, pendingInstructions: live && !!w.pendingInstructions?.trim(), live };
  },
};
