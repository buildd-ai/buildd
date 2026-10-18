/**
 * The platform operator's kernel view on real Postgres: recent transitions by
 * scope and command, the count written by the web host, the parked commands,
 * the floor's recorded runs, and one PR's timeline. Every read is a SELECT;
 * the assertions scope to a seeded workspace or measure a before/after delta,
 * because the suite shares one database.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace, withDb } from './harness';
import { loadKernelOperatorView, parkedCommands, webHostTransitions, lastFloorRuns } from '../../src/lib/workflow/operator-view';

let teamId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let wsName: string;
let prNumber: number;
let deliveryId: string;
const REPO = 'acme/kernel-view';

async function delivery(ws: string, pr: number, state = 'AWAITING_REVIEW'): Promise<string> {
  const t = await seedTask(ws);
  const [d] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, authority, repo_full_name, pr_number, current_head_sha)
    VALUES (${ws}::uuid, ${t}::uuid, ${state}, 3, 'kernel', ${REPO}, ${pr}, 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0') RETURNING id`);
  return d.id;
}
async function transition(d: string, v: number, command: string, from: string | null, to: string, host: string | null, ago = '5 minutes', evidence: Record<string, unknown> = {}) {
  await q(sql`INSERT INTO workflow_transitions (delivery_id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence, host, created_at)
    VALUES (${d}::uuid, ${v - 1}, ${v}, ${from}, ${to}, ${command}, ${`k-${d}-${v}`}, 'system:test', ${JSON.stringify(evidence)}::jsonb, ${host}, now() - ${ago}::interval)`);
}

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  ({ workspaceId: otherWorkspaceId } = await seedWorkspace());
  [{ name: wsName }] = await q<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${workspaceId}::uuid`);
  prNumber = 100_000 + Math.floor(Math.random() * 800_000);
  deliveryId = await delivery(workspaceId, prNumber);
  await transition(deliveryId, 1, 'open_delivery', null, 'WORKING', 'control-plane', '3 hours', { source: 'pr_opened' });
  await transition(deliveryId, 2, 'record_review_verdict', 'WORKING', 'AWAITING_REVIEW', 'control-plane', '2 hours', { verdict: 'approve', headSha: 'a1b2c3d' });
  const other = await delivery(otherWorkspaceId, prNumber + 1);
  await transition(other, 1, 'open_delivery', null, 'WORKING', 'control-plane', '1 hour');
});

describe('recent transitions', () => {
  test('a workspace scope (by name or id) returns only its own, newest first', async () => {
    const byName = await loadKernelOperatorView({ window: '24h', workspace: wsName });
    expect(byName.transitions.map(t => t.command)).toEqual(['record_review_verdict', 'open_delivery']);
    expect(byName.transitions.every(t => t.workspaceId === workspaceId && t.prNumber === prNumber)).toBe(true);
    const byId = await loadKernelOperatorView({ window: '24h', workspace: workspaceId });
    expect(byId.transitions).toHaveLength(2);
  });

  test('a team scope covers its workspaces; a command narrows it', async () => {
    const team = await loadKernelOperatorView({ window: '24h', team: teamId });
    expect(team.transitions).toHaveLength(2);
    const one = await loadKernelOperatorView({ window: '24h', workspace: wsName, command: 'open_delivery' });
    expect(one.transitions.map(t => t.command)).toEqual(['open_delivery']);
  });

  test('a scope that names nothing is empty and says so, never everything', async () => {
    const v = await loadKernelOperatorView({ window: '24h', workspace: 'no-such-workspace-here' });
    expect(v.transitions).toEqual([]);
    expect(v.scopeMissing).toContain('no-such-workspace-here');
  });

  test('the window excludes older transitions', async () => {
    const d = await delivery(workspaceId, prNumber + 2);
    await transition(d, 1, 'open_delivery', null, 'WORKING', 'control-plane', '3 days');
    const day = await loadKernelOperatorView({ window: '24h', workspace: wsName });
    const week = await loadKernelOperatorView({ window: '7d', workspace: wsName });
    expect(week.transitions.length - day.transitions.length).toBe(1);
  });
});

describe('transitions written by the web host', () => {
  test('counts only host=web in the window, across every workspace, and lists the newest', async () => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const before = await webHostTransitions(since);
    const d = await delivery(otherWorkspaceId, prNumber + 3);
    await transition(d, 1, 'observe_ci_green', null, 'WORKING', 'web', '10 minutes');
    await transition(d, 2, 'observe_ci_green', 'WORKING', 'WORKING', 'web', '3 days');
    await transition(d, 3, 'open_delivery', 'WORKING', 'WORKING', null, '10 minutes');
    const after = await webHostTransitions(since);
    expect(after.count - before.count).toBe(1);
    expect(after.recent.some(t => t.host === 'web' && t.command === 'observe_ci_green')).toBe(true);
    expect(after.recent.every(t => t.host === 'web')).toBe(true);
  });
});

describe('parked commands', () => {
  test('counts pending rows per op with the oldest, whether replay is failing, and what was given up', async () => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const before = await parkedCommands(since);
    const op = `attempt_ended`;
    const row = (key: string, status: string, attempts: number, err: string | null, ago: string) => q(sql`INSERT INTO workflow_command_outbox
      (idempotency_key, op, command_input, principal, status, attempt_count, last_error, created_at, updated_at)
      VALUES (${key}, ${op}, '{}'::jsonb, '{}'::jsonb, ${status}, ${attempts}, ${err}, now() - ${ago}::interval, now() - ${ago}::interval)`);
    const tag = `kov-${Date.now().toString(36)}`;
    await row(`${tag}-1`, 'pending', 0, null, '5 hours');
    await row(`${tag}-2`, 'pending', 3, 'control plane answered 503', '1 hour');
    await row(`${tag}-3`, 'dead', 5, 'gave up', '2 hours');
    await row(`${tag}-4`, 'done', 1, null, '2 hours');
    const after = await parkedCommands(since);
    expect(after.total - before.total).toBe(2);
    expect(after.gaveUp - before.gaveUp).toBe(1);
    const mine = after.byOp.find(o => o.op === op)!;
    const was = before.byOp.find(o => o.op === op);
    expect(mine.count - (was?.count ?? 0)).toBe(2);
    expect(mine.failing - (was?.failing ?? 0)).toBe(1);
    expect(Date.parse(after.oldestAt!)).toBeLessThanOrEqual(Date.now() - 5 * 3_600_000 + 60_000);
    expect(mine.lastError).toContain('503');
  });
});

describe('floor runs', () => {
  test('lists the control plane and web runs, newest first, with what each repaired', async () => {
    const run = (job: string, ago: string, result: Record<string, unknown>) => q(sql`INSERT INTO cron_runs (job, started_at, finished_at, duration_ms, ok, result)
      VALUES (${job}, now() - ${ago}::interval, now() - ${ago}::interval, 900, true, ${JSON.stringify(result)}::jsonb)`);
    await run('kernel-floor', '1 second', { host: 'control-plane', kernelOutbox: { claimed: 2, done: 2, failed: 0 }, kernelFloor: { checked: 4, imported: 1, enqueued: 3, errors: 0 }, parkedCommands: { claimed: 1, done: 1, retried: 0, dead: 0, pruned: 0 } });
    await run('pr-reconcile', '2 seconds', { kernelSkipped: 'control_plane_hosts' });
    await run('pr-reconcile', '3 seconds', { kernelHost: 'web', kernelOutbox: { error: 'db timed out' }, kernelFloor: { checked: 0, imported: 0, enqueued: 0, errors: 0 } });
    const runs = await lastFloorRuns();
    expect(runs[0]).toMatchObject({ host: 'control plane', ok: true });
    expect(runs[0].repaired.join(' ')).toContain('sent 2 owed effects');
    expect(runs[0].repaired.join(' ')).toContain('re-sent 1 parked command');
    // The run that skipped the floor is not a floor run.
    expect(runs.filter(r => r.host === 'web')[0].problems.join(' ')).toContain('db timed out');
    expect(runs.length).toBeLessThanOrEqual(8);
  });
});

describe('one PR timeline', () => {
  test('transitions in order with evidence, open findings and the approval check', async () => {
    await q(sql`INSERT INTO workflow_findings (id, delivery_id, origin_round_id, origin_round, origin_head_sha, ordinal, path, line, title, required, status, last_round)
      VALUES (${`f-${deliveryId}`}, ${deliveryId}::uuid, gen_random_uuid(), 1, 'a1b2c3d', 0, 'src/a.ts', 12, 'unchecked null', true, 'open', 1)`);
    const v = await loadKernelOperatorView({ window: '24h', workspace: wsName, pr: prNumber });
    expect(v.timeline.kind).toBe('found');
    if (v.timeline.kind !== 'found') return;
    const [tl] = v.timeline.timelines;
    expect(tl.steps.map(s => s.command)).toEqual(['open_delivery', 'record_review_verdict']);
    expect(tl.steps[1].evidence).toContain('verdict: approve');
    expect(tl.openFindings).toEqual(['src/a.ts:12: unchecked null']);
    expect(tl.approval?.description).toMatch(/Unresolved review finding/);
    expect(tl.approvalContext).toBe('Buildd / Review approval');
  });

  test('a PR number alone asks for the workspace; an unknown PR says not found', async () => {
    expect((await loadKernelOperatorView({ window: '24h', pr: prNumber })).timeline.kind).toBe('needs_workspace');
    expect((await loadKernelOperatorView({ window: '24h', workspace: wsName, pr: 1 })).timeline).toEqual({ kind: 'not_found', prNumber: 1 });
    // The same PR number in another workspace is not this workspace's PR.
    const other = await loadKernelOperatorView({ window: '24h', workspace: otherWorkspaceId, pr: prNumber });
    expect(other.timeline.kind).toBe('not_found');
  });
});

describe('every statement reads through an index', () => {
  test('the window reads use the created_at index, not a scan of the log', async () => {
    // A direct connection: the neon-http shim gives every request a fresh session, so SET would not hold.
    const plan = await withDb(process.env.DATABASE_URL!, async (c) => {
      await c.query('SET enable_seqscan = off');
      const r = await c.query(`EXPLAIN SELECT count(*) FROM workflow_transitions WHERE created_at >= now() - interval '1 day' AND host = 'web'`);
      return r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('workflow_transitions_created_idx');
  });
});
