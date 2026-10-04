/**
 * Durable dispatch intent — the storage half of the dispatch authority.
 *
 * A row in `task_dispatch_outbox` means "something changed that may make this
 * task runnable; re-evaluate it now". It never means "run it": the consumer
 * (apps/web/src/lib/dispatch-authority.ts) only nudges runners and webhooks,
 * and the claim route decides. So delivery is at-least-once and a duplicate is
 * harmless — the claim is the exactly-once step.
 *
 * Every intent is written in the same transaction as the state change that
 * caused it:
 *  - transitions INTO `pending` (insert, requeue, reassign, a new `startAt`)
 *    are written by the `task_dispatch_outbox_on_pending` trigger
 *    (drizzle/0231), so no code path can make a task pending without one;
 *  - transitions that keep a task pending but unblock it (a dependency
 *    resolving, a path claim releasing) embed `outboxInsertSelectSql` in the
 *    statement or `db.batch` that makes them.
 *
 * Pending rows coalesce on (task_id, dedupe_key): a second wake for the same
 * task before the first is delivered appends its cause and keeps the earlier
 * due time. A row already being delivered is not reused, so a state change
 * that lands mid-delivery still gets its own wake.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';

/** Why a task may have become runnable. The vocabulary is the contract; add, never rename. */
export const DISPATCH_CAUSES = [
  // Written by the trigger.
  'task.created',
  'task.requeued',
  'start_at.reached',
  // Written by the app, usually coalescing into a trigger row with a more specific reason.
  'dependency.satisfied',
  'review.fix_requested',
  'ci.retry',
  'path_claim.released',
  'budget.available',
  'task.reassigned',
  'manual.start',
  'plan_child.ready',
  'task.unblocked',
  'credential.restored',
] as const;
export type DispatchCause = (typeof DISPATCH_CAUSES)[number];

export function isDispatchCause(v: unknown): v is DispatchCause {
  return typeof v === 'string' && (DISPATCH_CAUSES as readonly string[]).includes(v);
}

export interface EnqueueDispatchInput {
  taskId: string;
  cause: DispatchCause;
  /** Earliest delivery. Omit for "now". */
  notBefore?: Date;
  /**
   * Coalescing key among pending rows for this task. Defaults to `now` for an
   * immediate wake, and to the due time for a scheduled one, matching the
   * trigger, so app and trigger rows for the same moment merge.
   */
  dedupeKey?: string;
  /** Delivery hints only (e.g. targetLocalUiUrl) — never task state. */
  metadata?: Record<string, unknown>;
}

export function defaultDedupeKey(notBefore: Date | undefined, nowMs: number = Date.now()): string {
  return notBefore && notBefore.getTime() > nowMs ? `start_at:${notBefore.getTime()}` : 'now';
}

const ON_CONFLICT_COALESCE = sql.raw(`ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
DO UPDATE SET
  causes = task_dispatch_outbox.causes || jsonb_build_array(EXCLUDED.cause),
  not_before = LEAST(task_dispatch_outbox.not_before, EXCLUDED.not_before),
  metadata = COALESCE(task_dispatch_outbox.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
  updated_at = now()`);

/**
 * One intent as a single statement, for a `db.batch([...mutation, this])`.
 * The workspace is read from the task row, so the statement inserts nothing
 * when the task is gone. It does not check status: a wake for a task that is
 * no longer pending is skipped at delivery, which is cheaper than racing it.
 */
export function enqueueDispatchSql(input: EnqueueDispatchInput): SQL {
  const args = {
    taskId: input.taskId,
    cause: input.cause,
    notBefore: input.notBefore?.toISOString() ?? null,
    dedupeKey: input.dedupeKey ?? defaultDedupeKey(input.notBefore),
    metadata: input.metadata ?? null,
  };
  return sql`-- dispatch_outbox:enqueue
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a)
INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, not_before, dedupe_key, metadata)
SELECT t.workspace_id, t.id, a->>'cause', jsonb_build_array(a->>'cause'),
  COALESCE((a->>'notBefore')::timestamptz, now()), a->>'dedupeKey', a->'metadata'
FROM args JOIN tasks t ON t.id = (a->>'taskId')::uuid
${ON_CONFLICT_COALESCE}`;
}

/**
 * Raw SQL text for a data-modifying CTE that wakes every *pending* task in a
 * sibling CTE. `source` must expose `waiting_task_id`. Text, not a fragment,
 * because the path-claim release statements are already one `sql` template
 * and this is spliced inside them; the cause is from the closed vocabulary, so
 * nothing caller-controlled reaches the text.
 *
 *   rel AS (...), woken AS (... RETURNING w.waiting_task_id),
 *   ${outboxInsertSelectSql('woken', 'path_claim.released')}
 */
export function outboxInsertSelectSql(source: string, cause: DispatchCause, cteName = 'wake'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(source) || !/^[a-z_][a-z0-9_]*$/.test(cteName)) {
    throw new Error(`outboxInsertSelectSql: bad identifier ${source}/${cteName}`);
  }
  if (!isDispatchCause(cause)) throw new Error(`outboxInsertSelectSql: unknown cause ${cause}`);
  return sql.raw(`${cteName} AS (
  INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, dedupe_key)
  SELECT DISTINCT t.workspace_id, t.id, '${cause}', jsonb_build_array('${cause}'), 'now'
  FROM ${source} s JOIN tasks t ON t.id = s.waiting_task_id
  WHERE t.status = 'pending'
  ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
  DO UPDATE SET causes = task_dispatch_outbox.causes || jsonb_build_array(EXCLUDED.cause), updated_at = now()
  RETURNING task_id
)`);
}

/** Standalone enqueue. Prefer batching with the mutation; this is for state that is already committed. */
export async function enqueueTaskDispatch(input: EnqueueDispatchInput): Promise<void> {
  await db.execute(enqueueDispatchSql(input));
}

export interface ClaimedDispatch {
  id: string;
  workspaceId: string;
  taskId: string;
  cause: DispatchCause;
  causes: DispatchCause[];
  notBefore: Date;
  attemptCount: number;
  metadata: Record<string, unknown> | null;
}

/**
 * A row left `delivering` this long is presumed to belong to a consumer that
 * died mid-delivery and is taken again. Longer than one webhook timeout
 * (10s) plus the Pusher call, short enough that a crashed function costs
 * one gated tick, not an hour.
 */
export const DELIVERY_LEASE_MS = 120_000;

/**
 * Atomically take up to `limit` due rows for delivery. SKIP LOCKED plus the
 * status guard on the outer UPDATE mean two concurrent drains never take the
 * same row; a re-delivery only happens after a lease expires.
 */
export function claimDueDispatchesSql(limit: number, nowIso?: string): SQL {
  const args = { limit, leaseMs: DELIVERY_LEASE_MS, now: nowIso ?? null };
  return sql`-- dispatch_outbox:claim_due
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a),
clock AS (SELECT COALESCE((a->>'now')::timestamptz, now()) AS now FROM args),
due AS (
  SELECT o.id FROM task_dispatch_outbox o, clock c
  WHERE (o.status = 'pending' AND o.not_before <= c.now)
     OR (o.status = 'delivering' AND o.last_attempt_at < c.now - ((SELECT a->>'leaseMs' FROM args)::int * interval '1 millisecond'))
  ORDER BY o.not_before
  LIMIT (SELECT (a->>'limit')::int FROM args)
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE task_dispatch_outbox o
SET status = 'delivering', attempt_count = o.attempt_count + 1, last_attempt_at = now(), updated_at = now()
FROM due
WHERE o.id = due.id AND o.status IN ('pending', 'delivering')
RETURNING o.id, o.workspace_id, o.task_id, o.cause, o.causes, o.not_before, o.attempt_count, o.metadata`;
}

type RawRow = Record<string, unknown>;
const rowsOf = (r: unknown): RawRow[] => ((r as { rows?: RawRow[] })?.rows ?? []);

export async function claimDueDispatches(limit: number): Promise<ClaimedDispatch[]> {
  const result = await db.execute(claimDueDispatchesSql(limit));
  return rowsOf(result).map(r => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    taskId: String(r.task_id),
    cause: r.cause as DispatchCause,
    causes: (Array.isArray(r.causes) ? r.causes : typeof r.causes === 'string' ? JSON.parse(r.causes) : []) as DispatchCause[],
    notBefore: new Date(r.not_before as string),
    attemptCount: Number(r.attempt_count),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
  }));
}

/** Max delivery attempts before a row is parked as `failed` for reconciliation to report. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Backoff before attempt `n + 1`: 15s doubling, capped at 30 minutes. */
export function retryDelayMs(attemptCount: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attemptCount - 1), 30 * 60_000);
}

export async function markDispatchDelivered(id: string, via: string): Promise<void> {
  await db.execute(sql`-- dispatch_outbox:delivered
UPDATE task_dispatch_outbox SET status = 'delivered', delivered_at = now(), delivered_via = ${via}, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering'`);
}

/**
 * Put a failed delivery back for a later attempt, or park it as `failed`
 * after MAX_DELIVERY_ATTEMPTS. Back to `pending` only if no other pending row
 * for the task already exists, since the pending dedupe index allows one;
 * otherwise this attempt's causes fold into that row and this one is closed.
 */
export async function markDispatchFailed(id: string, attemptCount: number, error: string): Promise<'retrying' | 'failed'> {
  const err = error.slice(0, 500);
  if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    await db.execute(sql`-- dispatch_outbox:failed
UPDATE task_dispatch_outbox SET status = 'failed', last_error = ${err}, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering'`);
    return 'failed';
  }
  const notBefore = new Date(Date.now() + retryDelayMs(attemptCount)).toISOString();
  await db.execute(sql`-- dispatch_outbox:retry
WITH me AS (SELECT * FROM task_dispatch_outbox WHERE id = ${id}::uuid AND status = 'delivering'),
merged AS (
  UPDATE task_dispatch_outbox o
  SET causes = o.causes || me.causes, not_before = LEAST(o.not_before, ${notBefore}::timestamptz), updated_at = now()
  FROM me
  WHERE o.task_id = me.task_id AND o.dedupe_key = me.dedupe_key AND o.status = 'pending'
  RETURNING o.id
)
UPDATE task_dispatch_outbox o
SET status = CASE WHEN EXISTS (SELECT 1 FROM merged) THEN 'delivered' ELSE 'pending' END,
    delivered_via = CASE WHEN EXISTS (SELECT 1 FROM merged) THEN 'merged_into_pending' ELSE o.delivered_via END,
    not_before = ${notBefore}::timestamptz, last_error = ${err}, updated_at = now()
FROM me WHERE o.id = me.id`);
  return 'retrying';
}

/** Due times of pending rows still in the future, for the timer index (Redis). */
export async function listFutureDispatches(limit = 500): Promise<Array<{ id: string; notBefore: Date }>> {
  const result = await db.execute(sql`-- dispatch_outbox:future
SELECT id, not_before FROM task_dispatch_outbox
WHERE status = 'pending' AND not_before > now()
ORDER BY not_before LIMIT ${limit}`);
  return rowsOf(result).map(r => ({ id: String(r.id), notBefore: new Date(r.not_before as string) }));
}

/** Everything a reconciler needs to see: due-but-undelivered, stuck, and failed rows. */
export async function dispatchOutboxHealth(): Promise<{ overdue: number; stuck: number; failed: number }> {
  const result = await db.execute(sql`-- dispatch_outbox:health
SELECT
  count(*) FILTER (WHERE status = 'pending' AND not_before < now() - interval '5 minutes') AS overdue,
  count(*) FILTER (WHERE status = 'delivering' AND last_attempt_at < now() - interval '5 minutes') AS stuck,
  count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '1 day') AS failed
FROM task_dispatch_outbox`);
  const r = rowsOf(result)[0] ?? {};
  return { overdue: Number(r.overdue ?? 0), stuck: Number(r.stuck ?? 0), failed: Number(r.failed ?? 0) };
}

/** Delivered/failed rows older than this are pruned by the task-archive sweep. */
export const OUTBOX_RETENTION_DAYS = 14;

export async function pruneDispatchOutbox(): Promise<number> {
  const result = await db.execute(sql`-- dispatch_outbox:prune
WITH gone AS (
  DELETE FROM task_dispatch_outbox
  WHERE status IN ('delivered', 'failed') AND updated_at < now() - make_interval(days => ${OUTBOX_RETENTION_DAYS})
  RETURNING 1
) SELECT count(*) AS n FROM gone`);
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/** The intent trail for one task, oldest first — the "why did it (not) start" read. */
export async function dispatchHistoryForTask(taskId: string, limit = 50) {
  const result = await db.execute(sql`-- dispatch_outbox:history
SELECT id, cause, causes, status, not_before, attempt_count, delivered_at, delivered_via, last_error, created_at
FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid ORDER BY created_at LIMIT ${limit}`);
  return rowsOf(result);
}
