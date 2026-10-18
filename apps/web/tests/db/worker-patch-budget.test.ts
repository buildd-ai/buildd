import { describe, it, expect, mock, setDefaultTimeout } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace, seedTask } from './harness';
import { recordNeonQueries } from '@buildd/core/db';

assertDbConfigured();
setDefaultTimeout(60_000);

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));
const workersRoute = await import('../../src/app/api/workers/[id]/route');

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
  return { key, workerId: wk.id, taskId, workspaceId };
}

async function patch(s: { key: string; workerId: string }, body: Record<string, unknown>) {
  const rec = await recordNeonQueries(async () => {
    const res = await workersRoute.PATCH(
      new NextRequest(`http://localhost/api/workers/${s.workerId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id: s.workerId }) } as never,
    );
    return res;
  });
  return rec;
}

const LOG = '/tmp/worker-patch-budget.log';
function log(name: string, rec: Awaited<ReturnType<typeof patch>>) {
  appendFileSync(LOG, `\n== ${name}: ${rec.count} queries (status ${(rec.result as Response).status})\n`
    + rec.queries.map(x => `  ${x.operation} ${x.table} :: ${x.head.slice(0, 110)}`).join('\n') + '\n');
}

describe('worker PATCH budget (scratch)', () => {
  it('progress sync', async () => {
    const s = await seed();
    const sync = { status: 'running', currentAction: 'Editing route.ts', milestones: [{ type: 'action', label: 'x', ts: 1 }], branch: 'buildd/x', localUiUrl: null, siblingProbe: true, consumeInstructions: true, consumer: 'runner', dirtyWorktree: false };
    log('progress', await patch(s, sync));
    log('heartbeat (same sync again)', await patch(s, sync));
    log('delivery ack', await patch(s, { instructionIdsDelivered: ['abc'], consumer: 'runner' }));
    log('pr fields', await patch(s, { prUrl: 'https://github.com/o/r/pull/7', prNumber: 7 }));
    log('waiting_input', await patch(s, { status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Which one?', options: ['a', 'b'] } }));
    log('back to running', await patch(s, { ...sync, status: 'running' }));
    log('completion', await patch(s, { status: 'completed', summary: 'done' }));
    expect(true).toBe(true);
  });
});
