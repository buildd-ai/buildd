/**
 * S4b (workflow-kernel-library.md §1, AC-2): the owner-task projection T17 embeds, rendered through
 * the real PgDialect. Behaviour on Postgres is tests/db/kernel-pr-projection.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { attemptEndTaskProjectionCtes, endingWorkerIsCurrentSql, reapedOwnerAttemptIsCurrentSql, isAttemptRow, isAttemptRowSql, mergeTaskPayloadSql, mergeTaskProjectionCtes, mergeTaskTransitionOf, ownerAttemptEndOf, ownerEndTaskStatus, projectOwnerEndSql, OWNER_END_SETTLE_MS, CLAIM_CLOCK_SKEW_MS } from './task-projection';
import { projectRequeueSql, requeueingAttemptIsCurrentSql, requeueTaskProjectionCtes } from './task-projection';
import { ownerClaimOpenSql, projectAttemptStartSql, startTaskProjectionCtes } from './task-projection';
import { escalatesCi, escalationTaskProjectionCtes, projectLoopExitSql } from './task-projection';
import { notOwnerTaskSql, projectReopenSql, projectWithdrawSql, reopenTaskProjectionCtes, withdrawTaskProjectionCtes } from './task-projection';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('mergeTaskProjectionCtes', () => {
  const ctes = mergeTaskProjectionCtes('d').map((c) => render(c));

  test('own: the PR\'s first worker row of the delivery, by the shared row predicate', () => {
    expect(ctes[0].sql).toContain('own AS (\n  SELECT w.id, w.task_id, w.runner FROM workers w, d');
    expect(ctes[0].sql).toContain("w.workspace_id = d.workspace_id AND w.pr_number = d.pr_number AND lower(w.pr_url) = lower('https://github.com/' || d.repo_full_name || '/pull/' || d.pr_number::text)");
    expect(ctes[0].sql).toContain('ORDER BY w.created_at ASC, w.id ASC\n  LIMIT 1');
  });

  test('t_proj: completes the task unless completed, a local session, or another open PR', () => {
    const { sql: t, params } = ctes[2];
    expect(t).toContain("t_proj AS (\n  UPDATE tasks tk SET status = 'completed', updated_at = now()\n  FROM own, d");
    expect(t).toContain("tk.id = own.task_id AND tk.status <> 'completed'");
    expect(t).toContain('own.runner IS DISTINCT FROM $1::text');
    expect(params[0]).toBe('mcp');
    expect(t).toContain('lower(ow.pr_url) <> lower(');
    expect(t).toContain('ow.pr_lifecycle_status NOT IN ($2::text, $3::text, $4::text)');
    expect(params.slice(1)).toEqual(['merged', 'closed', 'unresolvable']);
    expect(t).toContain('mw.merged_at IS NOT NULL');
  });

  test('the payload names what the statement did and for which row', () => {
    const { sql: p } = render(mergeTaskPayloadSql());
    expect(p).toContain("WHEN EXISTS (SELECT 1 FROM t_proj) THEN 'flipped'");
    expect(p).toContain("WHEN (SELECT status FROM own_task) = 'completed' THEN 'already_completed'");
    expect(p).toContain("'ownerWorkerId', (SELECT id FROM own)");
    expect(render(sql`${mergeTaskPayloadSql()}`).sql).toContain('jsonb_build_object(');
  });
});

describe('mergeTaskTransitionOf', () => {
  test('reads the statement\'s answer; an effect from before S4b has none', () => {
    expect(mergeTaskTransitionOf({ taskTransition: 'flipped', ownerWorkerId: 'w1' })).toEqual({ taskTransition: 'flipped', ownerWorkerId: 'w1' });
    expect(mergeTaskTransitionOf({ taskTransition: 'not_flipped', ownerWorkerId: null })).toEqual({ taskTransition: 'not_flipped', ownerWorkerId: null });
    expect(mergeTaskTransitionOf({ mergeCommitSha: 'x' })).toBeNull();
    expect(mergeTaskTransitionOf(undefined)).toBeNull();
    expect(mergeTaskTransitionOf({ taskTransition: 'bogus' })).toBeNull();
  });
});

describe('ownerAttemptEndOf (AC-1 slice 2): the end is read from the worker row', () => {
  const NOW = Date.parse('2026-10-17T12:00:00Z');
  const ago = (m: number) => new Date(NOW - m * 60_000);
  const settled = OWNER_END_SETTLE_MS / 60_000 + 1;
  /** A running owner task: `assigned` for its whole attempt, claimed `claimedMin` minutes ago. */
  const assigned = (claimedMin = settled + 10) => ({ status: 'assigned', claimedAt: ago(claimedMin) });
  /** The claim's worker, created after the claim, last written `changedMin` minutes ago. */
  const wk = (status: string, changedMin = settled, createdMin = settled + 5) => ({ status, createdAt: ago(createdMin), updatedAt: ago(changedMin) });

  test('an assigned task whose worker of this claim finished and settled: the end counts', () => {
    expect(ownerAttemptEndOf(assigned(), wk('completed'), NOW)).toBe('completed');
    expect(ownerAttemptEndOf(assigned(), wk('failed'), NOW)).toBe('failed');
    expect(ownerAttemptEndOf(assigned(), wk('error'), NOW)).toBe('failed');
  });

  test('assigned with claimedAt newer than the latest worker: a claim in flight, the old row is not its end', () => {
    // The claim stamped claimed_at and assigned; its own worker row is not inserted yet.
    const inFlight = { status: 'assigned', claimedAt: ago(settled) };
    expect(ownerAttemptEndOf(inFlight, wk('failed', settled + 5, settled + 30), NOW)).toBeNull();
    // Inside the clock allowance it is this claim's worker.
    const justAfter = { status: 'assigned', claimedAt: new Date(ago(settled + 5).getTime() + CLAIM_CLOCK_SKEW_MS - 1) };
    expect(ownerAttemptEndOf(justAfter, wk('completed', settled, settled + 5), NOW)).toBe('completed');
  });

  test('a worker row changed within the settle window: the PATCH that wrote it may still requeue (no end yet)', () => {
    expect(ownerAttemptEndOf(assigned(), wk('failed', 0), NOW)).toBeNull();
    expect(ownerAttemptEndOf(assigned(), wk('completed', settled - 2), NOW)).toBeNull();
  });

  test('a terminal task: the PATCH has decided, the end counts at once', () => {
    expect(ownerAttemptEndOf({ status: 'completed', claimedAt: ago(1) }, wk('completed', 0, 0), NOW)).toBe('completed');
    expect(ownerAttemptEndOf({ status: 'failed' }, wk('error', 0, 0), NOW)).toBe('failed');
  });

  test('a live worker is no end, even on a terminal task', () => {
    for (const s of ['idle', 'starting', 'running', 'waiting_input', 'paused', 'superseded', null]) {
      expect(ownerAttemptEndOf({ status: 'completed' }, wk(s as string), NOW)).toBeNull();
      expect(ownerAttemptEndOf(assigned(), wk(s as string), NOW)).toBeNull();
    }
  });

  test('a queued retry (pending) or a cancel (its own end) is not an end to re-send', () => {
    expect(ownerAttemptEndOf({ status: 'pending' }, wk('failed'), NOW)).toBeNull();
    expect(ownerAttemptEndOf({ status: 'pending' }, wk('completed'), NOW)).toBeNull();
    expect(ownerAttemptEndOf({ status: 'cancelled' }, wk('completed'), NOW)).toBeNull();
  });
});

describe('AC-1 slice 3: the owner end projection', () => {
  const ended = (evidence: Record<string, unknown>, fromState: 'WORKING' | 'FIXING' = 'WORKING') =>
    attemptEndTaskProjectionCtes({ command: 'AttemptEnded', fromState, evidence, idempotencyKey: 'end:w1' }, 'd').map((c) => render(c));

  test('t_attempt sets the owner task from the end, reading the delivery CTE, open tasks only', () => {
    const [c] = ended({ outcome: 'success' });
    expect(c.sql).toContain('t_attempt AS (\n  UPDATE tasks tk SET status = $1::text, updated_at = now()\n  FROM d JOIN workflow_deliveries od ON od.id = d.id');
    expect(c.params[0]).toBe('completed');
    expect(c.sql).toContain('tk.id = od.owner_task_id');
    expect(c.sql).toContain('tk.status IN ($2::text, $3::text)');
    expect(c.params.slice(1, 3)).toEqual(['assigned', 'in_progress']);
    expect(c.sql).toContain("NOT (tk.status = 'completed' AND EXISTS");
    expect(ended({ outcome: 'lost' })[0].params[0]).toBe('failed');
    // Only for the task's current attempt: the worker the end's key names.
    expect(c.sql).toContain('ew.id::text = $4::text AND ew.task_id = tk.id');
    expect(c.params[3]).toBe('w1');
  });

  test('endingWorkerIsCurrentSql: the latest worker row, not older than claimed_at less the skew', () => {
    const { sql: t, params } = render(endingWorkerIsCurrentSql('w9'));
    expect(t).toContain('ew.id::text = $1::text');
    expect(params[0]).toBe('w9');
    expect(t).toContain('tk.claimed_at IS NULL OR ew.created_at >= tk.claimed_at - make_interval(secs => $2::double precision)');
    expect(params[1]).toBe(CLAIM_CLOCK_SKEW_MS / 1000);
    expect(t).toContain('nw.created_at > ew.created_at OR (nw.created_at = ew.created_at AND nw.id > ew.id)');
  });

  test('reapedOwnerAttemptIsCurrentSql: an open task, an attempt row (no placeholder), its current attempt; the task alias is the caller\'s', () => {
    const { sql: t, params } = render(reapedOwnerAttemptIsCurrentSql('w7'));
    expect(t).toContain("tk.status IN ($1::text, $2::text)");
    expect(params.slice(0, 2)).toEqual(['assigned', 'in_progress']);
    expect(t).toContain('rw.id::text = $3::text AND (rw.runner IS NULL OR rw.runner NOT IN');
    expect(params).toContain('external');
    expect(t).toContain('ew.task_id = tk.id');
    // Inside a drizzle update(tasks) the row is `tasks`, unaliased.
    const inUpdate = render(reapedOwnerAttemptIsCurrentSql('w7', 'tasks')).sql;
    expect(inUpdate).toContain('tasks.status IN (');
    expect(inUpdate).toContain('ew.task_id = tasks.id');
    expect(inUpdate).toContain('nw.task_id = tasks.id');
    expect(inUpdate).not.toContain('tk.');
  });

  test('no CTE for a requeue, a repair\'s end, another command, or an end with no outcome', () => {
    expect(ended({ outcome: 'unproven', requeue: true })).toEqual([]);
    expect(ended({ outcome: 'success' }, 'FIXING')).toEqual([]);
    expect(ended({})).toEqual([]);
    expect(attemptEndTaskProjectionCtes({ command: 'PrMerged', fromState: 'WORKING', evidence: { outcome: 'success' }, idempotencyKey: 'merged:1' })).toEqual([]);
    expect(attemptEndTaskProjectionCtes({ command: 'AttemptEnded', fromState: 'WORKING', evidence: { outcome: 'success' }, idempotencyKey: 'other' })).toEqual([]);
  });

  test('ownerEndTaskStatus: success completes, every other end fails, a requeue is none', () => {
    expect(ownerEndTaskStatus({ outcome: 'success' })).toBe('completed');
    for (const o of ['failed', 'lost', 'unproven']) expect(ownerEndTaskStatus({ outcome: o })).toBe('failed');
    expect(ownerEndTaskStatus({ outcome: 'success', requeue: true })).toBeNull();
    expect(ownerEndTaskStatus(null)).toBeNull();
  });

  test('projectOwnerEndSql: the ledger\'s recorded end wins over the end sent', () => {
    const { sql: t, params } = render(projectOwnerEndSql({ deliveryId: 'd1', taskId: 't1', workerId: 'w1', fallback: 'failed' }));
    expect(t).toContain('WHERE delivery_id = $1::uuid AND idempotency_key = $2::text');
    expect(params.slice(0, 2)).toEqual(['d1', 'end:w1']);
    expect(t).toContain("WHEN (SELECT (evidence->>'requeue') = 'true' FROM rec) THEN NULL");
    expect(t).toContain("WHEN (SELECT evidence->>'outcome' FROM rec) = 'success' THEN 'completed'");
    expect(t).toContain('od.owner_task_id = tk.id');
    expect(t).toContain('RETURNING tk.status');
  });
});

describe('attempt rows (review of #5049, round 2)', () => {
  test('isAttemptRowSql excludes the placeholder runners; a NULL runner is an attempt', () => {
    const { sql: t, params } = render(isAttemptRowSql('nw'));
    expect(t).toBe('(nw.runner IS NULL OR nw.runner NOT IN ($1::text, $2::text, $3::text))');
    expect(params).toEqual(['system', 'external', 'openclaw']);
    expect(render(endingWorkerIsCurrentSql('w1')).sql).toContain('nw.task_id = tk.id AND (nw.runner IS NULL OR nw.runner NOT IN');
  });

  test('isAttemptRow mirrors it', () => {
    expect(isAttemptRow({ runner: 'external' })).toBe(false);
    expect(isAttemptRow({ runner: 'system' })).toBe(false);
    expect(isAttemptRow({ runner: 'mcp' })).toBe(true);
    expect(isAttemptRow({ runner: 'runner-1' })).toBe(true);
    expect(isAttemptRow({ runner: null })).toBe(true);
  });
});

describe('AC-1 slice 6: the requeue projection', () => {
  const owner = { command: 'AttemptRequeued' as const, evidence: { requeue: true, reason: 'retry', workerId: 'w-1', taskId: 't-1' } };

  test('t_requeue: the owner task back to pending with its claim released, reading the delivery CTE, under the current-attempt guard', () => {
    const [cte] = requeueTaskProjectionCtes(owner, 'd');
    const { sql: t, params } = render(cte);
    expect(t).toContain("t_requeue AS (\n  UPDATE tasks tk SET status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL, updated_at = now()\n  FROM d");
    expect(t).toContain('tk.id = (SELECT od.owner_task_id FROM workflow_deliveries od WHERE od.id = d.id)');
    expect(t).toContain("tk.status IN ($1::text, $2::text)");
    expect(params.slice(0, 2)).toEqual(['assigned', 'in_progress']);
    expect(t).toContain('ew.task_id = tk.id');
    expect(t).toContain('NOT EXISTS (SELECT 1 FROM workers nw WHERE nw.task_id = tk.id');
    expect(params).toContain('w-1');
    expect(t).toContain('RETURNING tk.id');
  });

  test('t_requeue for a repair: the open ledger row\'s own task, never the owner', () => {
    const [cte] = requeueTaskProjectionCtes({ command: 'AttemptRequeued', evidence: { requeue: true, reason: 'conflict_recovery', workerId: 'w-2', attemptId: 'a-1' } }, 'd');
    const { sql: t, params } = render(cte);
    expect(t).toContain("tk.id = (SELECT wa.task_id FROM workflow_attempts wa\n        WHERE wa.id = $1::uuid AND wa.delivery_id = d.id AND wa.status IN ('queued', 'running'))");
    expect(params[0]).toBe('a-1');
    expect(t).not.toContain('SELECT od.owner_task_id');
  });

  test('nothing for any other decision, or a requeue with no worker named', () => {
    expect(requeueTaskProjectionCtes({ command: 'AttemptEnded', evidence: { requeue: true, workerId: 'w-1' } })).toEqual([]);
    expect(requeueTaskProjectionCtes({ command: 'AttemptRequeued', evidence: { requeue: true } })).toEqual([]);
  });

  test('projectRequeueSql: the same move outside a transition, for the named delivery\'s task', () => {
    const { sql: t, params } = render(projectRequeueSql({ deliveryId: 'd-1', workerId: 'w-1', taskId: 't-1' }));
    expect(t).toContain('-- workflow:project_requeue');
    expect(t).toContain("UPDATE tasks tk SET status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL, updated_at = now()");
    expect(t).toContain('WHERE tk.id = $1::uuid');
    expect(t).toContain('tk.id = (SELECT od.owner_task_id FROM workflow_deliveries od WHERE od.id = $2::uuid)');
    expect(params.slice(0, 2)).toEqual(['t-1', 'd-1']);
    expect(render(projectRequeueSql({ deliveryId: 'd-1', workerId: 'w-1', taskId: 't-1', attemptId: 'a-1' })).sql).toContain('wa.delivery_id = $3::uuid');
  });

  test('requeueingAttemptIsCurrentSql: an open task, an attempt row, the current one, on the named tasks row', () => {
    const { sql: t } = render(requeueingAttemptIsCurrentSql('w-1', 'tasks'));
    expect(t).toContain('tasks.status IN (');
    expect(t).toContain('EXISTS (SELECT 1 FROM workers rw WHERE rw.id::text = ');
    expect(t).toContain('ew.task_id = tasks.id');
    expect(t).toContain('tasks.claimed_at IS NULL OR ew.created_at >= tasks.claimed_at');
    expect(t).not.toContain('tk.');
    expect(render(endingWorkerIsCurrentSql('w-1')).sql).toContain('ew.task_id = tk.id');
  });
});

describe('AC-1 slice 7: the start projection', () => {
  const STAMP = '2026-10-18 08:00:00.123456+00';
  const start = { command: 'AttemptStarted' as const, evidence: { start: true, taskId: 't-1', claimedBy: 'acct-1', claimedAt: STAMP } };

  test('t_start: the owner task to assigned, reading the delivery CTE, only while it is pending under this exact claim', () => {
    const [cte] = startTaskProjectionCtes(start, 'd');
    const { sql: t, params } = render(cte);
    expect(t).toContain("t_start AS (\n  UPDATE tasks tk SET status = 'assigned', updated_at = now()\n  FROM d");
    expect(t).toContain('tk.id = (SELECT od.owner_task_id FROM workflow_deliveries od WHERE od.id = d.id)');
    expect(t).toContain("tk.status = 'pending'");
    expect(t).toContain('tk.claimed_by::text = $');
    expect(t).toContain('::timestamptz');
    expect(params).toEqual(expect.arrayContaining(['t-1', 'acct-1', STAMP]));
    expect(t).toContain('RETURNING tk.id');
  });

  test('nothing for any other decision, or a start that names no claim', () => {
    expect(startTaskProjectionCtes({ command: 'AttemptEnded', evidence: start.evidence })).toEqual([]);
    expect(startTaskProjectionCtes({ command: 'AttemptStarted', evidence: { start: true, taskId: 't-1', claimedBy: 'acct-1' } })).toEqual([]);
    expect(startTaskProjectionCtes({ command: 'AttemptStarted', evidence: { taskId: 't-1', claimedBy: 'acct-1', claimedAt: STAMP } })).toEqual([]);
  });

  test('projectAttemptStartSql: the same move outside a transition, for the named delivery\'s owner task', () => {
    const { sql: t, params } = render(projectAttemptStartSql({ deliveryId: 'd-1', taskId: 't-1', claimedBy: 'acct-1', claimedAt: STAMP }));
    expect(t).toContain('-- workflow:project_attempt_start');
    expect(t).toContain("UPDATE tasks tk SET status = 'assigned', updated_at = now()");
    expect(t).toContain('WHERE tk.id = $1::uuid');
    expect(t).toContain('od.owner_task_id = tk.id');
    expect(t).toContain("tk.status = 'pending'");
    expect(params).toEqual(expect.arrayContaining(['t-1', 'd-1', 'acct-1', STAMP]));
  });

  test('ownerClaimOpenSql: a pending owner task is claimable unless another claim holds it, by the claim query\'s own rule', () => {
    const { sql: t } = render(ownerClaimOpenSql());
    expect(t).toBe('("tasks"."claimed_by" IS NULL OR "tasks"."expires_at" < now())');
  });
});

describe('AC-1 slice 8: an exhausted CI repair and a loop exit', () => {
  const ciEscalation = [{ kind: 'escalate_exhaustion', dedupeKey: 'k', payload: { family: 'ci', attempts: 3, max: 3 } }] as never;

  test('escalationTaskProjectionCtes: a CI escalation fails the owner task, reading the delivery CTE', () => {
    const [cte] = escalationTaskProjectionCtes({ command: 'CiFailedObserved', fromState: 'AWAITING_REVIEW', effects: ciEscalation }, 'd');
    const { sql: t } = render(sql`WITH ${cte} SELECT 1`);
    expect(t).toContain("t_escalate AS (\n  UPDATE tasks tk SET status = 'failed'");
    expect(t).toContain('FROM d JOIN workflow_deliveries od ON od.id = d.id');
    expect(t).toContain("tk.status NOT IN ('failed', 'cancelled')");
    expect(t).toContain("kd.state IN");
  });

  test('escalationTaskProjectionCtes: nothing for another family, and an owner end that escalates is t_attempt\'s', () => {
    expect(escalationTaskProjectionCtes({ command: 'CiFailedObserved', fromState: 'AWAITING_REVIEW', effects: [{ kind: 'escalate_exhaustion', dedupeKey: 'k', payload: { family: 'review_fix' } }] as never })).toEqual([]);
    expect(escalationTaskProjectionCtes({ command: 'AttemptEnded', fromState: 'WORKING', effects: ciEscalation })).toEqual([]);
    expect(escalatesCi({ effects: ciEscalation })).toBe(true);
    // The same end projects failed, not the success it reported.
    const [cte] = attemptEndTaskProjectionCtes({ command: 'AttemptEnded', fromState: 'WORKING', evidence: { outcome: 'success' }, idempotencyKey: 'end:w-1', effects: ciEscalation }, 'd');
    expect(render(sql`WITH ${cte} SELECT 1`).params).toContain('failed');
  });

  test('projectLoopExitSql: only the parked owner task, loop satisfied, no live attempt', () => {
    const { sql: t, params } = render(projectLoopExitSql({ deliveryId: 'd-1', taskId: 't-1' }));
    expect(t).toContain("UPDATE tasks tk SET status = 'completed'");
    expect(t).toContain("tk.status = 'pending' AND tk.loop_state = 'satisfied'");
    expect(t).toContain('od.owner_task_id = tk.id');
    expect(t).toMatch(/NOT EXISTS \(SELECT 1 FROM workers lw WHERE lw\.task_id = tk\.id AND .*lw\.status NOT IN/s);
    expect(params).toEqual(expect.arrayContaining(['t-1', 'd-1', 'completed', 'failed']));
  });
});

// ── AC-1 slice 9: a settled owner task reopens; a claim withdraws its start ──────────────

describe('AttemptReopened moves the owner task in the transition, guarded on the end it names', () => {
  const ev = { reopen: true, taskId: 't1', workerId: 'w1', endedAt: '2026-10-18T08:00:00.000Z', to: 'pending', reason: 'credential_restored' };

  test('t_reopen: a failed task back to the queue with its claim released, only for the named worker\'s end with no live attempt', () => {
    const [cte] = reopenTaskProjectionCtes({ command: 'AttemptReopened', evidence: ev }, 'd').map((c) => render(c));
    expect(cte.sql).toContain('t_reopen AS (');
    expect(cte.sql).toContain("status = 'pending', claimed_by = NULL, claimed_at = NULL, expires_at = NULL");
    expect(cte.sql).toContain('FROM d');
    expect(cte.sql).toContain("date_trunc('milliseconds', rw.completed_at)");
    expect(cte.sql).toContain('lw.status NOT IN');
    // A new attempt reopens only a failed task: the status list holds one entry.
    expect(cte.sql).toMatch(/tk\.status IN \(\$\d+::text\)/);
    expect(reopenTaskProjectionCtes({ command: 'AttemptRequeued', evidence: ev }, 'd')).toEqual([]);
    expect(reopenTaskProjectionCtes({ command: 'AttemptReopened', evidence: { ...ev, reopen: false } }, 'd')).toEqual([]);
  });

  test('a resume (assigned) reopens a completed or failed task, never a cancelled one, and keeps the claim', () => {
    const q = render(projectReopenSql({ deliveryId: 'd1', taskId: 't1', workerId: 'w1', endedAt: null, to: 'assigned' }));
    expect(q.sql).toContain('-- workflow:project_reopen');
    expect(q.sql).toContain("SET status = 'assigned', updated_at = now()");
    expect(q.sql).not.toContain('claimed_by = NULL');
    expect(q.params).toEqual(expect.arrayContaining(['completed', 'failed']));
    expect(q.params).not.toContain('cancelled');
    expect(q.sql).not.toContain('lw.status NOT IN');
  });

  test('with no worker named, only a task no attempt row ever ran', () => {
    const q = render(projectReopenSql({ deliveryId: 'd1', taskId: 't1', workerId: null, endedAt: null, to: 'pending' }));
    expect(q.sql).toContain('NOT EXISTS (SELECT 1 FROM workers rw WHERE rw.task_id = tk.id');
  });
});

describe('AttemptWithdrawn gives a claim back, or refuses a queued task, guarded on exactly that claim', () => {
  const claim = { claimedBy: 'a1', claimedAt: '2026-10-18 08:00:00.123456+00' };

  test('t_withdraw with a claim: an assigned task under that exact claim with no attempt row since it', () => {
    const [cte] = withdrawTaskProjectionCtes({ command: 'AttemptWithdrawn', evidence: { withdraw: true, taskId: 't1', claim, outcome: 'requeued', reason: 'account_cap' } }, 'd').map((c) => render(c));
    expect(cte.sql).toContain('t_withdraw AS (');
    expect(cte.sql).toContain("tk.status = 'assigned'");
    expect(cte.sql).toContain('tk.claimed_at = $');
    expect(cte.sql).toContain('cw.created_at >= tk.claimed_at');
    expect(cte.params).toEqual(expect.arrayContaining(['a1', claim.claimedAt, 'pending']));
    expect(cte.sql).not.toContain('set_config');
  });

  test('the claim route\'s own rollback tells the tasks trigger not to wake dispatch', () => {
    const q = render(projectWithdrawSql({ deliveryId: 'd1', taskId: 't1', claim, outcome: 'requeued', reason: 'claim_rollback' }));
    expect(q.sql).toContain("set_config('buildd.dispatch_hint'");
    expect(q.params).toContain(JSON.stringify({ suppress: 'claim_rollback' }));
  });

  test('with no claim: a queued task no live claim holds and no attempt runs, failed', () => {
    const q = render(projectWithdrawSql({ deliveryId: 'd1', taskId: 't1', claim: null, outcome: 'failed', reason: 'workspace_mismatch' }));
    expect(q.sql).toContain("tk.status = 'pending' AND (tk.claimed_by IS NULL OR tk.expires_at < now())");
    expect(q.sql).toContain('lw.status NOT IN');
    expect(q.params).toContain('failed');
    expect(withdrawTaskProjectionCtes({ command: 'AttemptWithdrawn', evidence: { withdraw: true, taskId: 't1', claim: null, outcome: 'requeued' } }, 'd')).toEqual([]);
  });
});

describe('notOwnerTaskSql: an attempt writer\'s own status write skips every delivery owner', () => {
  test('no delivery, or a role other than owner', () => {
    const q = render(sql`SELECT 1 WHERE ${notOwnerTaskSql()}`);
    expect(q.sql).toContain('"delivery_id" IS NULL OR');
    expect(q.sql).toContain(`"delivery_role" IS DISTINCT FROM 'owner'`);
  });
});

describe('projectLoopExitSql: T17\'s open-PR rule', () => {
  test('a task with another PR still open stays parked', () => {
    const q = render(projectLoopExitSql({ deliveryId: 'd1', taskId: 't1' }));
    expect(q.sql).toContain('od.pr_number IS NULL OR NOT EXISTS (');
    expect(q.sql).toContain('lower(ow.pr_url) <> lower(\'https://github.com/\' || od.repo_full_name');
  });
});
