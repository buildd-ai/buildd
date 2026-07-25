/**
 * Manual full-stack acceptance for the loop-until-verified primitive.
 *
 * This suite drives a real web server and workspace through HTTP. It uses the
 * matching test database only to install facts that normally arrive from
 * independent systems (a budget reset floor and a GitHub mergedAt webhook).
 *
 * Required:
 *   LOOP_ACCEPTANCE_E2E=1
 *   BUILDD_TEST_SERVER=http://localhost:3000 (or a dedicated preview)
 *   BUILDD_API_KEY=...
 *   BUILDD_ADMIN_API_KEY=...
 *   DATABASE_URL=... (the same database used by BUILDD_TEST_SERVER)
 *
 * Run:
 *   LOOP_ACCEPTANCE_E2E=1 bun test --env-file tests/.env.test \
 *     tests/e2e/loop-until-verified.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestApi } from '../test-utils';

const ENABLED = process.env.LOOP_ACCEPTANCE_E2E === '1';
const SERVER = process.env.BUILDD_TEST_SERVER;
const API_KEY = process.env.BUILDD_API_KEY;
const ADMIN_API_KEY = process.env.BUILDD_ADMIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const TIMEOUT = 60_000;

type ClaimedWorker = {
  id: string;
  taskId: string;
  branch: string | null;
  task?: {
    context?: Record<string, unknown>;
    loopIteration?: number;
    loopState?: string | null;
  };
};

const createdTaskIds: string[] = [];
const createdWorkerIds: string[] = [];

let workspaceId: string;
let api: ReturnType<typeof createTestApi>['api'];
let apiRaw: ReturnType<typeof createTestApi>['apiRaw'];
let adminApiRaw: ReturnType<typeof createTestApi>['apiRaw'];
let testDb: any;
let taskTable: any;
let workerTable: any;
let workspaceTable: any;
let equals: (column: unknown, value: unknown) => unknown;

function requireAcceptanceEnv(): void {
  const missing = [
    !SERVER && 'BUILDD_TEST_SERVER',
    !API_KEY && 'BUILDD_API_KEY',
    !ADMIN_API_KEY && 'BUILDD_ADMIN_API_KEY',
    !DATABASE_URL && 'DATABASE_URL',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`LOOP_ACCEPTANCE_E2E=1 requires ${missing.join(', ')}`);
  }
}

async function createTask(overrides: Record<string, unknown> = {}) {
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      title: `[LOOP-ACCEPTANCE] ${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: 'Deterministic loop acceptance probe; no agent execution required.',
      outputRequirement: 'none',
      ...overrides,
    }),
  });
  createdTaskIds.push(task.id);
  return task;
}

async function claim(taskId: string): Promise<ClaimedWorker | null> {
  const { status, body } = await apiRaw('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, taskId, runner: 'loop-acceptance-e2e' }),
  });
  expect(status).toBe(200);
  const worker = body.workers?.[0] ?? null;
  if (worker) createdWorkerIds.push(worker.id);
  return worker;
}

async function complete(
  worker: ClaimedWorker,
  exitCode: number,
  extras: Record<string, unknown> = {},
) {
  const { status, body } = await apiRaw(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'completed',
      lastCommitSha: `acceptance-${worker.id.slice(0, 8)}`,
      verificationEvidence: {
        workerId: worker.id,
        iteration: worker.task?.loopIteration ?? 0,
        conditionType: 'command',
        exitCode,
        outcome: exitCode === 0 ? 'ok' : 'failed',
        stdout: exitCode === 0 ? 'verification passed' : 'verification failed',
      },
      ...extras,
    }),
  });
  expect(status).toBe(200);
  return body;
}

async function getTask(taskId: string) {
  return api(`/api/tasks/${taskId}`);
}

async function failWorker(worker: ClaimedWorker | null) {
  if (!worker) return;
  await apiRaw(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'failed', error: 'Loop acceptance cleanup' }),
  });
}

describe.skipIf(!ENABLED)('E2E: loop-until-verified acceptance', () => {
  beforeAll(async () => {
    requireAcceptanceEnv();
    ({ api, apiRaw } = createTestApi(SERVER!, API_KEY!));
    ({ apiRaw: adminApiRaw } = createTestApi(SERVER!, ADMIN_API_KEY!));
    const [{ db }, schema, drizzle] = await Promise.all([
      import('../../packages/core/db'),
      import('../../packages/core/db/schema'),
      import('../../packages/core/node_modules/drizzle-orm'),
    ]);
    testDb = db;
    taskTable = schema.tasks;
    workerTable = schema.workers;
    workspaceTable = schema.workspaces;
    equals = drizzle.eq;
    const { workspaces } = await api('/api/workspaces');
    const workspace = process.env.BUILDD_WORKSPACE_ID
      ? workspaces.find((candidate: any) => candidate.id === process.env.BUILDD_WORKSPACE_ID)
      : workspaces.find((candidate: any) => candidate.name?.toLowerCase().includes('buildd'))
        ?? workspaces[0];
    if (!workspace) throw new Error('No real workspace is available for loop acceptance');
    workspaceId = workspace.id;
    const matchingWorkspace = await testDb.query.workspaces.findFirst({
      where: equals(workspaceTable.id, workspaceId),
      columns: { id: true },
    });
    if (!matchingWorkspace) {
      throw new Error(
        'DATABASE_URL does not match BUILDD_TEST_SERVER; refusing acceptance mutations',
      );
    }
  }, TIMEOUT);

  afterAll(async () => {
    for (const workerId of createdWorkerIds) {
      await apiRaw(`/api/workers/${workerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', error: 'Loop acceptance cleanup' }),
      }).catch(() => undefined);
    }
    for (const taskId of createdTaskIds) {
      await apiRaw(`/api/tasks/${taskId}?force=true`, { method: 'DELETE' })
        .catch(() => undefined);
    }
  }, TIMEOUT);

  test('happy loop uses exactly two iterations on one branch and exempts the unmet iteration from retries', async () => {
    const task = await createTask({
      context: { verificationCommand: 'test -f .loop-acceptance-pass' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'test -f .loop-acceptance-pass' },
        maxLoops: 2,
        backoffMinutes: 0,
      },
    });

    const first = await claim(task.id);
    expect(first).toBeTruthy();
    await complete(first!, 1);

    const between = await getTask(task.id);
    expect(between.status).toBe('pending');
    expect(between.loopIteration).toBe(1);
    expect(between.loopState).toBe('condition_unmet');
    expect(between.context.retryCount ?? 0).toBe(0);
    expect(between.context.loopHistory).toHaveLength(1);

    const second = await claim(task.id);
    expect(second).toBeTruthy();
    expect(second!.branch).toBe(first!.branch);
    expect(second!.task?.context?.failureContext).toEqual(between.context.failureContext);
    expect(second!.task?.context?.failureContext).toMatchObject({
      iteration: 1,
      conditionType: 'command',
    });

    await complete(second!, 0);
    const satisfied = await getTask(task.id);
    expect(satisfied.status).toBe('completed');
    expect(satisfied.loopState).toBe('satisfied');
    expect(satisfied.loopIteration).toBe(2);
    expect(satisfied.context.retryCount ?? 0).toBe(0);
    expect(satisfied.result.loopHistory).toHaveLength(2);

    const third = await claim(task.id);
    expect(third).toBeNull();
  }, TIMEOUT);

  test('never-passing condition exhausts after two evaluations with complete history', async () => {
    const task = await createTask({
      context: { verificationCommand: 'false' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'false' },
        maxLoops: 2,
        backoffMinutes: 0,
      },
    });

    const first = await claim(task.id);
    expect(first).toBeTruthy();
    await complete(first!, 1);
    const second = await claim(task.id);
    expect(second).toBeTruthy();
    await complete(second!, 1);

    const exhausted = await getTask(task.id);
    expect(exhausted.status).toBe('failed');
    expect(exhausted.loopState).toBe('exhausted');
    expect(exhausted.loopIteration).toBe(2);
    expect(exhausted.context.retryCount ?? 0).toBe(0);
    expect(exhausted.result.error).toMatch(/Loop condition unmet after 2 attempt/);
    expect(exhausted.result.loopHistory).toHaveLength(2);
    expect(exhausted.result.loopHistory.map((entry: any) => entry.workerId))
      .toEqual([first!.id, second!.id]);
    expect(await claim(task.id)).toBeNull();
  }, TIMEOUT);

  test('cleanup cannot evaluate or reap a healthy between-iterations task', async () => {
    const task = await createTask({
      context: { verificationCommand: 'false' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'false' },
        maxLoops: 2,
        backoffMinutes: 1,
      },
    });
    const first = await claim(task.id);
    expect(first).toBeTruthy();
    await complete(first!, 1);
    const before = await getTask(task.id);

    const cleanup = await adminApiRaw('/api/tasks/cleanup', { method: 'POST' });
    expect(cleanup.status).toBe(200);

    const after = await getTask(task.id);
    expect(after.status).toBe('pending');
    expect(after.loopState).toBe('condition_unmet');
    expect(after.loopIteration).toBe(before.loopIteration);
    expect(after.context.loopHistory).toEqual(before.context.loopHistory);
    expect(await claim(task.id)).toBeNull();
  }, TIMEOUT);

  test('later budget floor beats loop backoff and atomic claim starts the next iteration once', async () => {
    const task = await createTask({
      context: { verificationCommand: 'false' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'false' },
        maxLoops: 2,
        backoffMinutes: 1,
      },
    });
    const first = await claim(task.id);
    expect(first).toBeTruthy();

    const budgetFloor = new Date(Date.now() + 10 * 60_000);
    await testDb.update(taskTable).set({ startAt: budgetFloor }).where(equals(taskTable.id, task.id));
    await complete(first!, 1);

    const deferred = await getTask(task.id);
    expect(new Date(deferred.startAt).getTime()).toBeGreaterThanOrEqual(budgetFloor.getTime());
    expect(await claim(task.id)).toBeNull();

    await testDb.update(taskTable)
      .set({ startAt: new Date(Date.now() - 1_000) })
      .where(equals(taskTable.id, task.id));
    const concurrentClaims = await Promise.all([
      claim(task.id),
      claim(task.id),
    ]);
    const winners = concurrentClaims.filter(Boolean) as ClaimedWorker[];
    expect(winners).toHaveLength(1);
    await failWorker(winners[0]);
  }, TIMEOUT);

  test('dependency stays gated until loop satisfaction and the upstream PR merge fact', async () => {
    const upstream = await createTask({
      context: { verificationCommand: 'true' },
      loopConfig: {
        exitCondition: { type: 'command', command: 'true' },
        maxLoops: 2,
        backoffMinutes: 0,
      },
    });
    const downstream = await createTask({ dependsOn: [upstream.id] });

    expect(await claim(downstream.id)).toBeNull();
    const upstreamWorker = await claim(upstream.id);
    expect(upstreamWorker).toBeTruthy();
    await complete(upstreamWorker!, 0, {
      prUrl: 'https://github.com/buildd-ai/buildd/pull/1',
      prNumber: 1,
    });

    const satisfied = await getTask(upstream.id);
    expect(satisfied.loopState).toBe('satisfied');
    expect(await claim(downstream.id)).toBeNull();

    await testDb.update(workerTable)
      .set({ mergedAt: new Date(), prLifecycleStatus: 'merged' })
      .where(equals(workerTable.id, upstreamWorker!.id));

    const released = await claim(downstream.id);
    expect(released?.taskId).toBe(downstream.id);
    await failWorker(released);
  }, TIMEOUT);

  test('task without loopConfig writes no loop state/history and dispatches only once', async () => {
    const task = await createTask();
    const onlyWorker = await claim(task.id);
    expect(onlyWorker).toBeTruthy();

    const { status } = await apiRaw(`/api/workers/${onlyWorker!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', result: { summary: 'legacy completion' } }),
    });
    expect(status).toBe(200);

    const completed = await getTask(task.id);
    expect(completed.status).toBe('completed');
    expect(completed.loopConfig ?? null).toBeNull();
    expect(completed.loopState ?? null).toBeNull();
    expect(completed.context.loopHistory).toBeUndefined();
    expect(completed.result.loopHistory).toBeUndefined();
    expect(await claim(task.id)).toBeNull();
  }, TIMEOUT);
});
