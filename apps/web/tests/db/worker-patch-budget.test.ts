/**
 * PATCH /api/workers/[id] query budget (Living Spec "Fast at any size",
 * spec 3ef37387 R-33): at most 10 database round trips per update, and a
 * report that changes nothing writes nothing to the worker row.
 *
 * Counted with `recordNeonQueries` (packages/core/db/query-label.ts), the same
 * fetch hook that labels production spans. Work deferred past the response
 * (`after()`, detached outside a request scope) is not part of the reply's
 * budget; each case waits for it to settle before the next one runs.
 */
import { describe, it, expect, mock, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace, seedTask } from './harness';
import { recordNeonQueries } from '@buildd/core/db';

assertDbConfigured();
setDefaultTimeout(60_000);

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));
const workersRoute = await import('../../src/app/api/workers/[id]/route');

const BUDGET = 10;

async function seed() {
  const { teamId, workspaceId } = await seedWorkspace();
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hashed = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hashed}, ${teamId}::uuid, 'worker', 10) RETURNING id`);
  const taskId = await seedTask(workspaceId, { status: 'assigned' });
  await q(sql`UPDATE tasks SET output_requirement = 'none', claimed_at = now() WHERE id = ${taskId}::uuid`);
  const [wk] = await q<{ id: string }>(sql`INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status, current_action)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${a.id}::uuid, 'w', 'test', 'buildd/x', 'running', 'Reading a file') RETURNING id`);
  const s = { key, workerId: wk.id, taskId, workspaceId };
  // The first request on a key pays its authentication (account read, last-used
  // stamp, plan); a live runner's key is warm. Warm it so each case measures the route.
  await patch(s, { currentAction: 'Reading a file' });
  return s;
}

async function patch(s: { key: string; workerId: string }, body: Record<string, unknown>) {
  const rec = await recordNeonQueries(() => workersRoute.PATCH(
    new NextRequest(`http://localhost/api/workers/${s.workerId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: s.workerId }) } as never,
  ));
  // Let deferred side effects finish outside the recording.
  await new Promise(r => setTimeout(r, 300));
  return rec;
}

function describeRec(rec: Awaited<ReturnType<typeof patch>>): string {
  return rec.queries.map(x => `${x.operation} ${x.table} [${x.head.slice(0, 70)}]`).join('\n');
}

function workerWrites(rec: Awaited<ReturnType<typeof patch>>): number {
  return rec.queries.filter(x => x.operation === 'update' && x.table === 'workers').length;
}

const SYNC = {
  status: 'running',
  currentAction: 'Editing route.ts',
  milestones: [{ type: 'action', label: 'Editing route.ts', ts: 1 }],
  branch: 'buildd/x',
  localUiUrl: null,
  siblingProbe: true,
  consumeInstructions: true,
  consumer: 'runner',
  dirtyWorktree: false,
};

async function expectWithinBudget(name: string, rec: Awaited<ReturnType<typeof patch>>, status = 200) {
  const res = rec.result as Response;
  expect({ name, status: res.status }).toEqual({ name, status });
  // The query list rides in the failure so a regression names its new query.
  expect({ name, overBudget: rec.count > BUDGET ? describeRec(rec) : null }).toEqual({ name, overBudget: null });
}

describe('PATCH /api/workers/[id] query budget (R-33)', () => {
  it('a progress report', async () => {
    const s = await seed();
    const rec = await patch(s, SYNC);
    await expectWithinBudget('progress', rec);
    expect(workerWrites(rec)).toBe(1);
  });

  it('a busy runner sync: commits, touched paths, telemetry appends', async () => {
    const s = await seed();
    const paths = ['apps/web/src/a.ts', 'apps/web/src/b.ts', 'apps/web/src/c.ts', 'packages/core/d.ts', 'docs/e.md'];
    const rec = await patch(s, {
      ...SYNC,
      lastCommitSha: 'a'.repeat(40),
      commitCount: 2,
      workingSet: { generation: 1, add: paths, remove: [], complete: true, includeHeld: true },
      touchedPaths: paths,
      appendMcpCalls: [{ server: 'buildd', tool: 'update_progress', ts: 1, ok: true }, { server: 'buildd', tool: 'recall', ts: 2, ok: true }],
      appendActionEvents: [{ action: 'Edit', ts: 1 }, { action: 'Bash', ts: 2 }],
      appendErrorTraces: [{ pattern: 'enoent', excerpt: 'ENOENT: no such file', source: 'tool' }],
      taskProgress: [{ id: 'sub-1', label: 'Searching', status: 'running' }],
    });
    await expectWithinBudget('busy sync', rec);
  });

  it('a heartbeat (the same report again) writes nothing', async () => {
    const s = await seed();
    await patch(s, SYNC);
    const rec = await patch(s, SYNC);
    await expectWithinBudget('heartbeat', rec);
    expect(workerWrites(rec)).toBe(0);
    expect(rec.queries.filter(x => x.operation === 'insert')).toEqual([]);
  });

  it('a delivery acknowledgement', async () => {
    const s = await seed();
    const rec = await patch(s, { instructionIdsDelivered: ['00000000-0000-4000-8000-000000000001'], consumer: 'runner' });
    await expectWithinBudget('delivery ack', rec);
  });

  it('PR fields', async () => {
    const s = await seed();
    const rec = await patch(s, { prUrl: 'https://github.com/o/r/pull/7', prNumber: 7 });
    await expectWithinBudget('pr fields', rec);
  });

  it('waiting_input, then back to running', async () => {
    const s = await seed();
    const parked = await patch(s, { status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Which one?', options: ['a', 'b'] } });
    await expectWithinBudget('waiting_input', parked);
    const resumed = await patch(s, SYNC);
    await expectWithinBudget('status change', resumed);
  });

  it('completion', async () => {
    const s = await seed();
    const rec = await patch(s, { status: 'completed', summary: 'done' });
    await expectWithinBudget('completion', rec);
    const [w] = await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${s.workerId}::uuid`);
    expect(w.status).toBe('completed');
    const [t] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${s.taskId}::uuid`);
    expect(t.status).toBe('completed');
  });
});
