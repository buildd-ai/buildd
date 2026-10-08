import { createHash } from 'crypto';
import { db } from '@buildd/core/db';
import { accounts, localSessions, localSessionWorkers, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  INTERACTIVE_WORKER_RUNNER,
  LIVE_WORKER_STATUSES,
  LOCAL_SESSION_TOUCH_THROTTLE_MS,
  type LocalSessionEvent,
  type LocalSessionEventResult,
} from '@buildd/shared';
import { INTERACTIVE_CLAIM_USER_KEY, INTERACTIVE_LIVE_STATUSES } from '@/lib/interactive-worker-liveness';
import { priceSessionUsage } from '@buildd/core/model-prices';
import type { LocalSessionUsage } from '@buildd/shared';

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
 *     one, and it cannot make a runner's worker look interactive. A presence
 *     may hold several (a session's subagents each claim their own task), but
 *     one worker is bound to at most one presence, ever (primary key on
 *     local_session_workers.worker_id), and only to a
 *     presence of the account that claimed it, or of the person that account's
 *     team belongs to (a presence token, lib/presence-token.ts): their claim
 *     may have used any of their teams' keys or OAuth. When the claim recorded
 *     who made it, only that person.
 *  3. Ending a session never completes anything. Each bound worker is detached
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

/**
 * The person behind a presence token (lib/presence-token.ts). Their presences
 * are their own, not a team account's, and they may bind an interactive worker
 * of any team they belong to.
 */
export interface LocalSessionPerson {
  kind: 'user';
  userId: string;
  teamIds: string[];
}

export type LocalSessionPrincipal = LocalSessionAccount | LocalSessionPerson;

/** Who owns a presence row: an account (API key) or a person (presence token). */
export type PresenceOwner = { accountId: string } | { userId: string };

export function isLocalSessionPerson(p: LocalSessionPrincipal): p is LocalSessionPerson {
  return (p as LocalSessionPerson).kind === 'user';
}

const ownerOf = (p: LocalSessionPrincipal): PresenceOwner => (isLocalSessionPerson(p) ? { userId: p.userId } : { accountId: p.id });

/** The presence row fields the handler reads. */
export interface PresenceRow {
  id: string;
  /** Every worker this presence holds (live or not), oldest bind first. */
  workerIds: string[];
  endedAt: Date | null;
}

export interface BindableWorker {
  id: string;
  accountId: string | null;
  runner: string;
  status: string;
  taskId: string | null;
  workspaceId: string;
  /** Team of the account that claimed it. */
  ownerTeamId: string | null;
  /** The person the claim route recorded on the task, when the session had one (OAuth). */
  claimUserId: string | null;
}

/** Storage seam. The default is Drizzle; tests use an in-memory stand-in. */
export interface LocalSessionStore {
  /** Insert or refresh the presence (re-opening an ended one). */
  upsertStart(input: {
    owner: PresenceOwner;
    clientKind: string;
    clientSessionHash: string;
    clientVersion: string | null;
    repo: string | null;
    workspaceId: string | null;
    interactive: boolean;
    now: Date;
  }): Promise<PresenceRow>;
  find(owner: PresenceOwner, clientKind: string, clientSessionHash: string): Promise<PresenceRow | null>;
  /** Bump last_seen_at if older than the throttle window. True if written. */
  touchPresence(id: string, now: Date): Promise<boolean>;
  /**
   * Keep the bound interactive worker alive, same guard as the MCP touch. True
   * if written. `accountId` null: a person's presence, whose bound worker may
   * belong to any of their teams' accounts (bind checked that).
   */
  touchBoundWorker(workerId: string, accountId: string | null, now: Date): Promise<boolean>;
  findWorker(workerId: string): Promise<BindableWorker | null>;
  /**
   * Add a worker to an open presence. Returns false when the presence has
   * ended or another presence already holds this worker.
   */
  bind(presenceId: string, workerId: string, workspaceId: string, now: Date): Promise<boolean>;
  /** CAS on `ended_at IS NULL`. Returns the row it ended, or null if already ended. */
  end(presenceId: string, reason: string, now: Date): Promise<PresenceRow | null>;
  /**
   * Raise a held worker's usage to the session's cumulative totals (never
   * lowers them, so replays and reordering are harmless). Only an interactive
   * worker that is live, or ended within USAGE_GRACE_MS (the last report of a
   * session that just called complete_task). True if written.
   */
  recordUsage(u: WorkerUsageWrite): Promise<boolean>;
  /** Whether the worker has an instruction queued that no consumer picked up. */
  workerState(workerId: string): Promise<{ taskId: string | null; pendingInstructions: boolean; live: boolean } | null>;
}

/** What one held worker's usage report writes. */
export interface WorkerUsageWrite {
  workerId: string;
  allInInputTokens: number;
  outputTokens: number;
  requests: number;
  /** Null when any model was unpriced: nothing is written to cost. */
  costUsd: number | null;
  /** Per-model usage for priced sessions; null when unpriced (see priceSessionUsage). */
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> | null;
  totalUsage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  /** Effort and provenance, kept under resultMeta.localSessionUsage. */
  effort: {
    source: 'local-session';
    requests: number;
    toolCalls: number;
    subagents: number;
    firstAt: string | null;
    lastAt: string | null;
    costUnknown: boolean;
    unpricedModels: string[];
    models: LocalSessionUsage['workers'][number]['models'];
  };
  now: Date;
}

/** A session's last usage report may land just after its task completed. */
export const USAGE_GRACE_MS = 10 * 60 * 1000;

/** Price one held worker's cumulative usage into the write the store applies. */
export function usageWrite(w: LocalSessionUsage['workers'][number], now: Date): WorkerUsageWrite {
  const priced = priceSessionUsage(w.models);
  const costUnknown = priced.costUsd === null;
  return {
    workerId: w.workerId,
    allInInputTokens: priced.allInInputTokens,
    outputTokens: priced.outputTokens,
    requests: priced.requests,
    costUsd: priced.costUsd,
    modelUsage: costUnknown ? null : Object.fromEntries(Object.entries(priced.modelUsage).map(([m, u]) => [m, { ...u, costUSD: u.costUSD ?? 0 }])),
    totalUsage: {
      inputTokens: priced.allInInputTokens,
      outputTokens: priced.outputTokens,
      cacheReadInputTokens: priced.cacheReadInputTokens,
      cacheCreationInputTokens: priced.cacheCreationInputTokens,
    },
    effort: {
      source: 'local-session',
      requests: priced.requests,
      toolCalls: w.toolCalls,
      subagents: w.subagents,
      firstAt: w.firstAt ?? null,
      lastAt: w.lastAt ?? null,
      costUnknown,
      unpricedModels: priced.unpricedModels,
      models: w.models,
    },
    now,
  };
}

export interface LocalSessionDeps {
  store?: LocalSessionStore;
  resolveWorkspace?: (principal: LocalSessionPrincipal, repo: string) => Promise<string | null>;
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
 * Apply one session event for the authenticated account or person. Throws
 * LocalSessionError for a refusal the route answers as non-2xx; the hook
 * ignores it either way (fail open).
 */
export async function handleLocalSessionEvent(
  principal: LocalSessionPrincipal,
  event: LocalSessionEvent,
  deps: LocalSessionDeps = {},
): Promise<LocalSessionEventResult> {
  const store = deps.store ?? drizzleLocalSessionStore;
  const now = deps.now ?? new Date();
  const hash = hashClientSessionId(event.client, event.clientSessionId);
  const owner = ownerOf(principal);

  const ensurePresence = async (): Promise<PresenceRow> => {
    const workspaceId = event.repo && deps.resolveWorkspace !== undefined
      ? await deps.resolveWorkspace(principal, event.repo)
      : event.repo
        ? await resolveWorkspaceForRepo(principal, event.repo)
        : null;
    return store.upsertStart({
      owner,
      clientKind: event.client,
      clientSessionHash: hash,
      clientVersion: event.clientVersion ?? null,
      repo: event.repo ?? null,
      workspaceId,
      interactive: event.interactive ?? true,
      now,
    });
  };

  // Usage only ever reaches a worker this very presence holds: the hook names
  // workers, but bind already decided which of them are this session's.
  const recordHeldUsage = async (presence: PresenceRow) => {
    for (const w of event.usage?.workers ?? []) {
      if (!presence.workerIds.includes(w.workerId)) continue;
      try {
        await store.recordUsage(usageWrite(w, now));
      } catch (err) {
        console.warn('[local-session] usage write failed:', err instanceof Error ? err.message : err);
      }
    }
  };

  // Across every held worker: a pending instruction on any of them is flagged
  // (naming that task), else the most recently bound live task is reported.
  const boundState = async (presence: PresenceRow) => {
    if (presence.workerIds.length === 0) return null;
    const states = (await Promise.all(presence.workerIds.map(id => store.workerState(id)))).filter(s => s !== null);
    const pending = states.find(s => s.pendingInstructions);
    if (pending) return pending;
    const live = states.filter(s => s.live);
    return live[live.length - 1] ?? null;
  };

  switch (event.event) {
    case 'start': {
      const presence = await ensurePresence();
      return result('started', presence, await boundState(presence));
    }

    case 'touch': {
      let presence = await store.find(owner, event.client, hash);
      // A missed or failed start heals here, so presence never depends on one hook firing.
      if (!presence || presence.endedAt) {
        presence = await ensurePresence();
        return result('started', presence, await boundState(presence));
      }
      await recordHeldUsage(presence);
      const wrote = await store.touchPresence(presence.id, now);
      for (const workerId of presence.workerIds) {
        await store.touchBoundWorker(workerId, isLocalSessionPerson(principal) ? null : principal.id, now);
      }
      return result(wrote ? 'touched' : 'coalesced', presence, await boundState(presence));
    }

    case 'bind': {
      const workerId = event.workerId!;
      const worker = await store.findWorker(workerId);
      // Same answer for "no such worker" and "someone else's", so this cannot probe ids.
      if (!worker || !ownsWorker(principal, worker)) {
        throw new LocalSessionError(404, 'worker_not_found', 'No worker with that id for this account');
      }
      if (worker.runner !== INTERACTIVE_WORKER_RUNNER) {
        throw new LocalSessionError(409, 'not_interactive', 'Only a worker minted by a verified interactive claim_task can be bound');
      }
      if (!(LIVE_WORKER_STATUSES as readonly string[]).includes(worker.status)) {
        throw new LocalSessionError(409, 'worker_not_live', 'That worker has already ended');
      }
      let presence = await store.find(owner, event.client, hash);
      if (!presence || presence.endedAt) presence = await ensurePresence();
      if (presence.workerIds.includes(workerId)) {
        return result('already_bound', presence, await store.workerState(workerId));
      }
      const won = await store.bind(presence.id, workerId, worker.workspaceId, now);
      if (!won) {
        throw new LocalSessionError(409, 'bound_elsewhere', 'That worker is bound to another session');
      }
      const bound = { ...presence, workerIds: [...presence.workerIds, workerId] };
      return result('bound', bound, await store.workerState(workerId));
    }

    case 'end': {
      const presence = await store.find(owner, event.client, hash);
      if (!presence) return result('unknown_session', null);
      // The last usage lands before the release, while the worker is still live.
      await recordHeldUsage(presence);
      const ended = await store.end(presence.id, event.reason ?? 'other', now);
      // Already ended: the release (if any) happened on the first end. Exactly once.
      if (!ended) return result('already_ended', presence);
      if (ended.workerIds.length === 0) return result('ended', ended);
      // `clear` keeps the conversation's process (and its MCP connection, which
      // made the claims and keeps them alive) running under a new session id.
      if (event.reason === 'clear') return result('ended_kept_claim', ended);
      // Each worker through the exactly-once primitive: a finished one is a no-op.
      const detach = deps.detach ?? defaultDetach;
      let released = 0;
      for (const workerId of ended.workerIds) {
        const r = await detach(workerId, `local ${event.client} session ended`);
        if (r.detached) released++;
      }
      return result(released > 0 ? 'ended_released' : 'ended', ended);
    }
  }
}

/**
 * Whose interactive worker this is. An account: its own. A person: one claimed
 * by an account of a team they are in and, when the claim recorded who made
 * it, by them; a teammate's recorded claim is not theirs to bind or release.
 */
function ownsWorker(principal: LocalSessionPrincipal, worker: BindableWorker): boolean {
  if (!isLocalSessionPerson(principal)) return worker.accountId === principal.id;
  if (!worker.accountId || !worker.ownerTeamId || !principal.teamIds.includes(worker.ownerTeamId)) return false;
  return worker.claimUserId === null || worker.claimUserId === principal.userId;
}

async function defaultDetach(workerId: string, reason: string): Promise<{ detached: boolean }> {
  const { detachInteractiveWorker } = await import('@/lib/interactive-detach');
  return detachInteractiveWorker({ workerId, actor: { kind: 'system' }, reason });
}

/** Workspace for a repo among those the account (or person) reaches; null when none. */
export async function resolveWorkspaceForRepo(principal: LocalSessionPrincipal, repo: string): Promise<string | null> {
  try {
    const { listReachableWorkspaceIds } = await import('@/lib/workspace-access');
    const { workspaceRepoMatches } = await import('@/lib/repo-scope');
    const reachable = isLocalSessionPerson(principal)
      ? await listReachableWorkspaceIds({ userId: principal.userId })
      : (await listReachableWorkspaceIds({ account: { id: principal.id, teamId: principal.teamId } }))
        .filter(id => principal.workspaceIds == null || principal.workspaceIds.includes(id));
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

/**
 * Usage writes reach only an interactive worker that is live, or that ended
 * after `graceCutoff` (the report that follows complete_task).
 */
export function usageWriteWhere(workerId: string, graceCutoff: Date): SQL {
  return and(
    eq(workers.id, workerId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    or(
      inArray(workers.status, [...LIVE_WORKER_STATUSES]),
      gt(workers.completedAt, graceCutoff),
    ),
  )!;
}

/** Presence write coalescing: only an open row not written this minute. */
export function presenceTouchWhere(id: string, now: Date): SQL {
  return and(eq(localSessions.id, id), isNull(localSessions.endedAt), lt(localSessions.lastSeenAt, throttleCutoff(now)))!;
}

/**
 * The bound worker's keep-alive. Same shape as the MCP touch
 * (interactiveTouchScope): this account's own live interactive row, skipped
 * when anything (hook or MCP) already touched it this minute.
 */
export function boundWorkerTouchWhere(workerId: string, accountId: string | null, now: Date): SQL {
  return and(
    eq(workers.id, workerId),
    accountId === null ? undefined : eq(workers.accountId, accountId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    inArray(workers.status, [...INTERACTIVE_LIVE_STATUSES]),
    lt(workers.updatedAt, throttleCutoff(now)),
  )!;
}

/**
 * Bind: one row per (worker, presence), only into an open presence. The worker
 * is the primary key, so another presence's worker is never taken (DO NOTHING
 * returns no row). A presence bound before multi-claim keeps its worker through
 * the legacy `bound_worker_id` column, so that one is guarded too.
 */
export function bindInsertSql(presenceId: string, workerId: string, now: Date): SQL {
  return sql`
    INSERT INTO ${localSessionWorkers} ("worker_id", "local_session_id", "bound_at")
    SELECT ${workerId}::uuid, ls.id, ${now.toISOString()}::timestamptz
    FROM ${localSessions} ls
    WHERE ls.id = ${presenceId}::uuid AND ls."ended_at" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${localSessions} legacy
        WHERE legacy."bound_worker_id" = ${workerId}::uuid AND legacy.id <> ls.id
      )
    ON CONFLICT ("worker_id") DO NOTHING
    RETURNING "worker_id"`;
}

/**
 * Every worker a presence holds: its local_session_workers rows plus, for a
 * session bound before multi-claim, the legacy single `bound_worker_id`.
 */
const presenceColumns = {
  id: localSessions.id,
  endedAt: localSessions.endedAt,
  workerIds: sql<string[]>`ARRAY(
    SELECT held.w_id FROM (
      SELECT lsw."worker_id" AS w_id, lsw."bound_at" AS at FROM ${localSessionWorkers} lsw WHERE lsw."local_session_id" = ${localSessions.id}
      UNION
      SELECT ${localSessions.boundWorkerId}, ${localSessions.boundAt} WHERE ${localSessions.boundWorkerId} IS NOT NULL
    ) held ORDER BY held.at NULLS FIRST
  )`.as('worker_ids'),
};

/** The driver hands a uuid[] back as an array, or as Postgres' text form on some paths. */
function toIdArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
}

const toPresence = (r: { id: string; endedAt: Date | null; workerIds: unknown }): PresenceRow => ({
  id: r.id,
  endedAt: r.endedAt,
  workerIds: toIdArray(r.workerIds),
});

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  return e?.code === '23505' || e?.cause?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

export const drizzleLocalSessionStore: LocalSessionStore = {
  async upsertStart(i) {
    const [row] = await db
      .insert(localSessions)
      .values({
        ...('userId' in i.owner ? { userId: i.owner.userId } : { accountId: i.owner.accountId }),
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
        target: 'userId' in i.owner
          ? [localSessions.userId, localSessions.clientKind, localSessions.clientSessionHash]
          : [localSessions.accountId, localSessions.clientKind, localSessions.clientSessionHash],
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
    return toPresence(row);
  },
  async find(owner, clientKind, clientSessionHash) {
    const [row] = await db
      .select(presenceColumns)
      .from(localSessions)
      .where(and(
        'userId' in owner ? eq(localSessions.userId, owner.userId) : eq(localSessions.accountId, owner.accountId),
        eq(localSessions.clientKind, clientKind),
        eq(localSessions.clientSessionHash, clientSessionHash),
      ))
      .limit(1);
    return row ? toPresence(row) : null;
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
    const [w] = await db
      .select({
        id: workers.id,
        accountId: workers.accountId,
        runner: workers.runner,
        status: workers.status,
        taskId: workers.taskId,
        workspaceId: workers.workspaceId,
        ownerTeamId: accounts.teamId,
        taskContext: tasks.context,
      })
      .from(workers)
      .leftJoin(accounts, eq(accounts.id, workers.accountId))
      .leftJoin(tasks, eq(tasks.id, workers.taskId))
      .where(eq(workers.id, workerId))
      .limit(1);
    if (!w) return null;
    const { taskContext, ...rest } = w;
    const claimUser = (taskContext as Record<string, unknown> | null)?.[INTERACTIVE_CLAIM_USER_KEY];
    return { ...rest, ownerTeamId: rest.ownerTeamId ?? null, claimUserId: typeof claimUser === 'string' ? claimUser : null };
  },
  async bind(presenceId, workerId, workspaceId, now) {
    let won: boolean;
    try {
      const r = await db.execute(bindInsertSql(presenceId, workerId, now));
      won = ((r as { rows?: unknown[] }).rows ?? []).length > 0;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
    // The presence follows the workspace of its newest claim (a session in a
    // folder outside any workspace gets one from what it claimed).
    if (won) await db.update(localSessions).set({ workspaceId, lastSeenAt: now }).where(eq(localSessions.id, presenceId));
    return won;
  },
  async end(presenceId, reason, now) {
    const [row] = await db
      .update(localSessions)
      .set({ endedAt: now, endReason: reason, lastSeenAt: now })
      .where(and(eq(localSessions.id, presenceId), isNull(localSessions.endedAt)))
      .returning(presenceColumns);
    return row ? toPresence(row) : null;
  },
  async recordUsage(u) {
    const graceCutoff = new Date(u.now.getTime() - USAGE_GRACE_MS);
    const meta = {
      ...(u.modelUsage ? { modelUsage: u.modelUsage } : {}),
      totalUsage: u.totalUsage,
      localSessionUsage: u.effort,
    };
    const rows = await db
      .update(workers)
      .set({
        inputTokens: sql`GREATEST(${workers.inputTokens}, ${u.allInInputTokens})`,
        outputTokens: sql`GREATEST(${workers.outputTokens}, ${u.outputTokens})`,
        turns: sql`GREATEST(${workers.turns}, ${u.requests})`,
        ...(u.costUsd !== null ? { costUsd: sql`GREATEST(${workers.costUsd}, ${u.costUsd.toFixed(6)}::numeric)` } : {}),
        resultMeta: sql`COALESCE(${workers.resultMeta}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
      })
      .where(usageWriteWhere(u.workerId, graceCutoff))
      .returning({ id: workers.id });
    return rows.length > 0;
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
