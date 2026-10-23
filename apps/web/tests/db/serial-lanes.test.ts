/**
 * Serial lanes on real Postgres (Living Spec "Overlap scheduling: serial lanes
 * and file locks", Rule 1: I-1 to I-7; AC-2, AC-3, AC-4, AC-5, AC-9).
 *
 * The claim route, check_path_claim and the lane rows are real: the one-holder
 * rule is a partial unique index and the order is a stored column, neither of
 * which a mocked `db` can show.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, confinedRunnerEnvironment, q, seedTask, seedWorkspace } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const claimRoute = await import('../../src/app/api/workers/claim/route');
const { loadLanes, syncLanes, releaseLaneHolder, stuckLanesOf, sweepLanes, takeLanes } = await import('../../src/lib/serial-lanes-store');
const { lanePosition, MIGRATION_LANE } = await import('../../src/lib/serial-lanes');
const { checkPathClaim } = await import('../../src/lib/path-claim-check');

setDefaultTimeout(30_000);
beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const SCHEMA = ['packages/core/db/schema.ts'];

async function world() {
  const ws = await seedWorkspace();
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${ws.workspaceId}::uuid`);
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  await q(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${rand()}`}, ${hashed}, ${ws.teamId}::uuid, 'worker', 10)`);
  return { ...ws, key };
}
type W = Awaited<ReturnType<typeof world>>;

/** Pending lane task, created `ageMin` minutes ago. */
async function laneTask(w: W, ageMin: number, opts: { priority?: number; manifest?: string[] } = {}): Promise<string> {
  const id = await seedTask(w.workspaceId, { pathManifest: opts.manifest ?? SCHEMA });
  await q(sql`UPDATE tasks SET created_at = now() - make_interval(mins => ${ageMin}), priority = ${opts.priority ?? 0} WHERE id = ${id}::uuid`);
  return id;
}

async function claim(w: W, body: Record<string, unknown> = {}) {
  const res = await claimRoute.POST(new NextRequest('http://localhost/api/workers/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${w.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runner: `r-${rand()}`, workspaceId: w.workspaceId, maxTasks: 1, environment: confinedRunnerEnvironment(), ...body }),
  }) as never);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    workers?: Array<{ taskId: string; id: string }>;
    diagnostics?: { deferrals?: Record<string, number>; taskExclusion?: { code?: string; detail?: string } };
  };
}
const claimedIds = (b: { workers?: Array<{ taskId: string }> }) => (b.workers ?? []).map(x => x.taskId).sort();

/** The task's PR opens (on its claimed worker, or a new one). */
async function openPr(w: W, taskId: string, prNumber: number) {
  const [existing] = await q<{ id: string }>(sql`SELECT id FROM workers WHERE task_id = ${taskId}::uuid ORDER BY created_at DESC LIMIT 1`);
  if (existing) {
    await q(sql`UPDATE workers SET pr_url = ${`https://github.com/acme/widgets/pull/${prNumber}`}, pr_number = ${prNumber}, status = 'completed' WHERE id = ${existing.id}::uuid`);
  } else {
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_url, pr_number)
      VALUES (${w.workspaceId}::uuid, ${taskId}::uuid, ${`wk-${rand()}`}, 'other', ${`buildd/${rand()}`}, 'completed',
        ${`https://github.com/acme/widgets/pull/${prNumber}`}, ${prNumber})`);
  }
  await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${taskId}::uuid`);
}

async function mergePr(taskId: string) {
  await q(sql`UPDATE workers SET merged_at = now(), pr_lifecycle_status = 'merged' WHERE task_id = ${taskId}::uuid AND pr_url IS NOT NULL`);
}

async function position(w: W, taskId: string, lane = MIGRATION_LANE) {
  const read = await loadLanes([w.workspaceId], new Date());
  const view = read.lanes.get(w.workspaceId)?.get(lane);
  return view ? lanePosition(view, taskId) : null;
}

describe('serial lane: one holder, first come (I-1, I-2, I-3)', () => {
  test('AC-2: A holds; B and C are refused naming A at positions 1 and 2; A merges, B claims, C is position 1', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    const c = await laneTask(w, 10, { priority: 50 });

    // They became claimable one after another: A, then B, then C.
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: a, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 3000) });
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: b, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 2000) });
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: c, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 1000) });

    // C has the highest priority, but A came first.
    expect(claimedIds(await claim(w, { maxTasks: 3 }))).toEqual([a]);

    const rb = await claim(w, { taskId: b });
    expect(claimedIds(rb)).toEqual([]);
    expect(rb.diagnostics?.taskExclusion?.detail).toContain(a.slice(0, 8));
    expect(rb.diagnostics?.taskExclusion?.detail).toContain('position 1');
    const rc = await claim(w, { taskId: c });
    expect(rc.diagnostics?.taskExclusion?.detail).toContain(a.slice(0, 8));
    expect(rc.diagnostics?.taskExclusion?.detail).toContain('position 2');

    // A's PR opens and is still open: the lane stays held.
    await openPr(w, a, 101);
    expect(claimedIds(await claim(w, { maxTasks: 3 }))).toEqual([]);

    await mergePr(a);
    expect(claimedIds(await claim(w, { maxTasks: 3 }))).toEqual([b]);
    expect(await position(w, c)).toBe(1);
  });

  test('a closed PR or a task that ends with no PR frees the lane (I-2)', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    expect(claimedIds(await claim(w))).toEqual([a]);
    await q(sql`UPDATE tasks SET status = 'failed' WHERE id = ${a}::uuid`);
    await q(sql`UPDATE workers SET status = 'failed' WHERE task_id = ${a}::uuid`);
    expect(claimedIds(await claim(w))).toEqual([b]);
    const [row] = await q<{ left_reason: string }>(sql`SELECT left_reason FROM serial_lane_entries WHERE task_id = ${a}::uuid`);
    expect(row.left_reason).toBe('ended');
  });

  test('the one-holder index refuses a second holder', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    const now = new Date();
    expect((await takeLanes({ workspaceId: w.workspaceId, taskId: a, lanes: [MIGRATION_LANE], now })).ok).toBe(true);
    expect(await takeLanes({ workspaceId: w.workspaceId, taskId: b, lanes: [MIGRATION_LANE], now })).toEqual({ ok: false, lane: MIGRATION_LANE });
  });

  test('a stamped place never moves: a later priority bump does not jump the line', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: a, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 2000) });
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: b, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 1000) });
    await q(sql`UPDATE tasks SET priority = 99 WHERE id = ${b}::uuid`);
    // Re-syncing both does not re-stamp.
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [a, b].map(id => ({ id, workspaceId: w.workspaceId, pathManifest: SCHEMA })), now: new Date() });
    expect(await position(w, a)).toBe(0);
    expect(await position(w, b)).toBe(1);
    expect(claimedIds(await claim(w, { maxTasks: 2 }))).toEqual([a]);
  });
});

describe('parked work keeps its place and blocks nobody (I-4)', () => {
  test('AC-3: P (future start) ahead of Q: Q is claimed and P keeps its position', async () => {
    const w = await world();
    const p = await laneTask(w, 30);
    const qId = await laneTask(w, 20);
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: p, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 2000) });
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: qId, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 1000) });
    await q(sql`UPDATE tasks SET start_at = now() + interval '2 hours' WHERE id = ${p}::uuid`);
    expect(claimedIds(await claim(w))).toEqual([qId]);
    expect(await position(w, p)).toBe(1);
    const [row] = await q<{ held_at: string | null; left_at: string | null }>(sql`SELECT held_at, left_at FROM serial_lane_entries WHERE task_id = ${p}::uuid`);
    expect(row).toEqual({ held_at: null, left_at: null });
  });

  test('a held task ahead does not block the one behind it', async () => {
    const w = await world();
    const p = await laneTask(w, 30);
    const qId = await laneTask(w, 20);
    await syncLanes({ workspaceIds: [w.workspaceId], claimable: [{ id: p, workspaceId: w.workspaceId, pathManifest: SCHEMA }], now: new Date(Date.now() - 2000) });
    await q(sql`UPDATE tasks SET context = jsonb_build_object('heldBy', 'someone') WHERE id = ${p}::uuid`);
    expect(claimedIds(await claim(w))).toEqual([qId]);
  });
});

describe('edit-time join (I-5)', () => {
  test('AC-4: a task that declared no lane path edits schema.ts while another holds the lane: 409 naming holder and position', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    expect(claimedIds(await claim(w))).toEqual([a]);
    const x = await seedTask(w.workspaceId, { pathManifest: ['apps/web/src/lib/a.ts'], status: 'in_progress' });
    const r = await checkPathClaim({ taskId: x, paths: SCHEMA, surface: 'test', callerOrigin: 'worker' });
    expect(r.kind).toBe('conflict');
    const body = JSON.stringify((r as { body: unknown }).body);
    expect(body).toContain(a);
    expect(body).toMatch(/"position":1/);
    // It joined the lane: it now has a place behind the holder.
    expect(await position(w, x)).toBe(1);
  });

  test('with the lane free, the edit takes the lane and the next lane task waits on it', async () => {
    const w = await world();
    const x = await seedTask(w.workspaceId, { pathManifest: ['apps/web/src/lib/a.ts'], status: 'in_progress' });
    const r = await checkPathClaim({ taskId: x, paths: SCHEMA, surface: 'test', callerOrigin: 'worker' });
    expect(r.kind).toBe('claimed');
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${x}::uuid, ${`wk-${rand()}`}, 'other', ${`buildd/${rand()}`}, 'running')`);
    const b = await laneTask(w, 10);
    expect(claimedIds(await claim(w))).toEqual([]);
    const rb = await claim(w, { taskId: b });
    expect(rb.diagnostics?.taskExclusion?.detail).toContain(x.slice(0, 8));
  });
});

describe('own-PR repairs never wait (I-6)', () => {
  test('AC-5: the holder PR has a conflict; its repair is claimable at once', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    expect(claimedIds(await claim(w))).toEqual([a]);
    await openPr(w, a, 202);
    const repair = await seedTask(w.workspaceId, { pathManifest: SCHEMA });
    await q(sql`UPDATE tasks SET task_class = 'attempt', conflict_retry_pr_number = 202, created_at = now() - interval '1 minute' WHERE id = ${repair}::uuid`);
    expect(claimedIds(await claim(w, { maxTasks: 3 }))).toEqual([repair]);
    expect(await position(w, b)).toBe(1);
  });
});

describe('stuck lane (I-7)', () => {
  test('AC-9: a holder with no PR activity for 24h is reported, and a person releasing it lets position 1 claim', async () => {
    const w = await world();
    const a = await laneTask(w, 30);
    const b = await laneTask(w, 20);
    expect(claimedIds(await claim(w))).toEqual([a]);
    await openPr(w, a, 303);
    await syncLanes({ workspaceIds: [w.workspaceId], now: new Date() });
    await q(sql`UPDATE serial_lane_entries SET held_at = now() - interval '30 hours', activity_at = now() - interval '25 hours' WHERE task_id = ${a}::uuid`);

    const stuck = stuckLanesOf(await loadLanes([w.workspaceId], new Date()), new Date());
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ lane: MIGRATION_LANE, holderTaskId: a, prNumber: 303, nextTaskId: b });

    // New activity (a commit) clears it.
    await q(sql`UPDATE workers SET last_commit_sha = 'abc123' WHERE task_id = ${a}::uuid`);
    await syncLanes({ workspaceIds: [w.workspaceId], now: new Date() });
    expect(stuckLanesOf(await loadLanes([w.workspaceId], new Date()), new Date())).toHaveLength(0);

    await q(sql`UPDATE serial_lane_entries SET activity_at = now() - interval '25 hours' WHERE task_id = ${a}::uuid`);
    const [user] = await q<{ id: string }>(sql`INSERT INTO users (email, name) VALUES (${`p-${rand()}@example.test`}, 'Person') RETURNING id`);
    expect(await releaseLaneHolder({ workspaceId: w.workspaceId, lane: MIGRATION_LANE, taskId: a, userId: user.id, now: new Date() })).toBe(true);
    const [row] = await q<{ left_reason: string; released_by_user_id: string }>(sql`SELECT left_reason, released_by_user_id FROM serial_lane_entries WHERE task_id = ${a}::uuid`);
    expect(row).toEqual({ left_reason: 'released', released_by_user_id: user.id });
    // A's PR is still open, but it no longer holds anyone.
    expect(claimedIds(await claim(w))).toEqual([b]);
  });
});

describe('the sweep (maintenance cron)', () => {
  test('in-flight lane work from before lanes is recorded as the holder; waiting work is placed; merged work leaves', async () => {
    const w = await world();
    const running = await seedTask(w.workspaceId, { pathManifest: SCHEMA, status: 'in_progress' });
    await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${w.workspaceId}::uuid, ${running}::uuid, ${`wk-${rand()}`}, 'other', ${`buildd/${rand()}`}, 'running')`);
    const waiting = await laneTask(w, 10);
    const parked = await laneTask(w, 5);
    await q(sql`UPDATE tasks SET start_at = now() + interval '1 day' WHERE id = ${parked}::uuid`);

    await sweepLanes(new Date());
    const rowsNow = await q<{ task_id: string; held_at: string | null; claimable_since: string | null }>(sql`
      SELECT task_id, held_at, claimable_since FROM serial_lane_entries WHERE workspace_id = ${w.workspaceId}::uuid`);
    const by = new Map(rowsNow.map(r => [r.task_id, r]));
    expect(by.get(running)?.held_at).not.toBeNull();
    expect(by.get(waiting)?.claimable_since).not.toBeNull();
    expect(by.get(parked)?.claimable_since).toBeNull();
    expect(await position(w, waiting)).toBe(1);
    expect(await position(w, parked)).toBe(2);

    // The holder's PR merges: the next sweep lets it go.
    await openPr(w, running, 404);
    await mergePr(running);
    await sweepLanes(new Date());
    const [gone] = await q<{ left_reason: string | null }>(sql`SELECT left_reason FROM serial_lane_entries WHERE task_id = ${running}::uuid`);
    expect(gone.left_reason).toBe('merged');
    expect(claimedIds(await claim(w))).toEqual([waiting]);
  });
});
