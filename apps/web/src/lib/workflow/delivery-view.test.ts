/**
 * The DeliveryView loader: one statement, kernel authority only, and the row
 * mapping (including the S37 stall rule shared with conflict recovery).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { deliveryViewsSql, getDeliveryViewsForTasks, kernelDeliveryForWorkerSql, laneWaitFrom, remediationFrom, rowToDeliveryView, withMergeContradiction } from './delivery-view';

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
    expect(q.params).toEqual([JSON.stringify(['t1', 't2']), 'parked:lane_busy%']);
  });
  test('reads the delivery\'s parked behind refresh, if any (the landing lane)', () => {
    const q = dialect.sqlToQuery(deliveryViewsSql(['t1']));
    expect(q.sql).toContain("e.kind = 'refresh_branch' AND e.status = 'pending' AND e.outcome LIKE $2::text");
    expect(q.sql).toContain('AS lane_wait');
  });
  test('reads the workspace git config and owner task only for an APPROVED delivery: the merge rule\'s inputs (spec 3ef37387 R-11)', () => {
    const q = dialect.sqlToQuery(deliveryViewsSql(['t1']));
    expect(q.sql).toMatch(/CASE WHEN d\.state = 'APPROVED' THEN \(SELECT jsonb_build_object\('git_config', w\.git_config\)[\s\S]*?END AS workspace/);
    expect(q.sql).toMatch(/CASE WHEN d\.state = 'APPROVED' THEN \(SELECT jsonb_build_object\('requires_review'[\s\S]*?END AS owner_task/);
  });
});

describe('kernelDeliveryForWorkerSql (list_prs, §7)', () => {
  test('a kernel-owned delivery of the row\'s owner task and PR, in a workspace with the kernel on, matching the caller\'s condition', () => {
    const q = dialect.sqlToQuery(kernelDeliveryForWorkerSql(sql`w.task_id`, sql`w.pr_number`, sql`w.pr_url`, sql`kd.state = ${'MERGED'}`));
    expect(q.sql).toContain("lower(w.pr_url) LIKE '%github.com/' || lower(kd.repo_full_name) || '/pull/%'");
    expect(q.sql).toContain('EXISTS (SELECT 1 FROM workflow_deliveries kd WHERE kd.owner_task_id = w.task_id AND kd.pr_number = w.pr_number');
    expect(q.sql).toContain("kd.authority = 'kernel'");
    expect(q.sql).toContain('kw.id = kd.workspace_id');
    expect(q.sql).toContain('kd.state = $1');
    expect(q.params).toEqual(['MERGED']);
  });
});

describe('laneWaitFrom', () => {
  test('a parked outcome names the PR holding the lane; anything else is not parked', () => {
    expect(laneWaitFrom('parked:lane_busy:#41')).toEqual({ behindPr: 41 });
    expect(laneWaitFrom('parked:lane_busy:unknown')).toEqual({ behindPr: null });
    for (const v of [null, undefined, 'ok:updated', 'ok:updated(lane:would_wait:#3)', 7]) expect(laneWaitFrom(v)).toBeNull();
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
  test('a parked behind refresh reads as waiting behind the lane holder', () => {
    const parked = {
      ...row,
      delivery: { ...row.delivery, state: 'REPAIRING', state_reason: 'behind', base_ref: 'dev' },
      lane_wait: 'parked:lane_busy:#41',
    };
    expect(rowToDeliveryView(parked, NOW)).toMatchObject({ headline: 'Waiting to update branch', detail: 'PR #41 is merging into dev first' });
    expect(rowToDeliveryView({ ...parked, lane_wait: null }, NOW)?.headline).toBe('Updating branch');
  });
  // §7 / AC-24: the reader carries the findings and each attempt's proven push head.
  test('carries the delivery\'s findings and each attempt\'s pushed head', () => {
    const v = rowToDeliveryView({
      ...row,
      delivery: { ...row.delivery, state: 'AWAITING_REVIEW' },
      rounds: [{ id: 'r1', round: 1, head_sha: 'H0', kind: 'full', status: 'decided', verdict: 'request_changes', effective_verdict: 'request_changes', failure_count: 0 }],
      attempts: [{ id: 'a1', family: 'review_fix', attempt_no: 1, mode: 'agent', status: 'ended', outcome: 'delivered', max_attempts: 3, reported_shas: ['H1'], pushed_head_sha: 'H1' }],
      findings: [{ id: 'r1:0', origin_round_id: 'r1', origin_round: 1, origin_head_sha: 'H0', ordinal: 0, path: 'a.ts', line: 3, title: 'rename it', required: true, status: 'open', last_round: 1 }],
    }, NOW)!;
    expect(v.findings?.map(f => f.id)).toEqual(['r1:0']);
    expect(v.openFindings).toBe(1);
    expect(v.ledger[0]!.pushedHeadSha).toBe('H1');
    // Findings are opt-in: only get_pr, the task page and the activity comment read them.
    expect(dialect.sqlToQuery(deliveryViewsSql(['t1'], { withFindings: true })).sql).toContain('FROM workflow_findings f WHERE f.delivery_id = d.id');
    const lean = dialect.sqlToQuery(deliveryViewsSql(['t1'])).sql;
    expect(lean).not.toContain('workflow_findings');
    expect(lean).toContain("'[]'::jsonb AS findings");
  });
  test('maps a row to a platform-owned view with its attempts', () => {
    const v = rowToDeliveryView(row, NOW)!;
    expect(v).toMatchObject({ state: 'AWAITING_PUSH', owner: 'platform', needsYou: false });
    expect(v.currentAttempt?.taskId).toBe('f1');
  });
  test('getDeliveryViewsForTasks reads findings only when asked', async () => {
    const seen: string[] = [];
    const exec = async (q: Parameters<typeof dialect.sqlToQuery>[0]) => { seen.push(dialect.sqlToQuery(q).sql); return { rows: [] }; };
    await getDeliveryViewsForTasks(['t1'], exec as never);
    await getDeliveryViewsForTasks(['t1'], exec as never, undefined, { withFindings: true });
    expect(seen[0]).not.toContain('workflow_findings');
    expect(seen[1]).toContain('workflow_findings');
  });
  test('getDeliveryViewsForTasks keys the view by every requested task of the delivery, and degrades to empty on error', async () => {
    const map = await getDeliveryViewsForTasks(['t1', 'f1', 'x'], async () => ({ rows: [row] }));
    expect([...map.keys()].sort()).toEqual(['f1', 't1']);
    const failing = await getDeliveryViewsForTasks(['t1'], async () => { throw new Error('db down'); });
    expect(failing.size).toBe(0);
    expect((await getDeliveryViewsForTasks([], async () => { throw new Error('never called'); })).size).toBe(0);
  });
});

describe('the approved-merge slot: who merges an APPROVED delivery', () => {
  const approved = { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', pr_number: 7, state: 'APPROVED', version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, approved_heads: ['H1'], composition_heads: [] };
  const row = { delivery: approved, rounds: [], attempts: [], attempt_tasks: [], remediation: null };
  test('the rule maps the row to owner human (needs you) or landing (merging)', () => {
    expect(rowToDeliveryView(row, NOW, () => true)).toMatchObject({ owner: 'human', needsYou: true });
    expect(rowToDeliveryView(row, NOW, () => false)).toMatchObject({ owner: 'landing', needsYou: false });
  });
  test('with no rule a person merges: an unknown policy never hides a merge that waits on you', () => {
    expect(rowToDeliveryView(row, NOW)).toMatchObject({ owner: 'human', needsYou: true });
  });
  test('the rule is asked only about APPROVED deliveries', () => {
    const asked: unknown[] = [];
    const rule = (r: Record<string, unknown>) => { asked.push(r); return true; };
    expect(rowToDeliveryView({ ...row, delivery: { ...approved, state: 'LANDING' } }, NOW, rule)).toMatchObject({ owner: 'landing' });
    expect(asked).toEqual([]);
    rowToDeliveryView(row, NOW, rule);
    expect(asked).toEqual([row]);
  });
  test('the loader applies the rule it is given', async () => {
    const map = await getDeliveryViewsForTasks(['t1'], async () => ({ rows: [row] }), () => false);
    expect(map.get('t1')).toMatchObject({ owner: 'landing', needsYou: false });
  });
});

/** AC-4 (S4a review): a merge GitHub reports after the delivery was abandoned or superseded is shown, not swallowed. */
describe('a merge contradiction on the delivery view', () => {
  const base = {
    delivery: { id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/r', pr_number: 7, state: 'ABANDONED', version: 6, current_head_sha: 'H1', current_round: 1, max_rounds: 3, approved_heads: [], composition_heads: [] },
    rounds: [], attempts: [], attempt_tasks: [], remediation: null,
    last_transition: { command: 'Abandon', from_state: 'CLOSED_UNMERGED', to_state: 'ABANDONED', evidence: {}, created_at: minutesAgo(5) },
  };
  test('the loader reads the newest contradicted fact of the PR', () => {
    const { sql } = new PgDialect().sqlToQuery(deliveryViewsSql(['t1']));
    expect(sql).toContain("f.kind = 'pr_closed' AND f.payload ? 'contradiction'");
    expect(sql).toContain('AS merge_contradiction');
  });
  test('an ABANDONED delivery GitHub merged says so in its detail (what explain shows)', () => {
    const v = rowToDeliveryView({ ...base, merge_contradiction: { reason: 'merged_after_abandoned', mergedAt: '2026-10-01T00:00:00Z' } }, NOW)!;
    expect(v.detail).toContain('GitHub reports this PR merged at 2026-10-01T00:00:00Z after buildd recorded it as abandoned');
    expect(v.detail).toContain('recorded but not applied');
  });
  test('no contradiction, or a delivery in another state: the view is unchanged', () => {
    const plain = rowToDeliveryView(base, NOW)!;
    expect(withMergeContradiction(plain, null)).toBe(plain);
    const merged = rowToDeliveryView({ ...base, delivery: { ...base.delivery, state: 'MERGED' } }, NOW)!;
    expect(withMergeContradiction(merged, { reason: 'x' })).toBe(merged);
  });
});
