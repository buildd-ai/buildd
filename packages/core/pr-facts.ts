/**
 * `recordPrFact`: the one writer of the PR fact cache on `workers`
 * (`pr_lifecycle_status`, `merged_at`, `conflict_detected_at`), per
 * docs/specs/workflow-state-kernel.md §12 and §14 row B.
 *
 * A PR fact is something GitHub said about a PR (merged, closed, open, CI
 * status, mergeability). Webhooks, sweeps, merge doors and the kernel's
 * `stamp_pr_rows` effect all hand their observation to this funnel instead of
 * writing the columns themselves, and the funnel enforces the ordering rules
 * in the statement's own WHERE clause, so arrival order never matters:
 *
 *  - **Terminal wins.** `merged` is final: nothing overwrites it, and a second
 *    merge fact keeps the first instant. `closed` yields only to `merged` or an
 *    explicit `reopened`. A late `synchronize`/`opened`/`check_suite` for a
 *    merged or closed PR changes nothing (§16 S6, AC-8).
 *  - **GitHub's clock.** `merged_at` is GitHub's `merged_at` when the caller
 *    has it; a merge door that only has the merge response passes its own
 *    instant, and a later fact never moves an instant already recorded.
 *  - **The head it describes.** A CI fact names the SHA its suite ran on and
 *    the PR head the caller read with it; a fact for an old SHA is dropped, so
 *    a late failure never overwrites the state of a newer head.
 *  - **`conflict_detected_at` is first-seen.** It is set once and never moved.
 *
 * Bookkeeping clocks (`pr_last_checked_at`, …) ride along only when the fact
 * applies; importers that must advance them regardless write them themselves
 * (they are not guarded columns).
 *
 * The write-site guard (`packages/core/__tests__/pr-fact-write-sites.test.ts`)
 * fails any other module that writes the guarded columns.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';

export type PrCiStatus = 'ci_running' | 'ci_failed' | 'ci_green';

export type PrFact =
  /** GitHub reports the PR merged. `mergedAt`: GitHub's `merged_at` (or the merge door's own instant). */
  | { kind: 'merged'; mergedAt: Date | string }
  /** GitHub reports the PR closed without merging. */
  | { kind: 'closed' }
  /**
   * The PR is open (opened, synchronize, ready_for_review, a live read).
   * Only `reopened: true` (a `reopened` event or a live read that saw it open
   * again) lifts a `closed` row; nothing lifts `merged`.
   */
  | { kind: 'open'; reopened?: boolean }
  /**
   * A CI observation. `headSha` is the SHA the suite ran on; `currentHeadSha`
   * the PR head the caller read alongside it (payload or live read). When both
   * are known and differ, the fact is about an old head and is dropped.
   */
  | { kind: 'ci'; status: PrCiStatus; headSha?: string | null; currentHeadSha?: string | null }
  /** GitHub reports the PR's merge state dirty (a textual conflict with its base). */
  | { kind: 'conflict' }
  /** Reconcile bookkeeping: the row could not be resolved against GitHub past the threshold. */
  | { kind: 'unresolvable'; reason: string };

export type PrFactKind = PrFact['kind'];

/** Which worker rows the fact is about. A merge or close belongs to every row carrying the PR. */
export type PrFactTarget =
  | { workerId: string }
  | { workerIds: string[] }
  | { prUrl: string; prNumber: number };

/** Unguarded bookkeeping written alongside an applied fact. */
export interface PrFactBookkeeping {
  prLastCheckedAt?: Date;
  prLastVerifiedAt?: Date;
  prCheckFailureCount?: number;
  prIsDraft?: boolean | null;
}

export interface RecordedPrFactRow {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  /** The status the row held before this fact applied. */
  previousStatus: string | null;
}

/** Statuses after which no CI, conflict or open fact applies (the reconcile terminal set). */
const CLOSED_OR_UNRESOLVABLE = ['merged', 'closed', 'unresolvable'] as const;

/**
 * Pure mirror of the guard below, for callers and tests that reason about a
 * row they already hold. The SQL is the authority; this must agree with it.
 */
export function prFactApplies(fact: PrFact, row: { prLifecycleStatus: string | null; mergedAt: Date | string | null }): boolean {
  const status = row.prLifecycleStatus;
  const merged = row.mergedAt != null || status === 'merged';
  if (staleCiFact(fact)) return false;
  switch (fact.kind) {
    case 'merged': return row.mergedAt == null || status !== 'merged';
    case 'closed': return !merged && status !== 'closed';
    case 'open': return !merged && (status !== 'closed' || fact.reopened === true);
    case 'ci': return !merged && !(CLOSED_OR_UNRESOLVABLE as readonly string[]).includes(status ?? '') && status !== fact.status;
    case 'conflict': return !merged && !(CLOSED_OR_UNRESOLVABLE as readonly string[]).includes(status ?? '');
    case 'unresolvable': return !merged && status !== 'closed' && status !== 'unresolvable';
  }
}

function staleCiFact(fact: PrFact): boolean {
  return fact.kind === 'ci' && !!fact.headSha && !!fact.currentHeadSha && fact.headSha !== fact.currentHeadSha;
}

const inList = (values: readonly string[]): SQL => sql.join(values.map((v) => sql`${v}::text`), sql`, `);
const statusNotIn = (values: readonly string[]): SQL => sql`(w.pr_lifecycle_status IS NULL OR w.pr_lifecycle_status NOT IN (${inList(values)}))`;

function targetSql(t: PrFactTarget): SQL | null {
  if ('workerId' in t) return t.workerId ? sql`w.id = ${t.workerId}::uuid` : null;
  if ('workerIds' in t) {
    const ids = t.workerIds.filter(Boolean);
    return ids.length ? sql`w.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)` : null;
  }
  if (!t.prUrl || t.prNumber == null) return null;
  return sql`w.pr_url = ${t.prUrl}::text AND w.pr_number = ${t.prNumber}::int`;
}

/** Terminal-wins, in the WHERE clause (§12). */
function guardSql(f: PrFact): SQL {
  switch (f.kind) {
    case 'merged':
      return sql`(w.merged_at IS NULL OR w.pr_lifecycle_status IS DISTINCT FROM 'merged')`;
    case 'closed':
      return sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed'])}`;
    case 'open':
      return f.reopened
        ? sql`w.merged_at IS NULL AND ${statusNotIn(['merged'])}`
        : sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed'])}`;
    case 'ci':
      return sql`w.merged_at IS NULL AND ${statusNotIn([...CLOSED_OR_UNRESOLVABLE, f.status])}`;
    case 'conflict':
      return sql`w.merged_at IS NULL AND ${statusNotIn(CLOSED_OR_UNRESOLVABLE)}`;
    case 'unresolvable':
      return sql`w.merged_at IS NULL AND ${statusNotIn(['merged', 'closed', 'unresolvable'])}`;
  }
}

function setSql(f: PrFact, b: PrFactBookkeeping): SQL {
  const sets: SQL[] = [sql`updated_at = now()`];
  switch (f.kind) {
    case 'merged':
      sets.push(sql`pr_lifecycle_status = 'merged'`, sql`merged_at = COALESCE(w.merged_at, ${new Date(f.mergedAt).toISOString()}::timestamptz)`);
      break;
    case 'closed': sets.push(sql`pr_lifecycle_status = 'closed'`); break;
    case 'open': sets.push(sql`pr_lifecycle_status = 'pr_open'`); break;
    case 'ci': sets.push(sql`pr_lifecycle_status = ${f.status}::text`); break;
    case 'conflict':
      sets.push(sql`pr_lifecycle_status = 'conflict'`, sql`conflict_detected_at = COALESCE(w.conflict_detected_at, now())`);
      break;
    case 'unresolvable':
      sets.push(sql`pr_lifecycle_status = 'unresolvable'`, sql`pr_unresolvable_reason = ${f.reason}::text`);
      break;
  }
  if (b.prLastCheckedAt) sets.push(sql`pr_last_checked_at = ${b.prLastCheckedAt.toISOString()}::timestamptz`);
  if (b.prLastVerifiedAt) sets.push(sql`pr_last_verified_at = ${b.prLastVerifiedAt.toISOString()}::timestamptz`);
  if (b.prCheckFailureCount !== undefined) sets.push(sql`pr_check_failure_count = ${b.prCheckFailureCount}::int`);
  if (b.prIsDraft !== undefined) sets.push(sql`pr_is_draft = ${b.prIsDraft}::boolean`);
  return sql.join(sets, sql`, `);
}

/**
 * One statement: apply `fact` to every targeted row the guard allows and
 * return those rows (with the status each held before). Null when the target
 * names no PR identity or the fact is about an old head: nothing to write.
 */
export function recordPrFactSql(target: PrFactTarget, fact: PrFact, bookkeeping: PrFactBookkeeping = {}): SQL | null {
  const where = targetSql(target);
  if (!where || staleCiFact(fact)) return null;
  return sql`-- pr-facts:record
WITH prev AS (
  SELECT w.id, w.pr_lifecycle_status AS previous_status
  FROM workers w
  WHERE ${where} AND ${guardSql(fact)}
  FOR UPDATE
)
UPDATE workers w SET ${setSql(fact, bookkeeping)}
FROM prev
WHERE w.id = prev.id AND ${guardSql(fact)}
RETURNING w.id, w.task_id, w.workspace_id, prev.previous_status`;
}

export type PrFactExec = (q: SQL) => Promise<{ rows?: unknown[] } | unknown[]>;
const dbExec: PrFactExec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * Record a PR fact on the fact cache. Idempotent: a replay, or a fact the
 * cache already holds a terminal answer to, writes nothing and returns [].
 */
export async function recordPrFact(
  target: PrFactTarget,
  fact: PrFact,
  opts: { bookkeeping?: PrFactBookkeeping; exec?: PrFactExec } = {},
): Promise<RecordedPrFactRow[]> {
  const q = recordPrFactSql(target, fact, opts.bookkeeping);
  if (!q) return [];
  const res = await (opts.exec ?? dbExec)(q);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    taskId: r.task_id == null ? null : String(r.task_id),
    workspaceId: r.workspace_id == null ? null : String(r.workspace_id),
    previousStatus: r.previous_status == null ? null : String(r.previous_status),
  }));
}
