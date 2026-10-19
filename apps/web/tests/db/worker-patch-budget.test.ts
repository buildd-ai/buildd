/**
 * PATCH /api/workers/[id] query budget (Living Spec "Fast at any size",
 * spec 3ef37387 R-33): at most 10 database round trips per update, and a
 * report that changes nothing writes nothing to the worker row.
 *
 * Counted with `recordNeonQueries` (packages/core/db/query-label.ts), the same
 * fetch hook that labels production spans. Work deferred past the response
 * (`after()`) is not part of the reply's
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
// Exercise Redis liveness without a network service; SQL itself remains real.
const redis = await import('../../src/lib/redis');
const beats = new Map<string, unknown>();
mock.module('../../src/lib/redis', () => ({
  ...redis,
  setWithTtl: async (key: string, value: unknown, ttl: number) => {
    if (!key.startsWith('buildd:live:worker')) return redis.setWithTtl(key, value, ttl);
    beats.set(key, value);
    return true;
  },
  getKey: async (key: string) => key.startsWith('buildd:live:worker') ? beats.get(key) ?? null : redis.getKey(key),
  getKeys: async (keys: string[]) => keys.every(k => k.startsWith('buildd:live:worker'))
    ? keys.map(k => beats.get(k) ?? null) : Promise.all(keys.map(k => redis.getKey(k))),
}));
const deferred: Array<() => Promise<unknown>> = [];
const realNext = await import('next/server');
mock.module('next/server', () => ({ ...realNext, after: (fn: () => Promise<unknown>) => deferred.push(fn) }));
const workersRoute = await import('../../src/app/api/workers/[id]/route');

const BUDGET = 10;
/** A terminal report's follow-up runs inline (see the completion case). */
const TERMINAL_BUDGET = 60;

async function seed(warm = true) {
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
  if (warm) await patch(s, { currentAction: 'Reading a file' });
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
  // Run the real after-response work, outside the reply's recording.
  // Drain completely so one case cannot leak effects into another.
  while (deferred.length) await deferred.shift()!();
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

async function expectWithinBudget(name: string, rec: Awaited<ReturnType<typeof patch>>, status = 200, budget = BUDGET) {
  const res = rec.result as Response;
  expect({ name, status: res.status }).toEqual({ name, status });
  // The query list rides in the failure so a regression names its new query.
  process.stdout.write(`[worker PATCH budget] ${name}: ${rec.count} round trips\n`);
  expect({ name, overBudget: rec.count > budget ? describeRec(rec) : null }).toEqual({ name, overBudget: null });
}

describe('PATCH /api/workers/[id] query budget (R-33)', () => {
  it('a progress report with a cold authentication key', async () => {
    const s = await seed(false);
    await expectWithinBudget('cold progress', await patch(s, SYNC));
  });

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
    expect(rec.queries.filter(x => ['update', 'insert', 'delete'].includes(x.operation))).toEqual([]);
  });

  it('repeating unchanged usage totals is still a heartbeat', async () => {
    const s = await seed();
    const report = { ...SYNC, costUsd: 0.5, costBasis: 'virtual', inputTokens: 100, outputTokens: 20, turns: 4 };
    await patch(s, report);
    const rec = await patch(s, report);
    await expectWithinBudget('unchanged usage', rec);
    expect(rec.queries.filter(x => ['update', 'insert', 'delete'].includes(x.operation))).toEqual([]);
  });

  it('a heartbeat with an old durable timestamp records only Redis liveness', async () => {
    const s = await seed();
    await patch(s, SYNC);
    await q(sql`UPDATE workers SET updated_at = now() - interval '2 hours' WHERE id = ${s.workerId}::uuid`);
    const rec = await patch(s, SYNC);
    await expectWithinBudget('Redis heartbeat', rec);
    expect(rec.queries.filter(x => ['update', 'insert', 'delete'].includes(x.operation))).toEqual([]);
    expect(beats.has(`buildd:live:worker:${s.workerId}`)).toBe(true);
  });

  it('a parked interactive poll records Redis presence without moving its expiry clock', async () => {
    const s = await seed();
    await q(sql`UPDATE workers SET runner = 'mcp', status = 'waiting_input', supports_instruction_ack = true,
      waiting_for = '{"type":"question","prompt":"Continue?","sessionSeenAt":"2026-01-01T00:00:00Z"}'::jsonb,
      updated_at = now() - interval '2 hours' WHERE id = ${s.workerId}::uuid`);
    const rec = await patch(s, { consumer: 'agent', consumeInstructions: true });
    await expectWithinBudget('parked heartbeat', rec);
    expect(rec.queries.filter(x => ['update', 'insert', 'delete'].includes(x.operation))).toEqual([]);
    expect(beats.has(`buildd:live:worker-session:${s.workerId}`)).toBe(true);
  });

  it('a delivery acknowledgement', async () => {
    const s = await seed();
    const rec = await patch(s, { instructionIdsDelivered: ['00000000-0000-4000-8000-000000000001'], consumer: 'runner' });
    await expectWithinBudget('delivery ack', rec);
  });

  it('a text delivery acknowledgement clears the queue in the diff write', async () => {
    const s = await seed();
    const instructionId = crypto.randomUUID();
    await q(sql`UPDATE workers SET pending_instructions = 'Please check the tests', instruction_history = ${JSON.stringify([
      { id: instructionId, type: 'instruction', message: 'Please check the tests', timestamp: 1, deliveryState: 'pending' },
    ])}::jsonb WHERE id = ${s.workerId}::uuid`);
    const rec = await patch(s, { instructionsDelivered: 'Please check the tests', instructionIdsDelivered: [instructionId], consumer: 'runner' });
    await expectWithinBudget('text delivery ack', rec);
    expect(workerWrites(rec)).toBe(1);
    const [row] = await q<{ pending_instructions: string | null }>(sql`SELECT pending_instructions FROM workers WHERE id = ${s.workerId}::uuid`);
    expect(row.pending_instructions).toBeNull();
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
    // A terminal report runs its follow-up (release, reviewer verdict, the
    // kernel's attempt end, terminal records) before the reply: deferring it
    // lost outcomes in v0.367.0. Bounded here so it cannot grow unnoticed.
    await expectWithinBudget('completion', rec, 200, TERMINAL_BUDGET);
    const [w] = await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${s.workerId}::uuid`);
    expect(w.status).toBe('completed');
    const [t] = await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${s.taskId}::uuid`);
    expect(t.status).toBe('completed');
  });
});
