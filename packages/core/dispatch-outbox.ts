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
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { db } from './db';
import { MAX_DELIVERY_ATTEMPTS, retryDelayMs } from '@buildd/dispatch-contract';

/**
 * What kind of delivery an intent is. Buildd's policy decides what should
 * happen; the dispatcher only delivers it, through the adapter chain for its
 * kind (apps/web/src/lib/dispatch-adapters.ts). Durable dispatch does not
 * imply autonomous execution: only `work_execution` wakes a runner.
 *
 *  - work_execution  re-evaluate the task for an autonomous runner (the claim decides)
 *  - human_action    a small blocking human step: approval, choice, credential, visual check
 *  - notification    an informational nudge
 *  - incident        an urgent operational signal
 *  - external_work   materialize durable work in an external tracker
 *
 * A kind with no adapter registered is parked as `failed` (visible to the
 * floor tick's health report), never silently closed.
 */
export const DISPATCH_INTENTS = ['work_execution', 'human_action', 'notification', 'incident', 'external_work'] as const;
export type DispatchIntent = (typeof DISPATCH_INTENTS)[number];

export function isDispatchIntent(v: unknown): v is DispatchIntent {
  return typeof v === 'string' && (DISPATCH_INTENTS as readonly string[]).includes(v);
}

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
  'conflict.retry',
  'path_claim.released',
  'budget.available',
  'task.reassigned',
  'manual.start',
  'plan_child.ready',
  // A plan child filed with dependencies: written at insert, not yet runnable.
  'plan_child.created',
  'task.unblocked',
  'credential.restored',
  'mission.released',
  // A worker going terminal freed a concurrency slot the claim route denied
  // this task for; see apps/web/src/lib/capacity-freed-wake.ts.
  'capacity.freed',
  // A non-work intent Buildd's policy raised (human_action, notification, …).
  'policy.requested',
] as const;
export type DispatchCause = (typeof DISPATCH_CAUSES)[number];

export function isDispatchCause(v: unknown): v is DispatchCause {
  return typeof v === 'string' && (DISPATCH_CAUSES as readonly string[]).includes(v);
}

/**
 * Most specific first. A coalesced row carries every cause that landed while
 * it was pending; adapters route on the first match here, because a
 * trigger-written `task.created` plus an app-written `plan_child.ready` is a
 * plan child, not a plain new task.
 */
const CAUSE_PRECEDENCE: DispatchCause[] = [
  'plan_child.ready',
  'review.fix_requested',
  'ci.retry',
  'conflict.retry',
  'task.reassigned',
  'manual.start',
  'dependency.satisfied',
  'path_claim.released',
  'budget.available',
  'credential.restored',
  'mission.released',
  'capacity.freed',
  'task.unblocked',
  'start_at.reached',
  'task.requeued',
  // Below the unblock causes: a dependent plan child that later becomes ready
  // is delivered as dependency.satisfied, as it always was.
  'plan_child.created',
  'task.created',
];

export function primaryCause(causes: readonly string[], fallback: DispatchCause): DispatchCause {
  for (const c of CAUSE_PRECEDENCE) if (causes.includes(c)) return c;
  return fallback;
}

export interface EnqueueDispatchInput {
  taskId: string;
  /** Defaults to `work_execution`, the only kind the trigger writes. */
  intent?: DispatchIntent;
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

export function defaultDedupeKey(
  notBefore: Date | undefined,
  nowMs: number = Date.now(),
  intent: DispatchIntent = 'work_execution',
): string {
  const key = notBefore && notBefore.getTime() > nowMs ? `start_at:${notBefore.getTime()}` : 'now';
  // Work keys stay bare so app wakes coalesce with the trigger's rows; any
  // other kind is namespaced so it never folds into (or absorbs) a runner wake.
  return intent === 'work_execution' ? key : `${intent}:${key}`;
}

const ON_CONFLICT_COALESCE = sql.raw(`ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
DO UPDATE SET
  causes = task_dispatch_outbox.causes || jsonb_build_array(EXCLUDED.cause),
  not_before = LEAST(task_dispatch_outbox.not_before, EXCLUDED.not_before),
  metadata = CASE WHEN jsonb_typeof(task_dispatch_outbox.metadata) = 'object' THEN task_dispatch_outbox.metadata ELSE '{}'::jsonb END
    || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
  updated_at = now()`);

/**
 * One intent as a single statement, for a `db.batch([...mutation, this])`.
 * The workspace is read from the task row, so the statement inserts nothing
 * when the task is gone. It does not check status: a wake for a task that is
 * no longer pending is skipped at delivery, which is cheaper than racing it.
 */
export function enqueueDispatchSql(input: EnqueueDispatchInput): SQL {
  const intent = input.intent ?? 'work_execution';
  if (!isDispatchIntent(intent)) throw new Error(`enqueueDispatchSql: unknown intent ${intent}`);
  const args = {
    taskId: input.taskId,
    intent,
    cause: input.cause,
    notBefore: input.notBefore?.toISOString() ?? null,
    dedupeKey: input.dedupeKey ?? defaultDedupeKey(input.notBefore, Date.now(), intent),
    metadata: input.metadata ?? null,
  };
  return sql`-- dispatch_outbox:enqueue
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a)
INSERT INTO task_dispatch_outbox (workspace_id, task_id, intent, cause, causes, not_before, dedupe_key, metadata)
SELECT t.workspace_id, t.id, a->>'intent', a->>'cause', jsonb_build_array(a->>'cause'),
  COALESCE((a->>'notBefore')::timestamptz, now()), a->>'dedupeKey', NULLIF(a->'metadata', 'null'::jsonb)
FROM args JOIN tasks t ON t.id = (a->>'taskId')::uuid
${ON_CONFLICT_COALESCE}`;
}

/**
 * A data-modifying CTE that wakes every *pending* task in a sibling CTE,
 * spliced into the statement that makes them runnable (the path-claim release
 * statements). `source` must expose `waiting_task_id`; both names are quoted
 * identifiers and the cause is a bound parameter.
 *
 *   rel AS (...), woken AS (... RETURNING w.waiting_task_id),
 *   ${outboxInsertSelectSql('woken', 'path_claim.released')}
 */
export function outboxInsertSelectSql(source: string, cause: DispatchCause, cteName = 'wake'): SQL {
  if (!isDispatchCause(cause)) throw new Error(`outboxInsertSelectSql: unknown cause ${cause}`);
  return sql`${sql.identifier(cteName)} AS (
  INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, dedupe_key)
  SELECT DISTINCT t.workspace_id, t.id, ${cause}::text, jsonb_build_array(${cause}::text), 'now'
  FROM ${sql.identifier(source)} s JOIN tasks t ON t.id = s.waiting_task_id
  WHERE t.status = 'pending'
  ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
  DO UPDATE SET causes = task_dispatch_outbox.causes || jsonb_build_array(EXCLUDED.cause),
    not_before = LEAST(task_dispatch_outbox.not_before, EXCLUDED.not_before), updated_at = now()
  RETURNING task_id
)`;
}

/**
 * What the statement making a task pending tells the tasks trigger
 * (migration 0233): the specific cause, delivery hints, or that the
 * transition is not new runnable state at all (`suppress`).
 */
export type DispatchHint =
  | { cause?: DispatchCause; metadata?: Record<string, unknown> }
  | { suppress: 'claim_rollback' };

/** Transaction-local hint for the trigger; only meaningful in the same db.batch as the write. */
export function dispatchHintSql(hint: DispatchHint): SQL {
  if ('cause' in hint && hint.cause !== undefined && !isDispatchCause(hint.cause)) {
    throw new Error(`dispatchHintSql: unknown cause ${hint.cause}`);
  }
  return sql`SELECT set_config('buildd.dispatch_hint', ${JSON.stringify(hint)}, true)`;
}

/**
 * Run `write` with `hint` visible to the tasks trigger, as one transaction.
 * Errors are re-wrapped to the shape a single drizzle query throws
 * (`DrizzleQueryError` with the Postgres error as `.cause`): a batch throws
 * the raw NeonDbError, and callers match on `error.cause.code`.
 */
export async function withDispatchHint<T>(hint: DispatchHint, write: { toSQL?: unknown } & PromiseLike<T>): Promise<T> {
  try {
    const [, result] = await db.batch([db.execute(dispatchHintSql(hint)), write as never]);
    return result as T;
  } catch (err) {
    if (err instanceof DrizzleQueryError) throw err;
    throw new DrizzleQueryError('withDispatchHint batch', [], err as Error);
  }
}

/** Standalone enqueue. Prefer batching with the mutation; this is for state that is already committed. */
export async function enqueueTaskDispatch(input: EnqueueDispatchInput): Promise<void> {
  await db.execute(enqueueDispatchSql(input));
}

export interface ClaimedDispatch {
  id: string;
  intent: DispatchIntent;
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
 * How long an unacked work row of a `dispatch`-transport workspace is left to
 * the publish path (lib/dispatch-transport.ts) before the in-app drain takes
 * it as the fallback. Long enough for a publish retry after a Worker blip,
 * short enough that a Dispatch outage costs minutes, not the wake.
 */
export const PUBLISH_GRACE_MS = 120_000;

/**
 * Metadata key the repair floor stamps (an ISO time) when it takes a row back
 * from Dispatch (dispatch-handoff.ts fallBackToInAppSql): the Worker lost it,
 * was unreachable, or held it past the ceiling. A marked row belongs to the
 * in-app drain for the rest of its life: it is never published again, the
 * publish grace never holds it back, and it is not counted `unacked`.
 */
export const DISPATCH_FALLBACK_KEY = 'dispatchFallbackAt';

/** SQL predicate: row `o` carries the fallback mark. Null-safe on any metadata shape. */
export const FALLEN_BACK_SQL = `COALESCE(jsonb_typeof(o.metadata) = 'object' AND o.metadata ? '${DISPATCH_FALLBACK_KEY}', false)`;

/**
 * Atomically take up to `limit` due rows for delivery. SKIP LOCKED plus the
 * status guard on the outer UPDATE mean two concurrent drains never take the
 * same row; a re-delivery only happens after a lease expires.
 *
 * Dispatch transport: a `handed_off` row is never taken (Dispatch owns its
 * delivery lifecycle). An unacked work row of a `dispatch` workspace younger
 * than PUBLISH_GRACE_MS is left to the publish path, so the in-app drain is
 * the fallback for rows Dispatch never acked, not a racer. Every other row —
 * all of an `in_app` or `shadow` workspace, and every non-work intent, which
 * is never published — is taken exactly as before.
 *
 * `graceMs` is 0 when publishing is not configured (no Worker): nothing will
 * ever ack those rows, so waiting for one would only delay every wake.
 */
export function claimDueDispatchesSql(limit: number, nowIso?: string, graceMs: number = PUBLISH_GRACE_MS): SQL {
  const args = { limit, leaseMs: DELIVERY_LEASE_MS, graceMs, now: nowIso ?? null };
  return sql`-- dispatch_outbox:claim_due
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a),
clock AS (SELECT COALESCE((a->>'now')::timestamptz, now()) AS now FROM args),
due AS (
  SELECT o.id FROM task_dispatch_outbox o, clock c
  WHERE (o.status = 'pending' AND o.not_before <= c.now
         AND NOT (o.handed_off_at IS NULL AND o.intent = 'work_execution' AND NOT ${sql.raw(FALLEN_BACK_SQL)}
           AND o.created_at > c.now - ((SELECT a->>'graceMs' FROM args)::int * interval '1 millisecond')
           AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = o.workspace_id AND w.dispatch_transport = 'dispatch')))
     OR (o.status = 'delivering' AND o.last_attempt_at < c.now - ((SELECT a->>'leaseMs' FROM args)::int * interval '1 millisecond'))
  ORDER BY o.not_before
  LIMIT (SELECT (a->>'limit')::int FROM args)
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE task_dispatch_outbox o
SET status = 'delivering', attempt_count = o.attempt_count + 1, last_attempt_at = now(), updated_at = now()
FROM due
WHERE o.id = due.id AND o.status IN ('pending', 'delivering')
RETURNING o.id, o.intent, o.workspace_id, o.task_id, o.cause, o.causes, o.not_before, o.attempt_count, o.metadata`;
}

type RawRow = Record<string, unknown>;
const rowsOf = (r: unknown): RawRow[] => ((r as { rows?: RawRow[] })?.rows ?? []);

export async function claimDueDispatches(limit: number, opts: { graceMs?: number } = {}): Promise<ClaimedDispatch[]> {
  const result = await db.execute(claimDueDispatchesSql(limit, undefined, opts.graceMs));
  return rowsOf(result).map(r => ({
    id: String(r.id),
    intent: (r.intent ?? 'work_execution') as DispatchIntent,
    workspaceId: String(r.workspace_id),
    taskId: String(r.task_id),
    cause: r.cause as DispatchCause,
    causes: (Array.isArray(r.causes) ? r.causes : typeof r.causes === 'string' ? JSON.parse(r.causes) : []) as DispatchCause[],
    notBefore: new Date(r.not_before as string),
    attemptCount: Number(r.attempt_count),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
  }));
}

// Max attempts before a row is parked as `failed`, and the backoff before
// attempt `n + 1`. Shared with the Dispatch transport so a workspace's retry
// cadence is the same on either side of the cutover.
export { MAX_DELIVERY_ATTEMPTS, retryDelayMs };

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
  SET causes = o.causes || me.causes, not_before = LEAST(o.not_before, ${notBefore}::timestamptz),
    attempt_count = GREATEST(o.attempt_count, me.attempt_count), updated_at = now()
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

/**
 * Future work wakes within `aheadMs` whose workspace webhook opted into
 * `task.scheduled` and that have not had a notice for their current due time.
 * The notice lets a push consumer (the cloud runner) set its own timer; the
 * row is still delivered normally when due, which is the backstop.
 */
export async function listScheduledNoticesDue(aheadMs: number, limit = 50): Promise<Array<{ id: string; taskId: string; notBefore: Date; cause: DispatchCause; causes: DispatchCause[] }>> {
  const result = await db.execute(sql`-- dispatch_outbox:scheduled_notices
SELECT o.id, o.task_id, o.not_before, o.cause, o.causes FROM task_dispatch_outbox o
JOIN workspaces w ON w.id = o.workspace_id
WHERE o.status = 'pending' AND o.intent = 'work_execution'
  AND o.not_before > now() AND o.not_before <= now() + (${aheadMs}::bigint * interval '1 millisecond')
  AND jsonb_typeof(w.webhook_config->'events') = 'array' AND w.webhook_config->'events' ? 'task.scheduled'
  AND (o.metadata->>'scheduledNoticeMs') IS DISTINCT FROM floor(extract(epoch FROM o.not_before) * 1000)::bigint::text
ORDER BY o.not_before LIMIT ${limit}`);
  return rowsOf(result).map(r => ({
    id: String(r.id), taskId: String(r.task_id), notBefore: new Date(r.not_before as string),
    cause: r.cause as DispatchCause,
    causes: (Array.isArray(r.causes) ? r.causes : typeof r.causes === 'string' ? JSON.parse(r.causes) : []) as DispatchCause[],
  }));
}

/** Record that the notice for this row's current due time went out. */
export async function markScheduledNoticeSent(id: string, notBefore: Date): Promise<void> {
  await db.execute(sql`-- dispatch_outbox:scheduled_notice_sent
UPDATE task_dispatch_outbox
SET metadata = CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
  || jsonb_build_object('scheduledNoticeMs', ${String(notBefore.getTime())}::text), updated_at = now()
WHERE id = ${id}::uuid AND status = 'pending'`);
}

export interface DispatchOutboxHealth {
  overdue: number;
  stuck: number;
  failed: number;
  /** Work rows of a `dispatch` workspace the Worker has not acked for over a minute. */
  unacked: number;
  /** Handed off, due over an hour ago, and still no terminal receipt. */
  orphaned: number;
}

/** Everything a reconciler needs to see: due-but-undelivered, stuck, failed, unacked and orphaned rows. */
export async function dispatchOutboxHealth(): Promise<DispatchOutboxHealth> {
  const result = await db.execute(dispatchOutboxHealthSql());
  const r = rowsOf(result)[0] ?? {};
  return {
    overdue: Number(r.overdue ?? 0), stuck: Number(r.stuck ?? 0), failed: Number(r.failed ?? 0),
    unacked: Number(r.unacked ?? 0), orphaned: Number(r.orphaned ?? 0),
  };
}

export function dispatchOutboxHealthSql(): SQL {
  return sql`-- dispatch_outbox:health
SELECT
  count(*) FILTER (WHERE o.status = 'pending' AND o.not_before < now() - interval '5 minutes') AS overdue,
  count(*) FILTER (WHERE o.status = 'delivering' AND o.last_attempt_at < now() - interval '5 minutes') AS stuck,
  count(*) FILTER (WHERE o.status = 'failed' AND o.updated_at > now() - interval '1 day') AS failed,
  count(*) FILTER (WHERE o.status = 'pending' AND o.handed_off_at IS NULL AND o.intent = 'work_execution'
    AND o.created_at < now() - interval '1 minute' AND w.dispatch_transport = 'dispatch'
    AND NOT ${sql.raw(FALLEN_BACK_SQL)}) AS unacked,
  count(*) FILTER (WHERE o.status = 'handed_off' AND o.not_before < now() - interval '1 hour') AS orphaned
FROM task_dispatch_outbox o LEFT JOIN workspaces w ON w.id = o.workspace_id`;
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
SELECT id, intent, cause, causes, status, not_before, attempt_count, delivered_at, delivered_via, last_error, created_at,
  transport, handed_off_at
FROM task_dispatch_outbox WHERE task_id = ${taskId}::uuid ORDER BY created_at LIMIT ${limit}`);
  return rowsOf(result);
}
