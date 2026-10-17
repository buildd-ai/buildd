/**
 * S4b (workflow-kernel-library.md §1, AC-2): the owner-task projection T17 embeds, rendered through
 * the real PgDialect. Behaviour on Postgres is tests/db/kernel-pr-projection.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mergeTaskPayloadSql, mergeTaskProjectionCtes, mergeTaskTransitionOf, ownerAttemptEndOf, OWNER_END_SETTLE_MS, CLAIM_CLOCK_SKEW_MS } from './task-projection';

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
