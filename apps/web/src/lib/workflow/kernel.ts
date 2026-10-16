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
 *
 * The runner itself (read → reduce → CAS → re-read once) is the package's
 * `applyCommandOn` (@buildd/workflow-kernel/command-runner); these statements
 * reach it through the Postgres store (postgres-store.ts).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { applyCommandOn } from '@buildd/workflow-kernel/command-runner';
import { isTaskId } from '@buildd/workflow-kernel/findings';
import { isRoundTrigger } from '@buildd/workflow-kernel/delta-approval';
import type { CommandResult, DeliveryRef } from '@buildd/workflow-kernel/ports';
import type { ApplyDecision, AttemptOp, Command, DeliveryPatch, FindingOp, RecordOnly, RoundOp } from './commands';
import { postgresStore } from './postgres-store';
import { prFactProjectionSql } from '@buildd/core/pr-fact-sql';
import { prRowOfDeliverySql } from './pr-fact-scope';
import { mergeTaskPayloadSql, mergeTaskProjectionCtes } from './task-projection';
import { kernelHost } from './kernel-host';
import type {
  ApprovalBasis,
  AttemptSnapshot,
  DeliverySnapshot,
  DeliveryState,
  FindingSnapshot,
  KernelView,
  RoundSnapshot,
} from './types';

export type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;
const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

const jsonb = (v: unknown): SQL => sql`${JSON.stringify(v ?? null)}::jsonb`;
const textArray = (v: string[]): SQL => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(v)}::jsonb))::text[]`;

// ── Patch → column assignments ──────────────────────────────────────────────

type Cast = 'text' | 'int' | 'uuid' | 'timestamptz' | 'text[]' | 'jsonb';
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
  policyEvidence: ['policy_evidence', 'jsonb'],
};

function castValue(v: unknown, cast: Cast): SQL {
  switch (cast) {
    case 'text[]': return textArray((v as string[] | null) ?? []);
    case 'int': return sql`${v ?? null}::int`;
    case 'uuid': return sql`${v ?? null}::uuid`;
    case 'timestamptz': return sql`${v ?? null}::timestamptz`;
    case 'jsonb': return jsonb(v);
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
    const rows = inserts.map((o) => ({
      // 58c8961e: the trigger is kept in the round's scope (no column of its own); toRoundSnapshot reads it back out.
      id: o.id, round: o.round, head_sha: o.headSha, kind: o.kind, prior_round: o.priorRound,
      scope: o.trigger ? { ...(o.scope ?? {}), [ROUND_TRIGGER_KEY]: o.trigger } : o.scope ?? null,
      status: o.decided ? 'decided' : 'queued', verdict: o.decided?.verdict ?? null, effective_verdict: o.decided?.effectiveVerdict ?? null,
      confidence: o.decided?.confidence ?? null, reviewer_task_id: o.decided?.reviewerTaskId ?? null, decided: !!o.decided,
    }));
    out.push(sql`r_ins AS (
  INSERT INTO workflow_review_rounds (id, delivery_id, round, head_sha, kind, prior_round, scope, status, verdict, effective_verdict, confidence, reviewer_task_id, decided_at)
  SELECT x.id, s.delivery_id, x.round, x.head_sha, x.kind, x.prior_round, x.scope, x.status, x.verdict, x.effective_verdict, x.confidence, x.reviewer_task_id,
    CASE WHEN x.decided THEN now() END
  FROM ${sql.identifier(src)} s, jsonb_to_recordset(${jsonb(rows)}) AS x(id uuid, round int, head_sha text, kind text, prior_round int, scope jsonb, status text, verdict text, effective_verdict text, confidence real, reviewer_task_id uuid, decided boolean)
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
    if (o.set.endReason !== undefined) {
      sets.push(sql`scope = COALESCE(rr.scope, '{}'::jsonb) || jsonb_build_object(${ROUND_END_REASON_KEY}::text, ${o.set.endReason}::text)`);
    }
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

/**
 * §5 finding writes. An insert lands under the finding's stable id (a replay
 * is a primary-key violation, which aborts the statement like any replayed
 * key). An update applies only while the finding is in one of `whenStatus`,
 * read in the statement's own snapshot. The reducer writes each finding at
 * most once per decision.
 */
const asUuid = (v: string | null): string | null => (v && isTaskId(v) ? v : null);

function findingCtes(ops: FindingOp[], src: string): SQL[] {
  const out: SQL[] = [];
  const inserts = ops.filter((o): o is Extract<FindingOp, { op: 'insert' }> => o.op === 'insert');
  if (inserts.length) {
    const rows = inserts.map((o) => ({
      id: o.id, origin_round_id: o.originRoundId, origin_round: o.originRound, origin_head_sha: o.originHeadSha, ordinal: o.ordinal,
      path: o.path, line: o.line, title: o.title, required: o.required,
    }));
    out.push(sql`f_ins AS (
  INSERT INTO workflow_findings (id, delivery_id, origin_round_id, origin_round, origin_head_sha, ordinal, path, line, title, required, status, last_round)
  SELECT x.id, s.delivery_id, x.origin_round_id, x.origin_round, x.origin_head_sha, x.ordinal, x.path, x.line, x.title, x.required, 'open', x.origin_round
  FROM ${sql.identifier(src)} s, jsonb_to_recordset(${jsonb(rows)}) AS x(id text, origin_round_id uuid, origin_round int, origin_head_sha text, ordinal int, path text, line int, title text, required boolean)
  RETURNING id
)`);
  }
  ops.forEach((o, i) => {
    if (o.op !== 'update') return;
    const sets: SQL[] = [sql`updated_at = now()`];
    const v = o.set;
    if (v.status !== undefined) sets.push(sql`status = ${v.status}::text`);
    if (v.lastRound !== undefined) sets.push(sql`last_round = ${v.lastRound}::int`);
    if (v.title !== undefined) sets.push(sql`title = ${v.title}::text`);
    if (v.required !== undefined) sets.push(sql`required = ${v.required}::boolean`);
    if (v.addressedBySha !== undefined) sets.push(sql`addressed_by_sha = ${v.addressedBySha}::text`);
    // A uuid column only ever takes a full id: anything else would abort the whole transition (and with
    // it the verdict), so it is written as NULL. The reducer refuses such a deferral before it gets here.
    if (v.closedByRoundId !== undefined) sets.push(sql`closed_by_round_id = ${asUuid(v.closedByRoundId)}::uuid`);
    if (v.closedBy !== undefined) sets.push(sql`closed_by = ${v.closedBy}::text`);
    if (v.closedReason !== undefined) sets.push(sql`closed_reason = ${v.closedReason}::text`);
    if (v.deferredToTaskId !== undefined) sets.push(sql`deferred_to_task_id = ${asUuid(v.deferredToTaskId)}::uuid`);
    out.push(sql`${sql.identifier(`f_upd_${i}`)} AS (
  UPDATE workflow_findings wf SET ${sql.join(sets, sql`, `)}
  FROM ${sql.identifier(src)} s
  WHERE wf.id = ${o.findingId}::text AND wf.delivery_id = s.delivery_id
    AND wf.status IN (SELECT jsonb_array_elements_text(${jsonb(o.whenStatus)}))
  RETURNING wf.id
)`);
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
  const projected = prRowProjection(d);
  // The projection reads the PR identity and merge instant from the delivery row it just wrote.
  const returning = projected ? sql`RETURNING id, version, workspace_id, repo_full_name, pr_number, merged_at` : sql`RETURNING id, version`;

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
  ${returning}
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
      // A release that lands between the read and this write wins (§14).
      sql`authority = 'kernel'`,
      sql`version = ${d.guard.version}::bigint`,
      sql`state IN (SELECT jsonb_array_elements_text(${jsonb(d.guard.states)}))`,
    ];
    if (d.guard.headSha !== undefined) where.push(sql`current_head_sha IS NOT DISTINCT FROM ${d.guard.headSha}::text`);
    if (d.guard.round !== undefined) where.push(sql`current_round = ${d.guard.round}::int`);
    ctes.push(sql`d AS (
  UPDATE workflow_deliveries SET ${sql.join(sets, sql`, `)}
  WHERE ${sql.join(where, sql` AND `)}
  ${returning}
)`);
  }

  // S4b (AC-2): T17 completes the owner task in this statement too, and tells the post-merge
  // effect what it did (task-projection.ts), so runMergedPrWork performs only side effects.
  const projectsTask = projected === 'merged';
  if (projectsTask) ctes.push(...mergeTaskProjectionCtes('d'));

  ctes.push(sql`t AS (
  INSERT INTO workflow_transitions (delivery_id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence, bypass, host)
  SELECT d.id, d.version - 1, d.version, ${d.fromState}::text, ${d.toState}::text, ${d.command}::text, ${d.idempotencyKey}::text,
    ${String(d.evidence.actor ?? 'kernel')}::text, ${jsonb(d.evidence)}, ${d.bypass ? jsonb(d.bypass) : sql`NULL::jsonb`}, ${kernelHost()}::text
  FROM d
  RETURNING id, delivery_id, to_version
)`);

  if (d.effects.length) {
    const rows = d.effects.map((e) => ({ kind: e.kind, dedupe_key: e.dedupeKey, payload: e.payload, delay_ms: e.delayMs ?? 0 }));
    ctes.push(sql`e AS (
  INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, not_before)
  SELECT t.delivery_id, t.id, x.kind, x.dedupe_key,
    ${projectsTask ? sql`CASE WHEN x.kind = 'emit_pr_merged' THEN COALESCE(x.payload, '{}'::jsonb) || ${mergeTaskPayloadSql()} ELSE x.payload END` : sql`x.payload`},
    now() + make_interval(secs => x.delay_ms / 1000.0)
  FROM t, jsonb_to_recordset(${jsonb(rows)}) AS x(kind text, dedupe_key text, payload jsonb, delay_ms bigint)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id
)`);
  }

  ctes.push(...roundCtes(d.rounds, 't'));
  ctes.push(...attemptCtes(d.attempts, 't'));
  ctes.push(...findingCtes(d.findings ?? [], 't'));

  // S4a (workflow-kernel-library.md §1): the worker rows of the PR are a projection of this
  // transition, written in its own statement. They move only if the delivery did (the CTE reads
  // `d`, which is empty on a CAS miss), and with the funnel's terminal-wins guard.
  if (projected) {
    ctes.push(sql`w_proj AS (\n${prFactProjectionSql({ kind: projected }, { from: sql`d`, where: prRowOfDeliverySql('d'), mergedAt: sql`d.merged_at` })}\n)`);
  }

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

/**
 * Which terminal fact a transition projects onto the worker rows of its PR: the reducer's
 * `stamp_pr_rows` (T17 merged, T18 closed) names the transitions that change them, and the
 * target state says which. The effect stays as a replay-safe backstop (a row that adopts the PR
 * between the statement and the drain); after the statement it finds nothing left to write.
 */
function prRowProjection(d: ApplyDecision): 'merged' | 'closed' | null {
  if (!d.effects.some((e) => e.kind === 'stamp_pr_rows')) return null;
  if (d.toState === 'MERGED') return 'merged';
  if (d.toState === 'CLOSED_UNMERGED') return 'closed';
  return null;
}

/** Writes kept for audit when no transition applies (a stale verdict, a skipped fix). */
export function recordOnlySql(deliveryId: string, record: RecordOnly): SQL | null {
  const ctes = [...roundCtes(record.rounds, 'src'), ...attemptCtes(record.attempts, 'src'), ...findingCtes(record.findings ?? [], 'src')];
  if (ctes.length === 0) return null;
  return sql`-- workflow:record
WITH src AS (SELECT ${deliveryId}::uuid AS delivery_id),
${sql.join(ctes, sql`,\n`)}
SELECT 1 AS recorded`;
}

/** One read of everything the reducer needs for one delivery. */
export function loadViewSql(ref: DeliveryRef): SQL {
  const where = 'deliveryId' in ref
    ? sql`d.id = ${ref.deliveryId}::uuid`
    : 'ownerTaskId' in ref
      ? sql`d.workspace_id = ${ref.workspaceId}::uuid AND d.owner_task_id = ${ref.ownerTaskId}::uuid`
      : sql`d.workspace_id = ${ref.workspaceId}::uuid AND d.repo_full_name = ${ref.repoFullName}::text AND d.pr_number = ${ref.prNumber}::int`;
  return sql`-- workflow:load_view
SELECT to_jsonb(d.*) || jsonb_build_object('push_pending_local_head', (
    SELECT t.evidence->>'localHeadSha' FROM workflow_transitions t
    WHERE t.delivery_id = d.id AND t.to_state = 'AWAITING_PUSH' AND t.from_state IS DISTINCT FROM 'AWAITING_PUSH'
    ORDER BY t.to_version DESC LIMIT 1),
  'push_entries', (
    SELECT count(*) FROM workflow_transitions t
    WHERE t.delivery_id = d.id AND t.to_state = 'AWAITING_PUSH' AND t.from_state IS DISTINCT FROM 'AWAITING_PUSH'),
  'push_pending_since', (
    SELECT max(t.to_version) FROM workflow_transitions t
    WHERE t.delivery_id = d.id AND t.to_state = 'AWAITING_PUSH' AND t.from_state IS DISTINCT FROM 'AWAITING_PUSH')) AS delivery,
  COALESCE((SELECT jsonb_agg(to_jsonb(r.*) ORDER BY r.round) FROM workflow_review_rounds r WHERE r.delivery_id = d.id), '[]'::jsonb) AS rounds,
  COALESCE((SELECT jsonb_agg(to_jsonb(a.*) ORDER BY a.family, a.mode, a.attempt_no) FROM workflow_attempts a WHERE a.delivery_id = d.id), '[]'::jsonb) AS attempts,
  COALESCE((SELECT jsonb_agg(to_jsonb(f.*) ORDER BY f.origin_round, f.ordinal, f.created_at) FROM workflow_findings f WHERE f.delivery_id = d.id), '[]'::jsonb) AS findings
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
    supersededByUrl: s(r.superseded_by_url),
    supersededReason: s(r.superseded_reason),
    recordedBy: s(r.recorded_by),
    policyEvidence: (r.policy_evidence as DeliverySnapshot['policyEvidence']) ?? null,
    authority: r.authority === 'legacy' ? 'legacy' : 'kernel',
    pushPendingLocalHead: s(r.push_pending_local_head),
    pushEntries: Number(r.push_entries ?? 0),
    pushPendingSince: r.push_pending_since == null ? null : Number(r.push_pending_since),
  };
}

/** Where a round's trigger and end reason live inside `workflow_review_rounds.scope` (58c8961e). */
export const ROUND_TRIGGER_KEY = 'trigger';
export const ROUND_END_REASON_KEY = 'endReason';

export function toRoundSnapshot(r: J): RoundSnapshot {
  const raw = (r.scope as Record<string, unknown> | null) ?? null;
  const { [ROUND_TRIGGER_KEY]: trigger, [ROUND_END_REASON_KEY]: endReason, ...rest } = raw ?? {};
  const scope = raw && Object.keys(rest).length > 0 ? rest : null;
  return {
    id: String(r.id), round: n(r.round), headSha: String(r.head_sha), kind: r.kind as RoundSnapshot['kind'],
    status: r.status as RoundSnapshot['status'], verdict: (r.verdict ?? null) as RoundSnapshot['verdict'],
    effectiveVerdict: (r.effective_verdict ?? null) as RoundSnapshot['effectiveVerdict'], failureCount: n(r.failure_count),
    reviewerTaskId: s(r.reviewer_task_id),
    scope,
    ...(isRoundTrigger(trigger) ? { trigger } : {}),
    ...(typeof endReason === 'string' ? { endReason } : {}),
  };
}

export function toFindingSnapshot(r: J): FindingSnapshot {
  return {
    id: String(r.id), originRoundId: String(r.origin_round_id), originRound: n(r.origin_round), originHeadSha: String(r.origin_head_sha),
    ordinal: n(r.ordinal), path: s(r.path), line: r.line == null ? null : Number(r.line), title: String(r.title), required: r.required !== false,
    status: r.status as FindingSnapshot['status'], lastRound: n(r.last_round), addressedBySha: s(r.addressed_by_sha),
    closedByRoundId: s(r.closed_by_round_id), closedBy: s(r.closed_by), closedReason: s(r.closed_reason), deferredToTaskId: s(r.deferred_to_task_id),
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

export type { CommandResult, DeliveryRef } from '@buildd/workflow-kernel/ports';

export interface KernelDeps {
  exec?: Exec;
  newId?: () => string;
}

/** One read of everything the reducer needs for one delivery (`loadViewSql`, through the Postgres store). */
export async function loadView(ref: DeliveryRef, exec: Exec = dbExec): Promise<KernelView> {
  return postgresStore(exec).loadView(ref);
}

/**
 * Apply one command (§7.2): read, reduce, write with the version read; on a
 * CAS miss re-read and re-evaluate ONCE, then answer `stale`. The loop is the
 * package's (`applyCommandOn`); the statements are this file's, run by the
 * Postgres store.
 */
export async function applyCommand(
  cmd: Command,
  opts: { ref?: DeliveryRef; factId?: string | null } & KernelDeps = {},
): Promise<CommandResult> {
  return applyCommandOn(postgresStore(opts.exec ?? dbExec), cmd, { ref: opts.ref, factId: opts.factId, newId: opts.newId });
}
