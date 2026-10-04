/**
 * The Postgres half of the Dispatch transport handoff (knowledge-base
 * buildd/design/cloudflare-dispatch-transport.md, "Handoff" and "The crux").
 *
 * Postgres stays the source of truth for intent creation: the outbox row is
 * written atomically with the state change (dispatch-outbox.ts). Publishing
 * copies unacked rows to Dispatch; the ack is one UPDATE per outcome. From the
 * ack on, a `dispatch` workspace's row is `handed_off` — Dispatch owns when to
 * attempt, retry, collapse and give up — and receipts project the outcome back
 * onto the row. A `shadow` workspace's row only records `handed_off_at`: the
 * in-app drain still delivers it, and Dispatch's decisions are compared, not
 * applied.
 *
 * Every builder binds caller values as one jsonb parameter (the convention in
 * dispatch-outbox.ts); none interpolates into `sql.raw`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { RECEIPT_EVENTS, type Receipt } from '@buildd/dispatch-contract';
import { db } from './db';
import type { DispatchCause, DispatchIntent } from './dispatch-outbox';

export type WorkspaceDispatchTransport = 'in_app' | 'shadow' | 'dispatch';
/** The transports that publish. `in_app` (the default) never does. */
export type PublishingTransport = Exclude<WorkspaceDispatchTransport, 'in_app'>;

/**
 * A row published this recently is not published again: a Worker that is
 * down is not hammered by every kick, and the next sweep after this retries.
 */
export const PUBLISH_BACKOFF_MS = 20_000;

/** Upper bound on rows one publish carries (this task's plus the oldest others). */
export const PUBLISH_SWEEP_LIMIT = 25;

type RawRow = Record<string, unknown>;
const rowsOf = (r: unknown): RawRow[] => ((r as { rows?: RawRow[] })?.rows ?? []);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ── Publish selection ─────────────────────────────────────────────────────

export interface PublishableRow {
  id: string;
  intent: DispatchIntent;
  workspaceId: string;
  taskId: string;
  cause: DispatchCause;
  causes: DispatchCause[];
  notBefore: Date;
  dedupeKey: string;
  attemptCount: number;
  metadata: Record<string, unknown> | null;
  /** The workspace's transport when the row was selected; the ack applies that mode. */
  mode: PublishingTransport;
}

/**
 * Take unacked pending work rows of publishing workspaces — this task's
 * first, then the oldest others (every publish is also a repair sweep) — and
 * stamp `published_at`, as one statement. A row stamped within
 * PUBLISH_BACKOFF_MS is not taken. SKIP LOCKED keeps two concurrent publishes
 * from sending the same row (a duplicate would be harmless — Dispatch is
 * idempotent on id — but wasteful). Non-work intents are never published:
 * they have no adapter, and the in-app drain parks them as `no_adapter`.
 */
export function selectForPublishSql(opts: { taskId?: string | null; limit?: number; backoffMs?: number; now?: string | null } = {}): SQL {
  const args = {
    taskId: isUuid(opts.taskId) ? opts.taskId : null,
    limit: opts.limit ?? PUBLISH_SWEEP_LIMIT,
    backoffMs: opts.backoffMs ?? PUBLISH_BACKOFF_MS,
    now: opts.now ?? null,
  };
  return sql`-- dispatch_handoff:select_for_publish
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a),
clock AS (SELECT COALESCE((a->>'now')::timestamptz, now()) AS now FROM args),
cand AS (
  SELECT o.id, w.dispatch_transport AS mode
  FROM task_dispatch_outbox o JOIN workspaces w ON w.id = o.workspace_id, clock c
  WHERE o.status = 'pending' AND o.handed_off_at IS NULL AND o.intent = 'work_execution'
    AND w.dispatch_transport IN ('shadow', 'dispatch')
    AND (o.published_at IS NULL
      OR o.published_at < c.now - ((SELECT a->>'backoffMs' FROM args)::int * interval '1 millisecond'))
  ORDER BY (o.task_id IS NOT DISTINCT FROM (SELECT (a->>'taskId')::uuid FROM args)) DESC, o.created_at
  LIMIT (SELECT (a->>'limit')::int FROM args)
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE task_dispatch_outbox o
SET published_at = (SELECT now FROM clock), updated_at = now()
FROM cand
WHERE o.id = cand.id AND o.status = 'pending' AND o.handed_off_at IS NULL
RETURNING o.id, o.intent, o.workspace_id, o.task_id, o.cause, o.causes, o.not_before, o.dedupe_key,
  o.attempt_count, o.metadata, cand.mode`;
}

const causesOf = (v: unknown): DispatchCause[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v) : []) as DispatchCause[];

export async function selectForPublish(opts: { taskId?: string | null; limit?: number } = {}): Promise<PublishableRow[]> {
  const result = await db.execute(selectForPublishSql(opts));
  return rowsOf(result).map(r => ({
    id: String(r.id),
    intent: (r.intent ?? 'work_execution') as DispatchIntent,
    workspaceId: String(r.workspace_id),
    taskId: String(r.task_id),
    cause: r.cause as DispatchCause,
    causes: causesOf(r.causes),
    notBefore: new Date(r.not_before as string),
    dedupeKey: String(r.dedupe_key),
    attemptCount: Number(r.attempt_count),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    mode: r.mode as PublishingTransport,
  }));
}

// ── Acks ──────────────────────────────────────────────────────────────────

export interface Ack { id: string; mode: PublishingTransport }
export interface MergedAck extends Ack { into: string }

/**
 * `accepted` / `duplicate`, as one statement. A `dispatch` row becomes
 * `handed_off` (only from `pending`: a row the in-app fallback took in the
 * meantime keeps its own lifecycle, and Dispatch's copy is a harmless
 * duplicate wake). A `shadow` row only gains `handed_off_at`; its status is
 * the in-app drain's.
 */
export function ackHandoffSql(acks: readonly Ack[]): SQL {
  const input = acks.filter(a => isUuid(a.id)).map(a => ({ id: a.id, mode: a.mode }));
  return sql`-- dispatch_handoff:ack
WITH acks AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS r(id uuid, mode text))
UPDATE task_dispatch_outbox o
SET status = CASE WHEN acks.mode = 'dispatch' THEN 'handed_off' ELSE o.status END,
    transport = CASE WHEN acks.mode = 'dispatch' THEN 'dispatch' ELSE o.transport END,
    handed_off_at = now(), updated_at = now()
FROM acks
WHERE o.id = acks.id AND o.handed_off_at IS NULL
  AND ((acks.mode = 'dispatch' AND o.status = 'pending') OR acks.mode = 'shadow')
RETURNING o.id`;
}

/**
 * `merged {into}`, as one statement: Dispatch folded this row into another
 * queued intent with the same dedupe key, which reproduces Postgres
 * coalescing across the handoff. A `dispatch` row closes as delivered via
 * `merged_into_pending` (the in-app retry path's word for the same thing);
 * a `shadow` row only records the ack.
 */
export function ackMergedSql(merges: readonly MergedAck[]): SQL {
  const input = merges.filter(m => isUuid(m.id) && isUuid(m.into)).map(m => ({ id: m.id, mode: m.mode, into: m.into }));
  return sql`-- dispatch_handoff:ack_merged
WITH m AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS r(id uuid, mode text, "into" uuid))
UPDATE task_dispatch_outbox o
SET status = CASE WHEN m.mode = 'dispatch' THEN 'delivered' ELSE o.status END,
    transport = CASE WHEN m.mode = 'dispatch' THEN 'dispatch' ELSE o.transport END,
    delivered_at = CASE WHEN m.mode = 'dispatch' THEN now() ELSE o.delivered_at END,
    delivered_via = CASE WHEN m.mode = 'dispatch' THEN 'merged_into_pending' ELSE o.delivered_via END,
    merged_into = CASE WHEN m.mode = 'dispatch' THEN m."into" ELSE o.merged_into END,
    handed_off_at = now(), updated_at = now()
FROM m
WHERE o.id = m.id AND o.handed_off_at IS NULL
  AND ((m.mode = 'dispatch' AND o.status = 'pending') OR m.mode = 'shadow')
RETURNING o.id`;
}

export async function ackHandoff(acks: readonly Ack[]): Promise<number> {
  if (acks.length === 0) return 0;
  return rowsOf(await db.execute(ackHandoffSql(acks))).length;
}

export async function ackMerged(merges: readonly MergedAck[]): Promise<number> {
  if (merges.length === 0) return 0;
  return rowsOf(await db.execute(ackMergedSql(merges))).length;
}

// ── Custody (callbacks) ───────────────────────────────────────────────────

export interface CustodyRow {
  id: string;
  intent: DispatchIntent;
  workspaceId: string;
  taskId: string;
  cause: DispatchCause;
  causes: DispatchCause[];
  notBefore: Date;
  attemptCount: number;
  metadata: Record<string, unknown> | null;
  status: string;
  transport: string;
  handedOffAt: Date | null;
}

/**
 * Whether Dispatch may act on this row through a callback: it was handed off
 * (`dispatch`), or it is a `shadow` row Dispatch acked that the in-app drain
 * has not delivered yet. Anything else is not in Dispatch's custody.
 */
export function inDispatchCustody(row: Pick<CustodyRow, 'status' | 'handedOffAt'>): boolean {
  return row.status === 'handed_off' || (row.status === 'pending' && row.handedOffAt != null);
}

export async function loadCustodyRow(id: string): Promise<CustodyRow | null> {
  if (!isUuid(id)) return null;
  const result = await db.execute(sql`-- dispatch_handoff:custody
SELECT id, intent, workspace_id, task_id, cause, causes, not_before, attempt_count, metadata, status, transport, handed_off_at
FROM task_dispatch_outbox WHERE id = ${id}::uuid`);
  const r = rowsOf(result)[0];
  if (!r) return null;
  return {
    id: String(r.id),
    intent: (r.intent ?? 'work_execution') as DispatchIntent,
    workspaceId: String(r.workspace_id),
    taskId: String(r.task_id),
    cause: r.cause as DispatchCause,
    causes: causesOf(r.causes),
    notBefore: new Date(r.not_before as string),
    attemptCount: Number(r.attempt_count),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    status: String(r.status),
    transport: String(r.transport),
    handedOffAt: r.handed_off_at ? new Date(r.handed_off_at as string) : null,
  };
}

// ── Receipts ──────────────────────────────────────────────────────────────

/** A receipt that is well-formed enough to project; the rest are dropped by the caller. */
export function isProjectableReceipt(r: unknown): r is Receipt {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return isUuid(x.id)
    && typeof x.attempt === 'number' && Number.isInteger(x.attempt) && x.attempt >= 0
    && (RECEIPT_EVENTS as readonly string[]).includes(x.event as string)
    && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at))
    && (x.via === undefined || typeof x.via === 'string')
    && (x.why === undefined || typeof x.why === 'string')
    && (x.event !== 'merged' || isUuid(x.into));
}

/**
 * Project a batch of receipts onto `handed_off` rows of `dispatch`
 * workspaces, as one statement. Idempotent: a terminal event applies only
 * while the row is still `handed_off`, and `attempted` only moves
 * attempt_count / last_attempt_at forward, so re-applying a batch changes
 * nothing. Within a batch the terminal receipt for a row wins and the
 * highest attempt is kept.
 *
 *   delivered → delivered, delivered_at, delivered_via (Dispatch's `via`)
 *   failed    → failed, last_error
 *   attempted → attempt_count, last_attempt_at, last_error (still handed_off)
 *   merged    → delivered via `merged_into_pending`, merged_into
 *   expired   → delivered via `expired`: a wake nobody took by its deadline
 *               is closed, not an error (`failed` stays "a consumer is
 *               rejecting wakes" for the health report)
 *
 * Shadow rows (`transport = 'in_app'`) are never touched: their status is
 * the in-app drain's, and Dispatch keeps its own copy of the decision for the
 * shadow parity comparison.
 */
export function applyReceiptsSql(receipts: readonly Receipt[]): SQL {
  const input = receipts.filter(isProjectableReceipt).map(r => ({
    id: r.id, attempt: r.attempt, event: r.event, via: r.via ?? null,
    why: r.why ? r.why.slice(0, 500) : null, into: r.into ?? null, at: r.at,
  }));
  return sql`-- dispatch_handoff:receipts
WITH input AS (
  SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
    AS r(id uuid, attempt int, event text, via text, why text, "into" uuid, at timestamptz)
),
agg AS (
  SELECT id, max(attempt) AS max_attempt, max(at) FILTER (WHERE event = 'attempted') AS last_at
  FROM input GROUP BY id
),
pick AS (
  SELECT DISTINCT ON (i.id) i.id, i.event, i.via, i.why, i."into", i.at, agg.max_attempt, agg.last_at
  FROM input i JOIN agg ON agg.id = i.id
  ORDER BY i.id, (i.event <> 'attempted') DESC, i.at DESC, i.attempt DESC
),
upd AS (
  UPDATE task_dispatch_outbox o
  SET status = CASE p.event WHEN 'attempted' THEN o.status WHEN 'failed' THEN 'failed' ELSE 'delivered' END,
      attempt_count = GREATEST(o.attempt_count, p.max_attempt),
      last_attempt_at = CASE WHEN p.last_at IS NULL THEN o.last_attempt_at
        ELSE GREATEST(COALESCE(o.last_attempt_at, p.last_at), p.last_at) END,
      delivered_at = CASE WHEN p.event IN ('delivered', 'merged', 'expired') THEN p.at ELSE o.delivered_at END,
      delivered_via = CASE p.event
        WHEN 'delivered' THEN COALESCE(p.via, 'dispatch')
        WHEN 'merged' THEN 'merged_into_pending'
        WHEN 'expired' THEN 'expired'
        ELSE o.delivered_via END,
      merged_into = CASE WHEN p.event = 'merged' THEN p."into" ELSE o.merged_into END,
      last_error = CASE WHEN p.event IN ('attempted', 'failed') THEN COALESCE(p.why, o.last_error) ELSE o.last_error END,
      updated_at = now()
  FROM pick p
  WHERE o.id = p.id AND o.status = 'handed_off' AND o.transport = 'dispatch'
    AND (p.event <> 'attempted'
      OR p.max_attempt > o.attempt_count
      OR (p.last_at IS NOT NULL AND (o.last_attempt_at IS NULL OR p.last_at > o.last_attempt_at)))
  RETURNING 1
)
SELECT count(*) AS n FROM upd`;
}

export async function applyReceipts(receipts: readonly Receipt[]): Promise<number> {
  if (receipts.length === 0) return 0;
  return Number(rowsOf(await db.execute(applyReceiptsSql(receipts)))[0]?.n ?? 0);
}
