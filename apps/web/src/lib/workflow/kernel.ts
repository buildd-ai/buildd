/**
 * The workflow kernel's CAS statement builder and command runner
 * (docs/specs/workflow-state-kernel.md §7).
 *
 * One applied transition is ONE SQL statement: a version-guarded UPDATE of
 * workflow_deliveries (or the INSERT that opens one), the workflow_transitions
 * row, every follow-up workflow_effects row, the round and ledger writes and
 * the fact link — chained as data-modifying CTEs that all read from the
 * transition CTE, so either all of it commits or none of it does. neon-http
 * has no interactive transactions; this is the `enqueueDispatchSql` pattern.
 *
 * A replayed idempotency key violates workflow_transitions' unique index and
 * aborts the whole statement; the runner re-reads and answers `duplicate`.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { ApplyDecision, AttemptOp, Command, CurrentView, DeliveryPatch, RecordOnly, RoundOp } from './commands';
import { currentOf, reduce, stableIdempotencyKey } from './reducer';
import type {
  ApprovalBasis,
  AttemptSnapshot,
  DeliverySnapshot,
  DeliveryState,
  KernelView,
  RoundSnapshot,
} from './types';

export type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

const jsonb = (v: unknown): SQL => sql`${JSON.stringify(v ?? null)}::jsonb`;
const textArray = (v: string[]): SQL => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(v)}::jsonb))::text[]`;

// ── Patch → column assignments ──────────────────────────────────────────────

type Cast = 'text' | 'int' | 'uuid' | 'timestamptz' | 'text[]';
const PATCH_COLUMNS: Record<keyof DeliveryPatch, [string, Cast]> = {
  repoFullName: ['repo_full_name', 'text'],
  prNumber: ['pr_number', 'int'],
  baseRef: ['base_ref', 'text'],
  stateReason: ['state_reason', 'text'],
  currentHeadSha: ['current_head_sha', 'text'],
  currentRound: ['current_round', 'int'],
  maxRounds: ['max_rounds', 'int'],
  boundAttemptId: ['bound_attempt_id', 'uuid'],
  resumeState: ['resume_state', 'text'],
  trunkIncidentId: ['trunk_incident_id', 'uuid'],
  approvedHeads: ['approved_heads', 'text[]'],
  approvalBasis: ['approval_basis', 'text'],
  compositionHeads: ['composition_heads', 'text[]'],
  ci: ['ci', 'text'],
  ciHeadSha: ['ci_head_sha', 'text'],
  mergeable: ['mergeable', 'text'],
  mergeableHeadSha: ['mergeable_head_sha', 'text'],
  mergedAt: ['merged_at', 'timestamptz'],
  mergeCommitSha: ['merge_commit_sha', 'text'],
  supersededByPr: ['superseded_by_pr', 'int'],
  supersededByUrl: ['superseded_by_url', 'text'],
  supersededReason: ['superseded_reason', 'text'],
  recordedBy: ['recorded_by', 'text'],
};

function castValue(v: unknown, cast: Cast): SQL {
  switch (cast) {
    case 'text[]': return textArray((v as string[] | null) ?? []);
    case 'int': return sql`${v ?? null}::int`;
    case 'uuid': return sql`${v ?? null}::uuid`;
    case 'timestamptz': return sql`${v ?? null}::timestamptz`;
    default: return sql`${v ?? null}::text`;
  }
}

function patchEntries(patch: DeliveryPatch): Array<[string, SQL]> {
  return (Object.keys(patch) as Array<keyof DeliveryPatch>)
    .filter((k) => patch[k] !== undefined && PATCH_COLUMNS[k])
    .map((k) => {
      const [col, cast] = PATCH_COLUMNS[k];
      return [col, castValue(patch[k], cast)];
    });
}

// ── CTE pieces shared by transition and record-only statements ──────────────

/** `src` is a CTE exposing `delivery_id` (and, for transitions, `id`). */
function roundCtes(ops: RoundOp[], src: string): SQL[] {
  const out: SQL[] = [];
  const inserts = ops.filter((o): o is Extract<RoundOp, { op: 'insert' }> => o.op === 'insert');
  if (inserts.length) {
    const rows = inserts.map((o) => ({ id: o.id, round: o.round, head_sha: o.headSha, kind: o.kind, prior_round: o.priorRound, scope: o.scope ?? null }));
    out.push(sql`r_ins AS (
  INSERT INTO workflow_review_rounds (id, delivery_id, round, head_sha, kind, prior_round, scope)
  SELECT x.id, s.delivery_id, x.round, x.head_sha, x.kind, x.prior_round, x.scope
  FROM ${sql.identifier(src)} s, jsonb_to_recordset(${jsonb(rows)}) AS x(id uuid, round int, head_sha text, kind text, prior_round int, scope jsonb)
  RETURNING id
)`);
  }
  ops.forEach((o, i) => {
    if (o.op !== 'update') return;
    const sets: SQL[] = [sql`updated_at = now()`];
    if (o.set.status !== undefined) sets.push(sql`status = ${o.set.status}::text`);
    if (o.set.verdict !== undefined) sets.push(sql`verdict = ${o.set.verdict}::text`);
    if (o.set.effectiveVerdict !== undefined) sets.push(sql`effective_verdict = ${o.set.effectiveVerdict}::text`);
    if (o.set.confidence !== undefined) sets.push(sql`confidence = ${o.set.confidence}::real`);
    if (o.set.decided) sets.push(sql`decided_at = now()`);
    if (o.set.failureCount !== undefined) sets.push(sql`failure_count = ${o.set.failureCount}::int`);
    if (o.set.clearReviewer) sets.push(sql`reviewer_task_id = NULL`);
    out.push(sql`${sql.identifier(`r_upd_${i}`)} AS (
  UPDATE workflow_review_rounds rr SET ${sql.join(sets, sql`, `)}
  FROM ${sql.identifier(src)} s
  WHERE rr.id = ${o.roundId}::uuid AND rr.delivery_id = s.delivery_id
    AND rr.status IN (SELECT jsonb_array_elements_text(${jsonb(o.whenStatus)}))
  RETURNING rr.id
)`);
  });
  return out;
}

function attemptCtes(ops: AttemptOp[], src: string): SQL[] {
  const out: SQL[] = [];
  const inserts = ops.filter((o): o is Extract<AttemptOp, { op: 'insert' }> => o.op === 'insert');
  if (inserts.length) {
    const rows = inserts.map((o) => ({
      id: o.id, family: o.family, attempt_no: o.attemptNo, mode: o.mode, bound_head_sha: o.boundHeadSha,
      trigger_reason: o.triggerReason, trigger_fact_id: o.triggerFactId ?? null, task_id: o.taskId, trigger: o.trigger,
      status: o.status, max_attempts: o.maxAttempts,
    }));
    out.push(sql`a_ins AS (
  INSERT INTO workflow_attempts (id, delivery_id, family, attempt_no, mode, bound_head_sha, trigger_reason, trigger_fact_id, task_id, trigger, status, max_attempts)
  SELECT x.id, s.delivery_id, x.family, x.attempt_no, x.mode, x.bound_head_sha, x.trigger_reason, x.trigger_fact_id, x.task_id, x.trigger, x.status, x.max_attempts
  FROM ${sql.identifier(src)} s, jsonb_to_recordset(${jsonb(rows)}) AS x(id uuid, family text, attempt_no int, mode text, bound_head_sha text, trigger_reason text, trigger_fact_id uuid, task_id uuid, trigger text, status text, max_attempts int)
  RETURNING id
)`);
  }
  ops.forEach((o, i) => {
    if (o.op === 'update') {
      const sets: SQL[] = [sql`updated_at = now()`];
      if (o.set.status !== undefined) sets.push(sql`status = ${o.set.status}::text`);
      if (o.set.outcome !== undefined) sets.push(sql`outcome = ${o.set.outcome}::text`);
      if (o.set.pushedHeadSha !== undefined) sets.push(sql`pushed_head_sha = ${o.set.pushedHeadSha}::text`);
      if (o.set.appendReportedSha !== undefined) {
        sets.push(sql`reported_shas = CASE WHEN ${o.set.appendReportedSha}::text = ANY(wa.reported_shas) THEN wa.reported_shas ELSE array_append(wa.reported_shas, ${o.set.appendReportedSha}::text) END`);
      }
      if (o.set.ended) sets.push(sql`ended_at = now()`);
      out.push(sql`${sql.identifier(`a_upd_${i}`)} AS (
  UPDATE workflow_attempts wa SET ${sql.join(sets, sql`, `)}
  FROM ${sql.identifier(src)} s
  WHERE wa.id = ${o.attemptId}::uuid AND wa.delivery_id = s.delivery_id
    AND wa.status IN (SELECT jsonb_array_elements_text(${jsonb(o.whenStatus)}))
  RETURNING wa.id
)`);
    } else if (o.op === 'cancel_open') {
      out.push(sql`${sql.identifier(`a_cancel_${i}`)} AS (
  UPDATE workflow_attempts wa SET status = ${o.status}::text, outcome = 'noop', ended_at = now(), updated_at = now()
  FROM ${sql.identifier(src)} s
  WHERE wa.delivery_id = s.delivery_id AND wa.status IN ('queued', 'running')
    AND wa.family IN (SELECT jsonb_array_elements_text(${jsonb(o.families)}))
    ${o.headSha ? sql`AND wa.bound_head_sha = ${o.headSha}::text` : sql``}
  RETURNING wa.id
)`);
    }
  });
  return out;
}

// ── Statements ──────────────────────────────────────────────────────────────

/**
 * The single statement that applies `decision`. Returns one row
 * `{ transition_id, delivery_id, version }` when it committed, zero rows when
 * the CAS guard (version, allowed states, bound head/round) did not match.
 */
export function transitionSql(decision: ApplyDecision, ref: { deliveryId?: string | null; factId?: string | null } = {}): SQL {
  const d = decision;
  const ctes: SQL[] = [];
  const patch = patchEntries(d.patch);

  if (d.create) {
    const cols: SQL[] = [sql`workspace_id`, sql`owner_task_id`, sql`state`, sql`version`, sql`max_rounds`, sql`last_transition_at`];
    const vals: SQL[] = [sql`${d.create.workspaceId}::uuid`, sql`${d.create.ownerTaskId}::uuid`, sql`${d.toState}::text`, sql`1`, sql`${d.create.maxRounds}::int`, sql`now()`];
    for (const [col, val] of patch) {
      if (col === 'max_rounds') continue;
      cols.push(sql`${sql.identifier(col)}`); vals.push(val);
    }
    ctes.push(sql`d AS (
  INSERT INTO workflow_deliveries (${sql.join(cols, sql`, `)})
  VALUES (${sql.join(vals, sql`, `)})
  ON CONFLICT (workspace_id, owner_task_id) DO NOTHING
  RETURNING id, version
)`);
  } else {
    if (!ref.deliveryId) throw new Error('transitionSql: deliveryId required for a non-creating transition');
    const sets: SQL[] = [
      sql`state = ${d.toState}::text`,
      sql`version = version + 1`,
      sql`updated_at = now()`,
      sql`last_transition_at = now()`,
      ...patch.map(([col, val]) => sql`${sql.identifier(col)} = ${val}`),
    ];
    const where: SQL[] = [
      sql`id = ${ref.deliveryId}::uuid`,
      sql`version = ${d.guard.version}::bigint`,
      sql`state IN (SELECT jsonb_array_elements_text(${jsonb(d.guard.states)}))`,
    ];
    if (d.guard.headSha !== undefined) where.push(sql`current_head_sha IS NOT DISTINCT FROM ${d.guard.headSha}::text`);
    if (d.guard.round !== undefined) where.push(sql`current_round = ${d.guard.round}::int`);
    ctes.push(sql`d AS (
  UPDATE workflow_deliveries SET ${sql.join(sets, sql`, `)}
  WHERE ${sql.join(where, sql` AND `)}
  RETURNING id, version
)`);
  }

  ctes.push(sql`t AS (
  INSERT INTO workflow_transitions (delivery_id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence, bypass)
  SELECT d.id, d.version - 1, d.version, ${d.fromState}::text, ${d.toState}::text, ${d.command}::text, ${d.idempotencyKey}::text,
    ${String(d.evidence.actor ?? 'kernel')}::text, ${jsonb(d.evidence)}, ${d.bypass ? jsonb(d.bypass) : sql`NULL::jsonb`}
  FROM d
  RETURNING id, delivery_id, to_version
)`);

  if (d.effects.length) {
    const rows = d.effects.map((e) => ({ kind: e.kind, dedupe_key: e.dedupeKey, payload: e.payload, delay_ms: e.delayMs ?? 0 }));
    ctes.push(sql`e AS (
  INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, not_before)
  SELECT t.delivery_id, t.id, x.kind, x.dedupe_key, x.payload, now() + make_interval(secs => x.delay_ms / 1000.0)
  FROM t, jsonb_to_recordset(${jsonb(rows)}) AS x(kind text, dedupe_key text, payload jsonb, delay_ms bigint)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id
)`);
  }

  ctes.push(...roundCtes(d.rounds, 't'));
  ctes.push(...attemptCtes(d.attempts, 't'));

  if (ref.factId) {
    ctes.push(sql`f AS (
  UPDATE workflow_facts wf SET applied_transition_id = t.id, delivery_id = t.delivery_id
  FROM t WHERE wf.id = ${ref.factId}::uuid
  RETURNING wf.id
)`);
  }

  return sql`-- workflow:transition
WITH ${sql.join(ctes, sql`,\n`)}
SELECT t.id AS transition_id, t.delivery_id, t.to_version AS version FROM t`;
}

/** Writes kept for audit when no transition applies (a stale verdict, a skipped fix). */
export function recordOnlySql(deliveryId: string, record: RecordOnly): SQL | null {
  const ctes = [...roundCtes(record.rounds, 'src'), ...attemptCtes(record.attempts, 'src')];
  if (ctes.length === 0) return null;
  return sql`-- workflow:record
WITH src AS (SELECT ${deliveryId}::uuid AS delivery_id),
${sql.join(ctes, sql`,\n`)}
SELECT 1 AS recorded`;
}

export type DeliveryRef =
  | { deliveryId: string }
  | { workspaceId: string; ownerTaskId: string }
  | { workspaceId: string; repoFullName: string; prNumber: number };

/** One read of everything the reducer needs for one delivery. */
export function loadViewSql(ref: DeliveryRef): SQL {
  const where = 'deliveryId' in ref
    ? sql`d.id = ${ref.deliveryId}::uuid`
    : 'ownerTaskId' in ref
      ? sql`d.workspace_id = ${ref.workspaceId}::uuid AND d.owner_task_id = ${ref.ownerTaskId}::uuid`
      : sql`d.workspace_id = ${ref.workspaceId}::uuid AND d.repo_full_name = ${ref.repoFullName}::text AND d.pr_number = ${ref.prNumber}::int`;
  return sql`-- workflow:load_view
SELECT to_jsonb(d.*) AS delivery,
  COALESCE((SELECT jsonb_agg(to_jsonb(r.*) ORDER BY r.round) FROM workflow_review_rounds r WHERE r.delivery_id = d.id), '[]'::jsonb) AS rounds,
  COALESCE((SELECT jsonb_agg(to_jsonb(a.*) ORDER BY a.family, a.mode, a.attempt_no) FROM workflow_attempts a WHERE a.delivery_id = d.id), '[]'::jsonb) AS attempts
FROM workflow_deliveries d
WHERE ${where}
LIMIT 1`;
}

export function findTransitionSql(deliveryId: string, idempotencyKey: string): SQL {
  return sql`-- workflow:find_transition
SELECT id, to_version, to_state FROM workflow_transitions
WHERE delivery_id = ${deliveryId}::uuid AND idempotency_key = ${idempotencyKey}::text
LIMIT 1`;
}

// ── Row mapping ─────────────────────────────────────────────────────────────

type J = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number => (v == null ? 0 : Number(v));

export function toDeliverySnapshot(r: J): DeliverySnapshot {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    ownerTaskId: String(r.owner_task_id),
    repoFullName: s(r.repo_full_name),
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    baseRef: s(r.base_ref),
    state: String(r.state) as DeliveryState,
    stateReason: s(r.state_reason),
    version: n(r.version),
    currentHeadSha: s(r.current_head_sha),
    currentRound: n(r.current_round),
    maxRounds: n(r.max_rounds),
    boundAttemptId: s(r.bound_attempt_id),
    resumeState: s(r.resume_state) as DeliveryState | null,
    trunkIncidentId: s(r.trunk_incident_id),
    approvedHeads: (r.approved_heads as string[] | null) ?? [],
    approvalBasis: s(r.approval_basis) as ApprovalBasis | null,
    compositionHeads: (r.composition_heads as string[] | null) ?? [],
    ci: s(r.ci),
    ciHeadSha: s(r.ci_head_sha),
    mergeable: s(r.mergeable),
    mergeableHeadSha: s(r.mergeable_head_sha),
    mergedAt: s(r.merged_at),
    mergeCommitSha: s(r.merge_commit_sha),
    supersededByPr: r.superseded_by_pr == null ? null : Number(r.superseded_by_pr),
    authority: r.authority === 'legacy' ? 'legacy' : 'kernel',
  };
}

export function toRoundSnapshot(r: J): RoundSnapshot {
  return {
    id: String(r.id), round: n(r.round), headSha: String(r.head_sha), kind: r.kind as RoundSnapshot['kind'],
    status: r.status as RoundSnapshot['status'], verdict: (r.verdict ?? null) as RoundSnapshot['verdict'],
    effectiveVerdict: (r.effective_verdict ?? null) as RoundSnapshot['effectiveVerdict'], failureCount: n(r.failure_count),
    reviewerTaskId: s(r.reviewer_task_id),
  };
}

export function toAttemptSnapshot(r: J): AttemptSnapshot {
  return {
    id: String(r.id), family: r.family as AttemptSnapshot['family'], attemptNo: n(r.attempt_no), mode: r.mode as AttemptSnapshot['mode'],
    boundHeadSha: s(r.bound_head_sha), triggerReason: s(r.trigger_reason), taskId: s(r.task_id),
    status: r.status as AttemptSnapshot['status'], outcome: (r.outcome ?? null) as AttemptSnapshot['outcome'],
    maxAttempts: n(r.max_attempts), reportedShas: (r.reported_shas as string[] | null) ?? [],
    trigger: r.trigger === 'human' ? 'human' : 'automatic',
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export type CommandResult =
  | { result: 'applied'; transitionId: string; deliveryId: string; version: number; decision: ApplyDecision }
  | { result: 'duplicate'; transitionId: string | null; reason: string; current: CurrentView }
  | { result: 'stale'; reason: string; current: CurrentView }
  | { result: 'rejected'; reason: string; missing?: string[]; current: CurrentView };

export interface KernelDeps {
  exec?: Exec;
  newId?: () => string;
}

export async function loadView(ref: DeliveryRef, exec: Exec = dbExec): Promise<KernelView> {
  const row = ((await exec(loadViewSql(ref))).rows ?? [])[0] as { delivery: J; rounds: J[]; attempts: J[] } | undefined;
  if (!row) return { delivery: null, rounds: [], attempts: [] };
  return {
    delivery: toDeliverySnapshot(row.delivery),
    rounds: (row.rounds ?? []).map(toRoundSnapshot),
    attempts: (row.attempts ?? []).map(toAttemptSnapshot),
  };
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: string }).code;
    if (code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return /duplicate key value violates unique constraint/.test(String((err as Error)?.message ?? ''));
}

function refFor(cmd: Command, ref: DeliveryRef | undefined): DeliveryRef {
  if (ref) return ref;
  if (cmd.type === 'DeliveryOpened') return { workspaceId: cmd.workspaceId, ownerTaskId: cmd.ownerTaskId };
  if (cmd.type === 'PrBound' && cmd.adoption) return { workspaceId: cmd.adoption.workspaceId, ownerTaskId: cmd.adoption.ownerTaskId };
  throw new Error(`applyCommand: a delivery ref is required for ${cmd.type}`);
}

/**
 * Apply one command (§7.2): read, reduce, write with the version read; on a
 * CAS miss re-read and re-evaluate ONCE, then answer `stale`.
 */
export async function applyCommand(
  cmd: Command,
  opts: { ref?: DeliveryRef; factId?: string | null } & KernelDeps = {},
): Promise<CommandResult> {
  const exec = opts.exec ?? dbExec;
  const ref = refFor(cmd, opts.ref);
  let view = await loadView(ref, exec);

  for (let pass = 0; pass < 2; pass++) {
    const d = view.delivery;
    const key = stableIdempotencyKey(cmd, d);
    if (d && key) {
      const hit = ((await exec(findTransitionSql(d.id, key))).rows ?? [])[0] as { id: string } | undefined;
      if (hit) return { result: 'duplicate', transitionId: hit.id, reason: 'idempotency_key_seen', current: currentOf(view) };
    }

    const decision = reduce(view, cmd, { newId: opts.newId });
    if (decision.result === 'duplicate') return { result: 'duplicate', transitionId: null, reason: decision.reason, current: decision.current };
    if (decision.result === 'stale' || decision.result === 'rejected') {
      if (d && decision.record) {
        const q = recordOnlySql(d.id, decision.record);
        if (q) await exec(q);
      }
      return decision.result === 'stale'
        ? { result: 'stale', reason: decision.reason, current: decision.current }
        : { result: 'rejected', reason: decision.reason, missing: decision.missing, current: decision.current };
    }

    let row: { transition_id: string; delivery_id: string; version: number | string } | undefined;
    try {
      row = ((await exec(transitionSql(decision, { deliveryId: d?.id ?? null, factId: opts.factId ?? null }))).rows ?? [])[0] as typeof row;
    } catch (err) {
      // A replayed key (or a racing single-flight insert) aborts the statement
      // atomically; nothing was written. Re-read and decide again.
      if (!isUniqueViolation(err)) throw err;
    }
    if (row) {
      return { result: 'applied', transitionId: row.transition_id, deliveryId: row.delivery_id, version: Number(row.version), decision };
    }
    view = await loadView(d ? { deliveryId: d.id } : ref, exec);
    if (decision.create && view.delivery) {
      // Lost the open race: the delivery exists; T1 / adoption replay is a duplicate.
      return { result: 'duplicate', transitionId: null, reason: 'delivery_exists', current: currentOf(view) };
    }
  }
  return { result: 'stale', reason: 'cas_conflict', current: currentOf(view) };
}
