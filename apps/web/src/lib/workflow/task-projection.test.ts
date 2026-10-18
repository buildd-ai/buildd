/**
 * S4b (workflow-kernel-library.md §1, AC-2): the owner-task projection T17 embeds, rendered through
 * the real PgDialect. Behaviour on Postgres is tests/db/kernel-pr-projection.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { attemptEndTaskProjectionCtes, endingWorkerIsCurrentSql, reapedOwnerAttemptIsCurrentSql, isAttemptRow, isAttemptRowSql, mergeTaskPayloadSql, mergeTaskProjectionCtes, mergeTaskTransitionOf, ownerAttemptEndOf, ownerEndTaskStatus, projectOwnerEndSql, OWNER_END_SETTLE_MS, CLAIM_CLOCK_SKEW_MS } from './task-projection';

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
