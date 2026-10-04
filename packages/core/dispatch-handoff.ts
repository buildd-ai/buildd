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
import { RECEIPT_EVENTS, isTerminalState, type IntentSummary, type Receipt } from '@buildd/dispatch-contract';
import { db } from './db';
import { DISPATCH_FALLBACK_KEY, FALLEN_BACK_SQL, type DispatchCause, type DispatchIntent } from './dispatch-outbox';

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
    AND NOT ${sql.raw(FALLEN_BACK_SQL)}
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

const publishableOf = (result: unknown): PublishableRow[] =>
  rowsOf(result).map(r => ({
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

export async function selectForPublish(opts: { taskId?: string | null; limit?: number } = {}): Promise<PublishableRow[]> {
  return publishableOf(await db.execute(selectForPublishSql(opts)));
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

/**
 * A callback that outran its own ack. Publish POSTs, Dispatch stores the
 * intent and may fire its alarm at once, and its resolve/relay can reach us
 * before the ack UPDATE below commits. The row is then `pending` with
 * `published_at` set and no `handed_off_at`: Dispatch has it, we just have
 * not written that down. Write it down here, the same way the ack does
 * (`dispatch` workspace: handed off; `shadow`: only marked), so the callback
 * proceeds instead of answering not_in_custody and losing the wake. The ack
 * that lands later then matches no row and changes nothing.
 *
 * Never for a row the repair floor took back (fallback mark), a row never
 * published, a workspace on `in_app`, or a row the in-app drain already took
 * (status is no longer `pending`).
 */
export function claimCustodySql(id: string): SQL {
  return sql`-- dispatch_handoff:claim_custody
UPDATE task_dispatch_outbox o
SET status = CASE WHEN w.dispatch_transport = 'dispatch' THEN 'handed_off' ELSE o.status END,
    transport = CASE WHEN w.dispatch_transport = 'dispatch' THEN 'dispatch' ELSE o.transport END,
    handed_off_at = now(), updated_at = now()
FROM workspaces w
WHERE o.id = ${id}::uuid AND w.id = o.workspace_id
  AND o.status = 'pending' AND o.handed_off_at IS NULL AND o.published_at IS NOT NULL
  AND w.dispatch_transport IN ('dispatch', 'shadow')
  AND NOT ${sql.raw(FALLEN_BACK_SQL)}
RETURNING o.id`;
}

/** True when this call took custody (see claimCustodySql). */
export async function claimCustody(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return rowsOf(await db.execute(claimCustodySql(id))).length > 0;
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
  RETURNING o.id, o.workspace_id, o.status, o.last_error
)
SELECT count(*) AS n,
  COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'workspaceId', u.workspace_id, 'error', u.last_error))
    FILTER (WHERE u.status = 'failed'), '[]'::jsonb) AS failed
FROM upd u`;
}

/** A row a receipt batch moved to `failed`: Dispatch gave up on it. Only rows this batch moved, so a resend reports none. */
export interface FailedReceiptRow {
  id: string;
  workspaceId: string;
  error: string | null;
}

export interface AppliedReceipts {
  applied: number;
  failed: FailedReceiptRow[];
}

/** Parse the one row applyReceiptsSql returns. */
export function parseAppliedReceipts(r: Record<string, unknown> | undefined): AppliedReceipts {
  if (!r) return { applied: 0, failed: [] };
  const raw = typeof r.failed === 'string' ? JSON.parse(r.failed) : r.failed;
  const failed = (Array.isArray(raw) ? raw : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string')
    .map(f => ({ id: String(f.id), workspaceId: String(f.workspaceId), error: typeof f.error === 'string' ? f.error : null }));
  return { applied: Number(r.n ?? 0), failed };
}

/** applyReceipts, plus which rows the batch moved to `failed` (for the receipts route's alert). */
export async function applyReceiptsDetailed(receipts: readonly Receipt[]): Promise<AppliedReceipts> {
  if (receipts.length === 0) return { applied: 0, failed: [] };
  return parseAppliedReceipts(rowsOf(await db.execute(applyReceiptsSql(receipts)))[0]);
}

export async function applyReceipts(receipts: readonly Receipt[]): Promise<number> {
  return (await applyReceiptsDetailed(receipts)).applied;
}

// ── Orphan reconcile (the hourly floor) ───────────────────────────────────
//
// A handed-off row with no terminal receipt well past its due time is an
// orphan candidate: Dispatch lost it, the receipt was lost, or Dispatch is
// still retrying. The floor asks Dispatch (GET /v1/intents) and then
// re-publishes, projects the terminal receipt, leaves it, or takes it back
// for the in-app drain (lib/dispatch-reconcile.ts decides which).

/** A handed-off row due longer ago than this, still with no terminal receipt, is checked. */
export const ORPHAN_MIN_AGE_MS = 10 * 60_000;
/** Past this, a row Dispatch has not closed is taken back for the in-app drain. */
export const ORPHAN_CEILING_MS = 60 * 60_000;
/** Rows one floor run checks; a larger backlog continues next hour. */
export const ORPHAN_SCAN_LIMIT = 500;

export interface OrphanCandidate {
  id: string;
  workspaceId: string;
  notBefore: Date;
  /** Due longer ago than ORPHAN_CEILING_MS. */
  pastCeiling: boolean;
}

/**
 * Orphan candidates, oldest due first. A plain read: nothing is claimed,
 * because every action the floor takes afterwards is a guarded UPDATE that
 * re-checks `status = 'handed_off'`. Only `transport = 'dispatch'` rows: a
 * shadow row is the in-app drain's and is never `handed_off`.
 */
export function selectOrphanCandidatesSql(opts: { minAgeMs?: number; ceilingMs?: number; limit?: number; now?: string | null } = {}): SQL {
  const args = {
    minAgeMs: opts.minAgeMs ?? ORPHAN_MIN_AGE_MS,
    ceilingMs: opts.ceilingMs ?? ORPHAN_CEILING_MS,
    limit: opts.limit ?? ORPHAN_SCAN_LIMIT,
    now: opts.now ?? null,
  };
  return sql`-- dispatch_handoff:orphan_candidates
WITH args AS (SELECT ${JSON.stringify(args)}::jsonb AS a),
clock AS (SELECT COALESCE((a->>'now')::timestamptz, now()) AS now FROM args)
SELECT o.id, o.workspace_id, o.not_before,
  o.not_before < c.now - ((SELECT a->>'ceilingMs' FROM args)::int * interval '1 millisecond') AS past_ceiling
FROM task_dispatch_outbox o, clock c
WHERE o.status = 'handed_off' AND o.transport = 'dispatch'
  AND o.not_before < c.now - ((SELECT a->>'minAgeMs' FROM args)::int * interval '1 millisecond')
ORDER BY o.not_before, o.id
LIMIT (SELECT (a->>'limit')::int FROM args)`;
}

export async function selectOrphanCandidates(opts: Parameters<typeof selectOrphanCandidatesSql>[0] = {}): Promise<OrphanCandidate[]> {
  const result = await db.execute(selectOrphanCandidatesSql(opts));
  return rowsOf(result).map(r => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    notBefore: new Date(r.not_before as string),
    pastCeiling: r.past_ceiling === true || r.past_ceiling === 't',
  }));
}

/** A handed-off row being re-published; `mode` is the workspace's transport now, which may be `in_app`. */
export type RepublishRow = Omit<PublishableRow, 'mode'> & { mode: WorkspaceDispatchTransport };

/**
 * The re-publish selection for handed-off ids Dispatch says it does not know:
 * the same columns as the publish selection, stamping `published_at`, as one
 * statement. Only rows still `handed_off` (a receipt or a fallback in the
 * meantime wins). Publish is idempotent on id, so a duplicate is harmless.
 * The row stays `handed_off`: Dispatch's accept just restores the copy it
 * lost, so nothing is acked.
 */
export function selectForRepublishSql(ids: readonly string[]): SQL {
  const input = ids.filter(isUuid);
  return sql`-- dispatch_handoff:select_for_republish
WITH ids AS (SELECT DISTINCT (jsonb_array_elements_text(${JSON.stringify(input)}::jsonb))::uuid AS id)
UPDATE task_dispatch_outbox o
SET published_at = now(), updated_at = now()
FROM ids, workspaces w
WHERE o.id = ids.id AND w.id = o.workspace_id AND o.status = 'handed_off' AND o.transport = 'dispatch'
RETURNING o.id, o.intent, o.workspace_id, o.task_id, o.cause, o.causes, o.not_before, o.dedupe_key,
  o.attempt_count, o.metadata, w.dispatch_transport AS mode`;
}

export async function selectForRepublish(ids: readonly string[]): Promise<RepublishRow[]> {
  if (ids.length === 0) return [];
  return publishableOf(await db.execute(selectForRepublishSql(ids))) as RepublishRow[];
}

/**
 * Take handed-off rows back for the in-app drain, as one statement: the
 * design's rollback path. `pending`, `transport = 'in_app'`,
 * `handed_off_at = NULL`, and the DISPATCH_FALLBACK_KEY mark so the publish
 * sweep never hands the row back and the publish grace never holds it.
 * `not_before` is untouched (already past), so the next drain takes it.
 *
 * Only from `handed_off`: a receipt that closed the row in the meantime
 * wins. After the flip a late receipt changes nothing (receipts project only
 * onto `handed_off` dispatch rows), and a resolve or relay callback from an
 * attempt Dispatch is still making is refused (the row is out of custody),
 * so at most an attempt already past its callback duplicates the wake. The
 * claim route's atomic assignment keeps that to one run.
 */
export function fallBackToInAppSql(ids: readonly string[]): SQL {
  const input = ids.filter(isUuid);
  return sql`-- dispatch_handoff:fall_back
WITH ids AS (SELECT DISTINCT (jsonb_array_elements_text(${JSON.stringify(input)}::jsonb))::uuid AS id)
UPDATE task_dispatch_outbox o
SET status = 'pending', transport = 'in_app', handed_off_at = NULL,
    metadata = CASE WHEN jsonb_typeof(o.metadata) = 'object' THEN o.metadata ELSE '{}'::jsonb END
      || jsonb_build_object(${DISPATCH_FALLBACK_KEY}::text, now()),
    updated_at = now()
FROM ids
WHERE o.id = ids.id AND o.status = 'handed_off'
RETURNING o.id`;
}

export async function fallBackToInApp(ids: readonly string[]): Promise<number> {
  if (ids.filter(isUuid).length === 0) return 0;
  return rowsOf(await db.execute(fallBackToInAppSql(ids))).length;
}

/**
 * The terminal receipt a Dispatch intent summary stands for, so a lost one
 * is projected by applyReceiptsSql exactly as if it had arrived. Null for an
 * open intent, or a merged one with no target id. `nowIso` stands in for a
 * missing `closedAt` (a Worker that predates it).
 *
 *   delivered, skipped → delivered (via, as the receipt said)
 *   failed             → failed (why)
 *   merged             → merged (into)
 *   expired            → expired
 */
export function terminalReceiptFor(s: IntentSummary, nowIso: string): Receipt | null {
  if (!isUuid(s.id) || !isTerminalState(s.state)) return null;
  const at = s.closedAt && !Number.isNaN(Date.parse(s.closedAt)) ? s.closedAt : nowIso;
  const attempt = Number.isInteger(s.attempt) && s.attempt >= 0 ? s.attempt : 0;
  const base = { id: s.id, attempt, at };
  let r: Receipt;
  switch (s.state) {
    case 'delivered':
    case 'skipped':
      r = { ...base, event: 'delivered', ...(s.via ? { via: s.via } : {}) };
      break;
    case 'failed':
      r = { ...base, event: 'failed', ...(s.why ? { why: s.why } : {}) };
      break;
    case 'merged':
      if (!isUuid(s.mergedInto)) return null;
      r = { ...base, event: 'merged', into: s.mergedInto };
      break;
    case 'expired':
      r = { ...base, event: 'expired', ...(s.why ? { why: s.why } : {}) };
      break;
    default:
      return null;
  }
  return isProjectableReceipt(r) ? r : null;
}
