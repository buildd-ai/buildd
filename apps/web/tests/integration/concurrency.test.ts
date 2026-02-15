/**
 * Integration Tests: Concurrency Control
 *
 * Tests worker capacity limits, concurrent claims, and race conditions.
 * Validates that buildd correctly enforces maxConcurrentWorkers limits
 * and prevents multiple workers from claiming the same task.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/concurrency.test.ts
 */

import { requireTestEnv, createTestApi, createCleanup, sleep } from '../../../../tests/test-utils';

// --- Config ---

const TIMEOUT = 30_000; // 30 seconds per test

const { server, apiKey } = requireTestEnv();
const { api } = createTestApi(server, apiKey);

/** Claim a task via the server API, returns the first worker from the response */
async function serverClaim(taskId: string): Promise<any> {
  const res = await api('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({ taskId, runner: 'concurrency-test' }),
  });
  const worker = res.workers?.[0];
  if (!worker) throw new Error(`Claim returned no worker for task ${taskId}`);
  return worker;
}

/** Clean up a worker by marking it as failed (no DELETE endpoint exists) */
async function failWorker(workerId: string) {
  await api(`/api/workers/${workerId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'failed', error: 'Concurrency test cleanup' }),
  });
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- Tests ---

describe('Concurrency Control', () => {
  let workspaceId: string;
  const cleanupWorkerIds: string[] = [];
  const cleanup = createCleanup(api);

  // Setup: Get/create workspace
  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaceId}`);
  });

  // Cleanup after each test
  afterEach(async () => {
    // Clean up workers by marking them failed
    for (const workerId of cleanupWorkerIds) {
      try {
        await failWorker(workerId);
      } catch (err) {
        console.warn(`Failed to cleanup worker ${workerId}:`, err);
      }
    }
    cleanupWorkerIds.length = 0;
  });

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('should enforce maxConcurrentWorkers limit', async () => {
    console.log('\n=== Test: Max Concurrent Workers ===');

    // Get account info (maxConcurrentWorkers)
    const account = await api('/api/accounts/me');
    const maxConcurrent = account.maxConcurrentWorkers || 5;
    console.log(`  Account max concurrent: ${maxConcurrent}`);

    // Create tasks (more than limit)
    const taskCount = maxConcurrent + 2;
    const taskIds: string[] = [];

    for (let i = 0; i < taskCount; i++) {
      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: `Concurrency test task ${i + 1}`,
          description: 'Test task for concurrency limits',
        }),
      });
      taskIds.push(task.id);
      cleanup.trackTask(task.id);
    }

    assert(taskIds.length === taskCount, `Created ${taskCount} tasks`);

    // Try to claim all tasks (should only succeed up to maxConcurrent)
    const claimedWorkerIds: string[] = [];

    for (const taskId of taskIds) {
      try {
        const worker = await serverClaim(taskId);
        claimedWorkerIds.push(worker.id);
        cleanupWorkerIds.push(worker.id);
        cleanup.trackWorker(worker.id);
      } catch (err: any) {
        // Expected to fail after maxConcurrent claims
        if (claimedWorkerIds.length >= maxConcurrent) {
          console.log(`  ✓ Claim rejected after ${maxConcurrent} workers (expected)`);
        } else {
          throw err;
        }
      }
    }

    assert(
      claimedWorkerIds.length <= maxConcurrent,
      `Claimed workers (${claimedWorkerIds.length}) <= maxConcurrent (${maxConcurrent})`
    );
  }, TIMEOUT);

  test('should prevent multiple workers claiming same task', async () => {
    console.log('\n=== Test: Race Condition - Same Task ===');

    // Create a single task
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Race condition test task',
        description: 'Only one worker should claim this',
      }),
    });
    cleanup.trackTask(task.id);

    // Try to claim the same task concurrently (simulate race)
    const claimPromises = Array.from({ length: 3 }, () =>
      api('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ taskId: task.id, runner: 'concurrency-test' }),
      }).catch(err => ({ error: err.message }))
    );

    const results = await Promise.all(claimPromises);

    // Count successful claims (must have at least one worker in response)
    const successfulClaims = results.filter(r => !('error' in r) && (r as any).workers?.length > 0);
    const failedClaims = results.filter(r => 'error' in r || (r as any).workers?.length === 0);

    assert(successfulClaims.length === 1, 'Exactly one worker claimed the task');
    assert(failedClaims.length === 2, 'Two claims were rejected');

    // Track successful worker for cleanup
    if (successfulClaims.length > 0) {
      const worker = (successfulClaims[0] as any).workers?.[0];
      if (worker) {
        cleanupWorkerIds.push(worker.id);
        cleanup.trackWorker(worker.id);
      }
    }
  }, TIMEOUT);

  test('should release capacity when worker completes', async () => {
    console.log('\n=== Test: Capacity Release on Completion ===');

    // Create two tasks
    const task1 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Capacity test task 1',
        description: 'First task',
      }),
    });
    const task2 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Capacity test task 2',
        description: 'Second task',
      }),
    });
    cleanup.trackTask(task1.id);
    cleanup.trackTask(task2.id);

    // Claim first task
    const worker1 = await serverClaim(task1.id);
    cleanupWorkerIds.push(worker1.id);
    cleanup.trackWorker(worker1.id);
    assert(!!worker1.id, 'Worker 1 claimed task 1');

    // Mark worker 1 as done
    await api(`/api/workers/${worker1.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });

    // Wait a moment for capacity to update
    await sleep(500);

    // Should now be able to claim second task (capacity released)
    const worker2 = await serverClaim(task2.id);
    cleanupWorkerIds.push(worker2.id);
    cleanup.trackWorker(worker2.id);
    assert(!!worker2.id, 'Worker 2 claimed task 2 (capacity released)');
  }, TIMEOUT);

  test('should release capacity when worker errors', async () => {
    console.log('\n=== Test: Capacity Release on Error ===');

    // Create task
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Error test task',
        description: 'Task that will error',
      }),
    });
    cleanup.trackTask(task.id);

    // Claim task
    const worker = await serverClaim(task.id);
    cleanupWorkerIds.push(worker.id);
    cleanup.trackWorker(worker.id);

    // Mark worker as failed
    await api(`/api/workers/${worker.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        error: 'Agent stuck: made 5 identical calls',
      }),
    });

    // Verify capacity was released (check active workers)
    const { activeLocalUis } = await api('/api/workers/active');
    const totalActive = activeLocalUis.reduce((sum: number, ui: any) => sum + ui.activeWorkers, 0);

    // Active count should not include the failed worker
    assert(totalActive === 0, 'Failed worker released capacity');
  }, TIMEOUT);

  test('should handle multiple local-ui instances sharing capacity', async () => {
    console.log('\n=== Test: Multiple Local-UI Instances ===');

    // This test validates that capacity is tracked per-account, not per-instance
    // In practice, this would require multiple local-ui processes running

    // Get active local-ui instances
    const { activeLocalUis } = await api('/api/workers/active');

    if (activeLocalUis.length === 0) {
      console.log('  Skipping (no active local-ui instances)');
      return;
    }

    // Verify capacity calculation is correct
    activeLocalUis.forEach((ui: any) => {
      const capacity = ui.maxConcurrent - ui.activeWorkers;
      assert(capacity >= 0, `Instance ${ui.accountId} has non-negative capacity`);
      console.log(`  Instance ${ui.accountId}: ${ui.activeWorkers}/${ui.maxConcurrent} (${capacity} available)`);
    });
  }, TIMEOUT);
});
