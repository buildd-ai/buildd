import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts, localSessions, localSessionWorkers, tasks, teamMembers, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { INTERACTIVE_WORKER_BUSY_MAX_MS, INTERACTIVE_WORKER_IDLE_TTL_MS, INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';

/**
 * Liveness for interactive workers: the rows `claim_task` mints from an MCP
 * session (`workers.runner = 'mcp'`). See INTERACTIVE_WORKER_RUNNER in
 * packages/shared/src/runner-liveness.ts for why the runner rules cannot judge
 * them. Only a claim carrying the server-signed session marker is recorded as
 * 'mcp' (lib/interactive-session.ts); a client that merely sends
 * `runner: 'mcp'` gets a runner id and runner rules.
 *
 * The signal is `workers.updated_at`, the column every reaper rule already
 * reads. `update_progress` bumps it through PATCH /api/workers/[id]; this module
 * bumps it for every other MCP call (get_task, create_pr, list_tasks, ...), so
 * a session that is still talking to buildd keeps its claims.
 */

/** Statuses an interactive worker can be reaped from, and so can be kept alive in. */
export const INTERACTIVE_LIVE_STATUSES = ['idle', 'running', 'starting'] as const;

/**
 * Skip the write when the row was touched this recently. An MCP session makes
 * calls in bursts; one UPDATE a minute is plenty against a two-hour TTL.
 */
export const INTERACTIVE_TOUCH_THROTTLE_MS = 60_000;

/**
 * Task-context key the claim route stamps with the session user who made an
 * interactive claim (when the token carries one). OAuth sessions resolve to the
 * team's shared account, so the account alone cannot tell one member's session
 * from another's.
 */
export const INTERACTIVE_CLAIM_USER_KEY = 'interactiveClaimUserId' as const;

/**
 * Task-context key the claim route stamps with the MCP session that made an
 * interactive claim (the key of the session id /api/mcp minted; see
 * mintMcpSessionId in lib/interactive-session.ts). A bld_ key carries no
 * user, so without it every session on the key was one identity.
 */
export const INTERACTIVE_CLAIM_SESSION_KEY = 'interactiveClaimSessionKey' as const;

/** Only sessions that can hold claims keep them alive; a trigger token cannot claim. */
const LIVENESS_LEVELS = new Set(['worker', 'admin']);

/** A worker minted by an MCP `claim_task`, not by a runner. */
export function isInteractiveWorker(runner: string | null | undefined): boolean {
  return runner === INTERACTIVE_WORKER_RUNNER;
}

/** Runner-minted workers only. ANDed into every runner-liveness reaper rule. */
export function runnerWorkerOnly(): SQL {
  return ne(workers.runner, INTERACTIVE_WORKER_RUNNER);
}

/**
 * Which rows one MCP call keeps alive: the calling account's live interactive
 * workers, narrowed to the caller's own claims. With a session user, only the
 * ones that user claimed. With a session key, only the ones that session
 * claimed; with none (a client that does not echo the session id, the OAuth
 * route), only claims no keyed session made, so a keyless session never keeps
 * a keyed one's work alive. Never another account's rows, never a runner's.
 */
export function interactiveTouchScope(accountId: string, userId: string | null, now: Date, sessionKey: string | null = null): SQL {
  // Nested fragment so the column renders qualified inside the subquery.
  const workerTaskId = sql`${workers.taskId}`;
  return and(
    eq(workers.accountId, accountId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    inArray(workers.status, [...INTERACTIVE_LIVE_STATUSES]),
    lt(workers.updatedAt, new Date(now.getTime() - INTERACTIVE_TOUCH_THROTTLE_MS)),
    userId
      ? sql`EXISTS (
          SELECT 1 FROM ${tasks} t_claim
          WHERE t_claim.id = ${workerTaskId}
          AND t_claim.context->>${INTERACTIVE_CLAIM_USER_KEY} = ${userId}
        )`
      : undefined,
    sessionKey
      ? sql`EXISTS (
          SELECT 1 FROM ${tasks} t_sess
          WHERE t_sess.id = ${workerTaskId}
          AND t_sess.context->>${INTERACTIVE_CLAIM_SESSION_KEY} = ${sessionKey}
        )`
      : sql`NOT EXISTS (
          SELECT 1 FROM ${tasks} t_sess
          WHERE t_sess.id = ${workerTaskId}
          AND t_sess.context->>${INTERACTIVE_CLAIM_SESSION_KEY} IS NOT NULL
        )`,
  )!;
}

/**
 * The reaper's interactive arm: this account's interactive workers with no MCP
 * or hook activity for INTERACTIVE_WORKER_IDLE_TTL_MS. Account-scoped like the
 * runner rules; the account that claimed is the only one whose calls count.
 *
 * `updated_at` alone is not enough: MCP silence, client presence, a running
 * command and the claim are separate signals. A long command fires no hook
 * until it returns, so the client is alive and working with nothing to say; a
 * `/clear` or a missed bind leaves a live client whose presence does not hold
 * the claim. So a worker is also kept while
 *  - an open presence holding it (the buildd plugin's, lib/local-session.ts)
 *    was heard from within the TTL, or marked itself inside a turn
 *    (`busy_since`) and was heard from within INTERACTIVE_WORKER_BUSY_MAX_MS; or
 *  - its own last activity is within INTERACTIVE_WORKER_BUSY_MAX_MS and an
 *    open presence of its claimant, in its workspace, was heard from within
 *    the TTL (the person's client is alive there, it just is not holding it).
 * INTERACTIVE_WORKER_BUSY_MAX_MS is the hard backstop either way: a client that
 * died mid-turn never clears its mark, and a person's open session never keeps
 * an abandoned claim forever.
 */
export function interactiveAbandonedScope(accountId: string, now: Date): SQL {
  const idleCutoff = new Date(now.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS);
  return and(
    eq(workers.accountId, accountId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    inArray(workers.status, [...INTERACTIVE_LIVE_STATUSES]),
    lt(workers.updatedAt, idleCutoff),
    sql`NOT ${heldByLivePresence(now)}`,
    sql`NOT ${claimantPresenceAlive(now)}`,
  )!;
}

/**
 * The claimant's client is alive in the worker's workspace, though no presence
 * of it holds the worker, and the worker itself was active within the backstop.
 * Claimant: a presence of the account that claimed, or a person's presence
 * (presence token) of whoever the claim recorded or, when it recorded nobody,
 * of a member of the claiming account's team: the same rule bind uses.
 */
export function claimantPresenceAlive(now: Date): SQL {
  const idleCutoff = new Date(now.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS).toISOString();
  const backstop = new Date(now.getTime() - INTERACTIVE_WORKER_BUSY_MAX_MS).toISOString();
  const w = { accountId: sql`${workers.accountId}`, workspaceId: sql`${workers.workspaceId}`, taskId: sql`${workers.taskId}`, updatedAt: sql`${workers.updatedAt}` };
  return sql`(
    ${w.updatedAt} > ${backstop}::timestamptz
    AND EXISTS (
      SELECT 1 FROM ${localSessions} ls_mine
      WHERE ls_mine."ended_at" IS NULL
      AND ls_mine."workspace_id" = ${w.workspaceId}
      AND ls_mine."last_seen_at" > ${idleCutoff}::timestamptz
      AND (
        ls_mine."account_id" = ${w.accountId}
        OR (
          ls_mine."user_id" IS NOT NULL
          AND COALESCE(
            (SELECT t_who.context->>${INTERACTIVE_CLAIM_USER_KEY} FROM ${tasks} t_who WHERE t_who.id = ${w.taskId}),
            ls_mine."user_id"::text
          ) = ls_mine."user_id"::text
          AND EXISTS (
            SELECT 1 FROM ${teamMembers} tm_mine
            JOIN ${accounts} a_mine ON a_mine.team_id = tm_mine."team_id"
            WHERE a_mine.id = ${w.accountId} AND tm_mine."user_id" = ls_mine."user_id"
          )
        )
      )
    )
  )`;
}

/** An open presence holding this worker that still counts as its client being alive. */
export function heldByLivePresence(now: Date): SQL {
  const idleCutoff = new Date(now.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS).toISOString();
  const busyCutoff = new Date(now.getTime() - INTERACTIVE_WORKER_BUSY_MAX_MS).toISOString();
  // Nested fragment so the column renders qualified inside the subquery.
  const workerId = sql`${workers.id}`;
  return sql`EXISTS (
    SELECT 1 FROM ${localSessions} ls_hold
    WHERE ls_hold."ended_at" IS NULL
    AND (
      ls_hold."bound_worker_id" = ${workerId}
      OR EXISTS (
        SELECT 1 FROM ${localSessionWorkers} lsw_hold
        WHERE lsw_hold."worker_id" = ${workerId} AND lsw_hold."local_session_id" = ls_hold.id
      )
    )
    AND (
      ls_hold."last_seen_at" > ${idleCutoff}::timestamptz
      OR (ls_hold."busy_since" IS NOT NULL AND ls_hold."last_seen_at" > ${busyCutoff}::timestamptz)
    )
  )`;
}

/** Per-instance memo: (account, user, session) → last touch. Saves the round trip on bursts. */
const lastTouch = new Map<string, number>();
const MEMO_MAX = 5_000;

/** Test hook. */
export function resetInteractiveTouchMemo(): void {
  lastTouch.clear();
}

/**
 * Record MCP activity for the caller's interactive workers.
 * Best-effort: a failed touch must never fail the MCP call it rides on.
 */
export async function touchInteractiveWorkers(opts: {
  accountId: string | null | undefined;
  userId?: string | null;
  sessionKey?: string | null;
  now?: Date;
}): Promise<void> {
  const { accountId } = opts;
  if (!accountId) return;
  const userId = opts.userId ?? null;
  const sessionKey = opts.sessionKey ?? null;
  const now = opts.now ?? new Date();
  const key = `${accountId}:${userId ?? '*'}:${sessionKey ?? '*'}`;
  const prev = lastTouch.get(key);
  if (prev !== undefined && now.getTime() - prev < INTERACTIVE_TOUCH_THROTTLE_MS) return;
  if (lastTouch.size >= MEMO_MAX) lastTouch.clear();
  lastTouch.set(key, now.getTime());
  try {
    await db.update(workers)
      .set({ updatedAt: now })
      .where(interactiveTouchScope(accountId, userId, now, sessionKey));
  } catch (err) {
    console.warn(`[mcp] interactive worker liveness touch failed for account ${accountId}:`, err);
  }
  // The touch above is exactly what keeps a finished task's worker alive past
  // the idle TTL: the session stays open and keeps calling. So the same call
  // detaches any of the team's interactive workers whose task already ended.
  // Lazy import keeps this module light for the reaper that imports it.
  try {
    const { detachInteractiveWorkersOfEndedTasks } = await import('@/lib/interactive-detach');
    await detachInteractiveWorkersOfEndedTasks({ accountId, now });
  } catch (err) {
    console.warn(`[mcp] ended-task detach failed for account ${accountId}:`, err);
  }
}

/**
 * What the MCP routes call on every authenticated request: gate on the session
 * level, then run the touch after the response is sent so the MCP call never
 * waits on it. Outside a request scope (tests, scripts) it runs immediately.
 */
export function scheduleInteractiveTouch(opts: {
  accountId: string | null | undefined;
  userId?: string | null;
  sessionKey?: string | null;
  level: string | null | undefined;
}): void {
  if (!opts.accountId || !opts.level || !LIVENESS_LEVELS.has(opts.level)) return;
  const run = () => touchInteractiveWorkers({ accountId: opts.accountId, userId: opts.userId ?? null, sessionKey: opts.sessionKey ?? null });
  try {
    after(run);
  } catch {
    void run();
  }
}
