/**
 * The runner queue read on real Postgres (spec c7410e76 R-26, AC-12): the
 * order `buildd top`'s Queue view shows is the claim's own. What the queue
 * lists as claimable now comes back in exactly the order the claim's WHERE and
 * ORDER BY return; work a gate can never pass for this runner sits under "Not
 * for this runner" with its reason; a workspace outside the list is never read;
 * and when another runner takes position 1, position 2 is first on the next read.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, asc, desc, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';
import { loadRunnerQueue, runnerQueueGates, runnerQueueWhere } from '../../src/lib/claim-order-queue';
import { claimOrderBy } from '../../src/lib/claim-order';

beforeAll(() => { assertDbConfigured(); });

const caller = { accountType: 'service', runner: 'http://runner-under-test', availableSkills: ['builder'], executor: 'host' as const };
const HOUR = 3_600_000;

let teamId: string;
let ws: string;
let otherWs: string;
const id: Record<string, string> = {};

async function setPriority(taskId: string, priority: number, createdAt: Date) {
  await q(sql`UPDATE tasks SET priority = ${priority}, created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${taskId}::uuid`);
}

describe('runner queue', () => {
  beforeAll(async () => {
    ({ teamId, workspaceId: ws } = await seedWorkspace());
    ({ workspaceId: otherWs } = await seedWorkspace());
    const base = Date.now() - 10 * HOUR;
    id.high = await seedTask(ws, { title: 'high priority' });
    id.oldFive = await seedTask(ws, { title: 'five, older' });
    id.newFive = await seedTask(ws, { title: 'five, newer' });
    id.later = await seedTask(ws, { title: 'starts later', startAt: new Date(Date.now() + 5 * HOUR) });
    id.local = await seedTask(ws, { title: 'local session work', missionId: await seedMission(teamId, ws) });
    id.designer = await seedTask(ws, { title: 'needs a designer' });
    id.claimed = await seedTask(ws, { title: 'claimed elsewhere' });
    id.done = await seedTask(ws, { title: 'already done', status: 'completed' });
    id.elsewhere = await seedTask(otherWs, { title: 'another workspace' });
    await setPriority(id.high, 10, new Date(base + 3 * HOUR));
    await setPriority(id.oldFive, 5, new Date(base));
    await setPriority(id.newFive, 5, new Date(base + HOUR));
    await setPriority(id.later, 7, new Date(base));
    await setPriority(id.local, 9, new Date(base));
    await setPriority(id.designer, 8, new Date(base));
    await setPriority(id.claimed, 6, new Date(base));
    await setPriority(id.elsewhere, 99, new Date(base));
    await q(sql`UPDATE missions SET executor = 'local' WHERE id = (SELECT mission_id FROM tasks WHERE id = ${id.local}::uuid)`);
    await q(sql`UPDATE tasks SET role_slug = 'designer' WHERE id = ${id.designer}::uuid`);
    const key = `bld_rq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const [other] = await q<{ id: string }>(sql`
      INSERT INTO accounts (type, name, api_key, team_id, level) VALUES ('service', ${`other-${key.slice(7)}`}, ${key}, ${teamId}::uuid, 'worker') RETURNING id`);
    await q(sql`UPDATE tasks SET claimed_by = ${other.id}::uuid, expires_at = now() + interval '1 hour' WHERE id = ${id.claimed}::uuid`);
  });

  test('the queue is in claim order; holds stay in it, never-for-this-runner work is split out with its reason', async () => {
    const out = await loadRunnerQueue({ workspaceIds: [ws], caller });
    expect(out.teams.length).toBe(1);
    const team = out.teams[0];
    expect(team.teamId).toBe(teamId);
    expect(team.queue.map(t => t.title)).toEqual(['high priority', 'starts later', 'five, older', 'five, newer']);
    expect(team.queue.find(t => t.id === id.later)!.holds).toEqual(['deferred']);
    expect(team.queue.find(t => t.id === id.later)!.holdUntil).not.toBeNull();
    expect(team.notForRunner.map(t => [t.title, t.reason])).toEqual([
      ['local session work', 'local_session'],
      ['needs a designer', 'role_missing'],
      ['claimed elsewhere', 'another_runner'],
    ]);
    const all = [...team.queue, ...team.notForRunner].map(t => t.id);
    expect(all).not.toContain(id.done);
    expect(all).not.toContain(id.elsewhere);
  });

  test("what it lists as claimable now is exactly the claim WHERE + ORDER BY's own result", async () => {
    const now = new Date();
    const gates = runnerQueueGates(caller, now);
    const claimRows = await db.select({ id: tasks.id }).from(tasks)
      .where(and(runnerQueueWhere([ws]), ...Object.values(gates)))
      .orderBy(...claimOrderBy(tasks, { desc, asc }));
    const out = await loadRunnerQueue({ workspaceIds: [ws], caller, now });
    const claimableNow = out.teams[0].queue.filter(t => t.holds.length === 0).map(t => t.id);
    expect(claimableNow).toEqual(claimRows.map(r => r.id));
    expect(claimableNow).toEqual([id.high, id.oldFive, id.newFive]);
  });

  test('AC-12: another runner taking position 1 puts position 2 first on the next read', async () => {
    await q(sql`
      INSERT INTO workers (workspace_id, task_id, name, runner, branch, status)
      VALUES (${ws}::uuid, ${id.high}::uuid, 'elsewhere', 'http://another-runner', 'b', 'running')`);
    const out = await loadRunnerQueue({ workspaceIds: [ws], caller });
    const team = out.teams[0];
    expect(team.queue[0].id).toBe(id.later);
    expect(team.queue.filter(t => t.holds.length === 0)[0].id).toBe(id.oldFive);
    expect(team.notForRunner.find(t => t.id === id.high)?.reason).toBe('another_runner');
  });

  test('a runner advertising the role takes the designer task; a cooldown on this runner is a hold, not an exclusion', async () => {
    await q(sql`
      INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, updated_at)
      VALUES (${ws}::uuid, ${id.newFive}::uuid, 'failed-here', ${caller.runner}, 'b2', 'failed', now())`);
    const out = await loadRunnerQueue({ workspaceIds: [ws], caller: { ...caller, availableSkills: ['builder', 'designer'] } });
    const team = out.teams[0];
    expect(team.queue.map(t => t.id)).toContain(id.designer);
    expect(team.queue.find(t => t.id === id.newFive)!.holds).toEqual(['runner_cooldown']);
  });

  test('only the given workspaces are read', async () => {
    const out = await loadRunnerQueue({ workspaceIds: [otherWs], caller });
    const ids = out.teams.flatMap(t => [...t.queue, ...t.notForRunner].map(x => x.id));
    expect(ids).toEqual([id.elsewhere]);
    const none = await db.select({ id: tasks.id }).from(tasks).where(and(runnerQueueWhere([otherWs]), inArray(tasks.id, [id.high])));
    expect(none).toEqual([]);
  });
});
