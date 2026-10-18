/**
 * A CI-fix attempt's worker as the task page reads it
 * (apps/web/src/app/app/(protected)/tasks/[id]/attempt-worker-extras.ts),
 * against real Postgres: the whole milestone log only for a worker with error
 * traces, otherwise its action entries; resultMeta cut to the keys the page shows.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { workers } = await import('@buildd/core/db/schema');
const { sqlWhere } = await import('@buildd/core/db/relational-sql');
const { ATTEMPT_WORKER_EXTRAS, ATTEMPT_WORKER_PROJECTED_COLUMNS } = await import('../../src/app/app/(protected)/tasks/[id]/attempt-worker-extras');

const MILESTONES = [
  { type: 'status', label: 'Reading the failure', ts: 1 },
  { type: 'action', label: 'bun run test', cmd: 'bun run test', ts: 2 },
  { type: 'status', label: 'Pushed the fix', ts: 3 },
  { type: 'action', label: 'git push', cmd: 'git push', ts: 4 },
];
const RESULT_META = {
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, costUSD: 0.01 } },
  stopReason: 'max_turns', durationMs: 9000, durationApiMs: 7000,
  notes: 'A long session summary the page never draws.',
};

let workspaceId: string;
let taskId: string;

async function seedWorker(milestones: unknown, resultMeta: unknown): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, milestones, result_meta)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'attempt', 'runner-1', 'buildd/attempt', 'completed',
      ${JSON.stringify(milestones)}::jsonb, ${resultMeta == null ? null : JSON.stringify(resultMeta)}::jsonb)
    RETURNING id`);
  return w.id;
}

async function read(id: string) {
  const row = await db.query.workers.findFirst({
    where: sqlWhere(sql`${workers.id} = ${id}::uuid`),
    columns: { id: true, ...ATTEMPT_WORKER_PROJECTED_COLUMNS },
    extras: ATTEMPT_WORKER_EXTRAS,
  });
  return row as unknown as { milestones: unknown; resultMeta: unknown };
}

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
  taskId = await seedTask(workspaceId, { status: 'completed' });
});

describe('attempt worker extras', () => {
  test('a worker with no error trace sends only its action milestones, in order', async () => {
    const id = await seedWorker(MILESTONES, RESULT_META);
    expect((await read(id)).milestones).toEqual([MILESTONES[1], MILESTONES[3]]);
  });

  test('a worker with an error trace sends its whole log, for the lines around the trace', async () => {
    const id = await seedWorker(MILESTONES, RESULT_META);
    await q(sql`INSERT INTO worker_error_traces (worker_id, task_id, pattern, excerpt, ts)
      VALUES (${id}::uuid, ${taskId}::uuid, 'tool_error', 'boom', now())`);
    expect((await read(id)).milestones).toEqual(MILESTONES);
  });

  test('no actions, or no log at all, reads as an empty list', async () => {
    expect((await read(await seedWorker([MILESTONES[0]], null))).milestones).toEqual([]);
    expect((await read(await seedWorker({ not: 'a list' }, null))).milestones).toEqual([]);
  });

  test('resultMeta keeps only the keys the page shows, and stays null when absent', async () => {
    const id = await seedWorker([], RESULT_META);
    const { notes: _notes, ...shown } = RESULT_META;
    expect((await read(id)).resultMeta).toEqual(shown);
    expect((await read(await seedWorker([], null))).resultMeta).toBeNull();
  });
});
