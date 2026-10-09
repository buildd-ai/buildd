/**
 * Who may record a PR supersession, on real rows.
 *
 * An agent run on its runner's key names itself with workerId (as close_pr and
 * update_pr do). It may record a supersession only for a PR its own task owns:
 * its own worker's PR, or one its task's records link. Another task's PR run by the same
 * runner account is refused. A key on another account of the team keeps its
 * team-wide reach.
 *
 * Real route, real API-key auth, real worker lookups and team scoping. Only the
 * write itself (which verifies the successor PR on GitHub) is stubbed.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const recordCalls: Array<Record<string, unknown>> = [];
mock.module('../../src/lib/pr-supersession', () => ({
  recordPrSupersession: async (args: Record<string, unknown>) => {
    recordCalls.push(args);
    return { ok: true, supersededPrNumber: 4101, supersedingPrNumber: 4102, supersedingPrUrl: 'https://example.test/pr/4102', supersedingRepo: null };
  },
}));

const { POST } = await import('../../src/app/api/github/pr/supersede/route');

async function workerKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level) VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hash}, ${teamId}::uuid, 'worker') RETURNING id`);
  return { id: a.id, key };
}

async function seedWorker(workspaceId: string, taskId: string, accountId: string, prNumber: number | null): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, pr_url, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${accountId}::uuid, 'w', 'test', ${`b-${taskId.slice(0, 8)}`},
      ${prNumber == null ? null : `https://example.test/pr/${prNumber}`}, ${prNumber})
    RETURNING id`);
  return w.id;
}

const post = (key: string, body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/github/pr/supersede', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({ supersedingPrNumber: 4102, reason: 'landed under #4102', ...body }),
}));

beforeAll(() => assertDbConfigured());
beforeEach(() => { recordCalls.length = 0; });

describe('recording a PR supersession from a runner key', () => {
  test('another task\'s PR on the same runner account is refused; its own task\'s PR link, its own PR, and a teammate are allowed; text alone is not', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const runner = await workerKey(teamId);

    const ownerTask = await seedTask(workspaceId, { status: 'in_progress', title: 'slice A' });
    const ownerWorker = await seedWorker(workspaceId, ownerTask, runner.id, 4101);
    const callerTask = await seedTask(workspaceId, { status: 'in_progress', title: 'unrelated work' });
    const callerWorker = await seedWorker(workspaceId, callerTask, runner.id, null);

    const refused = await post(runner.key, { workerId: callerWorker, prNumber: 4101 });
    expect(refused.status).toBe(403);
    expect(recordCalls).toEqual([]);

    // Naming the PR in the task's text is not enough...
    await q(sql`UPDATE tasks SET description = 'Slice A landed in #4102; record #4101 as superseded.' WHERE id = ${callerTask}::uuid`);
    const named = await post(runner.key, { workerId: callerWorker, prNumber: 4101 });
    expect(named.status).toBe(403);
    expect(recordCalls).toEqual([]);
    // ...a PR link stamped when the task was filed is.
    await q(sql`UPDATE tasks SET context = ${JSON.stringify({ prReach: { prNumbers: [4101], grantedBy: 'human:owner', grantedAt: 'x' } })}::jsonb WHERE id = ${callerTask}::uuid`);
    const linked = await post(runner.key, { workerId: callerWorker, prNumber: 4101 });
    expect(linked.status).toBe(200);
    expect(recordCalls.at(-1)).toMatchObject({ workerId: ownerWorker });

    const own = await post(runner.key, { workerId: ownerWorker, prNumber: 4101 });
    expect(own.status).toBe(200);

    const teammate = await workerKey(teamId);
    await q(sql`UPDATE tasks SET description = NULL, context = NULL WHERE id = ${callerTask}::uuid`);
    const other = await post(teammate.key, { workerId: callerWorker, prNumber: 4101 });
    expect(other.status).toBe(200);
  });

  test('a runner key of another team is refused', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const runner = await workerKey(teamId);
    const task = await seedTask(workspaceId, { status: 'in_progress', title: 'slice A' });
    const worker = await seedWorker(workspaceId, task, runner.id, 4101);

    const elsewhere = await workerKey((await seedWorkspace()).teamId);
    const res = await post(elsewhere.key, { workerId: worker, prNumber: 4101 });
    expect(res.status).toBe(403);
    expect(recordCalls).toEqual([]);
  });
});
