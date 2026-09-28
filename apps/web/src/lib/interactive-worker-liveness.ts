import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { and, eq, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { INTERACTIVE_WORKER_IDLE_TTL_MS, INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';

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
 * workers and, when the session carries a user, only the ones that user
 * claimed. A token with no user (a bld_ key) is one identity, so it covers the
 * account's interactive workers. Never another account's rows, never a runner's.
 */
export function interactiveTouchScope(accountId: string, userId: string | null, now: Date): SQL {
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
  )!;
}

/**
 * The reaper's interactive arm: this account's interactive workers with no MCP
 * activity for INTERACTIVE_WORKER_IDLE_TTL_MS. Account-scoped like the runner
 * rules; the account that claimed is the only one whose calls count.
 */
export function interactiveAbandonedScope(accountId: string, now: Date): SQL {
  return and(
    eq(workers.accountId, accountId),
    eq(workers.runner, INTERACTIVE_WORKER_RUNNER),
    inArray(workers.status, [...INTERACTIVE_LIVE_STATUSES]),
    lt(workers.updatedAt, new Date(now.getTime() - INTERACTIVE_WORKER_IDLE_TTL_MS)),
  )!;
}

/** Per-instance memo: (account, user) → last touch. Saves the round trip on bursts. */
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
  now?: Date;
}): Promise<void> {
  const { accountId } = opts;
  if (!accountId) return;
  const userId = opts.userId ?? null;
  const now = opts.now ?? new Date();
  const key = `${accountId}:${userId ?? '*'}`;
  const prev = lastTouch.get(key);
  if (prev !== undefined && now.getTime() - prev < INTERACTIVE_TOUCH_THROTTLE_MS) return;
  if (lastTouch.size >= MEMO_MAX) lastTouch.clear();
  lastTouch.set(key, now.getTime());
  try {
    await db.update(workers)
      .set({ updatedAt: now })
      .where(interactiveTouchScope(accountId, userId, now));
  } catch (err) {
    console.warn(`[mcp] interactive worker liveness touch failed for account ${accountId}:`, err);
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
  level: string | null | undefined;
}): void {
  if (!opts.accountId || !opts.level || !LIVENESS_LEVELS.has(opts.level)) return;
  const run = () => touchInteractiveWorkers({ accountId: opts.accountId, userId: opts.userId ?? null });
  try {
    after(run);
  } catch {
    void run();
  }
}
