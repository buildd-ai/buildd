/**
 * The DeliveryView loader: one statement, kernel authority only, and the row
 * mapping (including the S37 stall rule shared with conflict recovery).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deliveryViewsSql, getDeliveryViewsForTasks, remediationFrom, rowToDeliveryView } from './delivery-view';

const dialect = new PgDialect();
const NOW = Date.parse('2026-10-06T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('deliveryViewsSql', () => {
  test('reads kernel-owned deliveries only, by owner task or attempt task, with the open conflict fix', () => {
    const q = dialect.sqlToQuery(deliveryViewsSql(['t1', 't2']));
    expect(q.sql).toContain("d.authority = 'kernel'");
    expect(q.sql).toContain('d.owner_task_id IN (SELECT id FROM ids)');
    expect(q.sql).toContain('t.delivery_id IS NOT NULL');
    expect(q.sql).toContain('t.conflict_retry_pr_number = d.pr_number');
    expect(q.sql).toContain("t.status IN ('pending', 'assigned', 'in_progress')");
    expect(q.params).toEqual([JSON.stringify(['t1', 't2'])]);
  });
});

describe('remediationFrom (S37)', () => {
  test('pending past the window is stalled; a recent re-dispatch restarts the wait', () => {
    expect(remediationFrom({ id: 'c', status: 'pending', created_at: minutesAgo(45) }, NOW)).toMatchObject({ stalled: true, taskStatus: 'pending' });
    expect(remediationFrom({ id: 'c', status: 'pending', created_at: minutesAgo(45), recovered_at: minutesAgo(2) }, NOW)).toMatchObject({ stalled: false });
  });
  test('a claimed fix whose worker ended is stalled', () => {
    expect(remediationFrom({ id: 'c', status: 'assigned', created_at: minutesAgo(5), worker_status: 'failed', worker_updated_at: minutesAgo(1) }, NOW)?.stalled).toBe(true);
  });
  test('no row, no remediation', () => {
    expect(remediationFrom(null, NOW)).toBeNull();
  });
});

describe('rowToDeliveryView', () => {
  const row = {
    delivery: { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/r', pr_number: 7, state: 'AWAITING_PUSH', version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, approved_heads: [], composition_heads: [] },
    rounds: [], attempts: [],
    last_transition: { command: 'AttemptEnded', from_state: 'FIXING', to_state: 'AWAITING_PUSH', evidence: {}, created_at: minutesAgo(1) },
    attempt_tasks: [{ id: 't1', role: 'owner', status: 'completed', created_at: minutesAgo(30) }, { id: 'f1', role: 'fix', status: 'completed', created_at: minutesAgo(10) }],
    remediation: null,
  };
  test('maps a row to a platform-owned view with its attempts', () => {
    const v = rowToDeliveryView(row, NOW)!;
    expect(v).toMatchObject({ state: 'AWAITING_PUSH', owner: 'platform', needsYou: false });
    expect(v.currentAttempt?.taskId).toBe('f1');
  });
  test('getDeliveryViewsForTasks keys the view by every requested task of the delivery, and degrades to empty on error', async () => {
    const map = await getDeliveryViewsForTasks(['t1', 'f1', 'x'], async () => ({ rows: [row] }));
    expect([...map.keys()].sort()).toEqual(['f1', 't1']);
    const failing = await getDeliveryViewsForTasks(['t1'], async () => { throw new Error('db down'); });
    expect(failing.size).toBe(0);
    expect((await getDeliveryViewsForTasks([], async () => { throw new Error('never called'); })).size).toBe(0);
  });
});
