/**
 * AC-1 slice 4 step 1 (docs/specs/workflow-kernel-library.md §9): a task's PR is derived on read
 * (apps/web/src/lib/workflow/task-pr.ts), so no attempt writer snapshots `result.prUrl` /
 * `prNumber` any more.
 *
 *  - First match wins: the task's own delivery, then its attempt worker rows newest first, then a
 *    placeholder row, then a stored result (rows written before this slice, a person's attach).
 *  - A second PR from one worker gets a sibling placeholder row (worker-pr-slot.ts); it is that
 *    PR's owner row, not the task's PR, and never displaces the attempt's own.
 *  - The worker PATCH's completion, the cleanup promotion and the reaper write no PR into result,
 *    and an end that lands late on a re-claimed task cannot put the old attempt's PR back.
 *
 * Real kernel, real Postgres, stateful fake GitHub, the real worker route with API-key auth.
 */
import { world, type OpenedPr, type World } from './workflow-scenarios-world';
import { afterEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { q, seedTask } from './harness';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

const workersRoute = await import('../../src/app/api/workers/[id]/route');
const { taskPrsFor, taskPrOf, taskHasPrSql, taskPrNumberSql, withTaskPrs } = await import('../../src/lib/workflow/task-pr');
const { db } = await import('@buildd/core/db');
const { tasks } = await import('@buildd/core/db/schema');
const { sqlWhere, sqlExtras } = await import('@buildd/core/db/relational-sql');
const { terminalAuditFields } = await import('../../src/app/api/tasks/audit-fields');

setDefaultTimeout(30_000);

let w: World | undefined;
afterEach(() => w?.dispose());

const url = (n: number) => `https://github.com/${w!.repo}/pull/${n}`;
const storedResult = async (taskId: string) =>
  (await q<{ result: Record<string, unknown> | null }>(sql`SELECT result FROM tasks WHERE id = ${taskId}::uuid`))[0].result;

async function workerRow(taskId: string, o: { runner?: string; prNumber?: number | null; status?: string; minutesAgo?: number }): Promise<string> {
  const ago = o.minutesAgo ?? 0;
  const n = o.prNumber ?? null;
  const [r] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url, created_at, updated_at)
    VALUES (${w!.workspaceId}::uuid, ${taskId}::uuid, 'w', ${o.runner ?? 'test'}, ${`b-${crypto.randomUUID().slice(0, 8)}`}, ${o.status ?? 'completed'},
      ${n}::int, ${n ? url(n) : null}, now() - make_interval(mins => ${ago}::int), now() - make_interval(mins => ${ago}::int))
    RETURNING id`);
  return r.id;
}

async function serviceKey(teamId: string): Promise<{ id: string; key: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  return { id: a.id, key };
}

async function patchWorker(taskId: string, workerId: string, body: Record<string, unknown>) {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w!.workspaceId}::uuid`);
  const account = await serviceKey(ws.team_id);
  await q(sql`UPDATE workers SET account_id = ${account.id}::uuid WHERE id = ${workerId}::uuid`);
  await q(sql`UPDATE tasks SET output_requirement = 'none' WHERE id = ${taskId}::uuid`);
  return workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${account.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: workerId }) } as never,
  );
}

describe('a task\'s PR is derived on read', () => {
  test('a delivery owner reads its delivery\'s PR, even with no PR on any worker row', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/tpr-delivery', files: { 'src/a.ts': 'export const a = 1;\n' } });
    await q(sql`UPDATE workers SET pr_number = NULL, pr_url = NULL WHERE task_id = ${pr.ownerTaskId}::uuid`);
    expect(await taskPrOf(pr.ownerTaskId)).toEqual({ prUrl: url(pr.prNumber), prNumber: pr.prNumber });
  });

  test('a fix task of the delivery is not its owner: it never reads the delivery\'s PR', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/tpr-fix', files: { 'src/a.ts': 'export const a = 2;\n' } });
    const fix = await seedTask(w.workspaceId, { status: 'completed' });
    await q(sql`UPDATE tasks SET delivery_id = ${pr.deliveryId}::uuid, delivery_role = 'ci_fix' WHERE id = ${fix}::uuid`);
    expect(await taskPrOf(fix)).toBeNull();
  });

  test('worker-pr-slot\'s sibling row for a second PR never displaces the attempt\'s own PR', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'completed' });
    await workerRow(t, { prNumber: 11, minutesAgo: 10 });
    // Newer, and a placeholder (runner external): the second PR's owner row.
    await workerRow(t, { runner: 'external', prNumber: 12, minutesAgo: 1 });
    expect(await taskPrOf(t)).toEqual({ prUrl: url(11), prNumber: 11 });
  });

  test('a newer attempt that opened its own PR wins; one with no PR yet keeps the earlier attempt\'s', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'assigned' });
    await workerRow(t, { prNumber: 21, minutesAgo: 30 });
    await workerRow(t, { prNumber: null, status: 'running', minutesAgo: 5 });
    expect((await taskPrOf(t))?.prNumber).toBe(21);
    await workerRow(t, { prNumber: 22, minutesAgo: 1 });
    expect((await taskPrOf(t))?.prNumber).toBe(22);
  });

  test('a task whose only row is a placeholder (an adopted PR) reads that row', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'completed' });
    await workerRow(t, { runner: 'external', prNumber: 31 });
    expect(await taskPrOf(t)).toEqual({ prUrl: url(31), prNumber: 31 });
  });

  test('no PR on any row: the stored result (a pre-slice row, a person\'s attach); a malformed number reads as none', async () => {
    w = await world();
    const a = await seedTask(w.workspaceId, { status: 'completed' });
    await q(sql`UPDATE tasks SET result = ${JSON.stringify({ summary: 's', prUrl: 'https://github.com/o/r/pull/41', prNumber: 41 })}::jsonb WHERE id = ${a}::uuid`);
    const b = await seedTask(w.workspaceId, { status: 'completed' });
    await q(sql`UPDATE tasks SET result = ${JSON.stringify({ prUrl: 'https://github.com/o/r/pull/x', prNumber: 'x' })}::jsonb WHERE id = ${b}::uuid`);
    const none = await seedTask(w.workspaceId, { status: 'completed' });
    const prs = await taskPrsFor([a, b, none]);
    expect(prs.get(a)).toEqual({ prUrl: 'https://github.com/o/r/pull/41', prNumber: 41 });
    expect(prs.get(b)).toEqual({ prUrl: 'https://github.com/o/r/pull/x', prNumber: null });
    expect(prs.has(none)).toBe(false);
    // A worker row outranks the stored result.
    await workerRow(a, { prNumber: 42 });
    expect((await taskPrOf(a))?.prNumber).toBe(42);
  });

  test('the SQL fragment works in a relational query\'s WHERE and in a single-table select', async () => {
    w = await world();
    const withPr = await seedTask(w.workspaceId, { status: 'completed' });
    await workerRow(withPr, { prNumber: 51 });
    const without = await seedTask(w.workspaceId, { status: 'completed' });
    await workerRow(without, { prNumber: null });
    const rows = await db.query.tasks.findMany({
      where: sqlWhere(and(eq(tasks.workspaceId, w.workspaceId), taskHasPrSql())),
      columns: { id: true },
      extras: sqlExtras({ prNumber: taskPrNumberSql() }),
    });
    expect(rows.map((r) => [r.id, (r as { prNumber?: number }).prNumber])).toEqual([[withPr, 51]]);
    const audit = await db.select({ id: tasks.id, prNumber: terminalAuditFields.prNumber }).from(tasks).where(eq(tasks.workspaceId, w.workspaceId));
    expect(Object.fromEntries(audit.map((r) => [r.id, r.prNumber]))).toEqual({ [withPr]: 51, [without]: null });
  });

  test('withTaskPrs lays the PR over each result and keeps everything else', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'completed' });
    await workerRow(t, { prNumber: 61 });
    const [row] = await withTaskPrs([{ id: t, result: { summary: 'kept' } }]);
    expect(row.result).toEqual({ summary: 'kept', prUrl: url(61), prNumber: 61 });
  });
});

describe('no attempt writer snapshots the PR into result', () => {
  test('the worker PATCH completion of a delivery owner: result carries no PR, the read derives the delivery\'s', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/tpr-patch', files: { 'src/a.ts': 'export const a = 3;\n' } });
    await q(sql`UPDATE tasks SET status = 'assigned', claimed_at = now() WHERE id = ${pr.ownerTaskId}::uuid`);
    const res = await patchWorker(pr.ownerTaskId, pr.workerId, { status: 'completed', summary: 'shipped', commitCount: 1, lastCommitSha: pr.head });
    expect(res.status).toBe(200);
    const result = await storedResult(pr.ownerTaskId);
    expect(result?.summary).toBe('shipped');
    expect(result && ('prUrl' in result || 'prNumber' in result)).toBe(false);
    expect(await taskPrOf(pr.ownerTaskId)).toEqual({ prUrl: url(pr.prNumber), prNumber: pr.prNumber });
  });

  test('a task with no delivery: the PATCH stores no PR, the read derives the worker\'s', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'assigned' });
    const wk = await workerRow(t, { prNumber: 71, status: 'running' });
    const res = await patchWorker(t, wk, { status: 'completed', summary: 'done', commitCount: 1 });
    expect(res.status).toBe(200);
    const result = await storedResult(t);
    expect(result?.summary).toBe('done');
    expect(result && ('prUrl' in result || 'prNumber' in result)).toBe(false);
    expect((await taskPrOf(t))?.prNumber).toBe(71);
  });

  test('a late end on a re-claimed task: the old attempt\'s PATCH cannot put its PR back over the new attempt\'s', async () => {
    w = await world();
    const t = await seedTask(w.workspaceId, { status: 'assigned' });
    const old = await workerRow(t, { prNumber: 81, status: 'running', minutesAgo: 20 });
    // Requeued and claimed again; the new attempt opened its own PR.
    await q(sql`UPDATE tasks SET claimed_at = now() WHERE id = ${t}::uuid`);
    await workerRow(t, { prNumber: 82, status: 'running' });
    await patchWorker(t, old, { status: 'completed', summary: 'late', commitCount: 1 });
    const result = await storedResult(t);
    expect(result && ('prUrl' in result || 'prNumber' in result)).toBe(false);
    expect((await taskPrOf(t))?.prNumber).toBe(82);
  });

  test('a loop exit that replaces result keeps the task\'s PR readable (it used to erase it)', async () => {
    w = await world();
    const pr: OpenedPr = await w.openPr({ branch: 'feat/tpr-loop', files: { 'src/a.ts': 'export const a = 4;\n' } });
    await q(sql`UPDATE tasks SET result = ${JSON.stringify({ summary: 'PR merged', loopHistory: [] })}::jsonb WHERE id = ${pr.ownerTaskId}::uuid`);
    expect((await taskPrOf(pr.ownerTaskId))?.prNumber).toBe(pr.prNumber);
  });
});
