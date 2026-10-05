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

import { requireTestEnv, createTestApi, createCleanup, sleep, findFixtureWorkspace } from '../../../../tests/test-utils';

// --- Config ---

const TIMEOUT = 30_000; // 30 seconds per test

const { server, apiKey } = requireTestEnv();
const { api, apiRaw } = createTestApi(server, apiKey);

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

/** Clean up a worker by marking it as failed. Tolerates 409 (already terminated). */
async function failWorker(workerId: string) {
  const { status } = await apiRaw(`/api/workers/${workerId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'failed', error: 'Concurrency test cleanup' }),
  });
  if (status !== 200 && status !== 409) {
    console.warn(`  Cleanup worker ${workerId}: unexpected status ${status}`);
  }
}

/** Map items through fn with at most `limit` calls in flight; preserves order. */
async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 10): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
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
    workspaceId = await findFixtureWorkspace(api);
    console.log(`  Using workspace: ${workspaceId}`);
    // Raise the per-workspace concurrency cap so these tests exercise the ACCOUNT
    // maxConcurrentWorkers limit rather than the per-repo cap (default 3), which
    // would otherwise bind first and block claims before the account ceiling.
    try {
      await api(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ maxConcurrentTasks: 100 }),
      });
    } catch (err) {
      console.warn(`  Could not raise maxConcurrentTasks (continuing): ${err}`);
    }
  }, TIMEOUT);

  // Cleanup after each test
  afterEach(async () => {
    // Clean up workers by marking them failed (parallel to avoid timeout)
    await Promise.all(
      cleanupWorkerIds.map(workerId =>
        failWorker(workerId).catch(err => {
          // Silently ignore errors - likely already cleaned up
        })
      )
    );
    cleanupWorkerIds.length = 0;
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  }, TIMEOUT); // default 5s hook timeout is too short to delete ~100 workers/tasks

  test('should enforce maxConcurrentWorkers limit', async () => {
    console.log('\n=== Test: Max Concurrent Workers ===');

    // Get account info (maxConcurrentWorkers)
    const account = await api('/api/accounts/me');
    const maxConcurrent = account.maxConcurrentWorkers || 5;

    // Check how many workers are already active (stale from prior runs)
    // Use /api/workers/mine with the same status filter as the claim route
    // to get an accurate count that matches server-side enforcement.
    const { workers: activeWorkerList } = await api('/api/workers/mine?status=idle,running,starting,waiting_input');
    const currentActive = activeWorkerList.length;
    const availableSlots = maxConcurrent - currentActive;
    console.log(`  Account max concurrent: ${maxConcurrent}, currently active: ${currentActive}, available: ${availableSlots}`);

    if (availableSlots < 2) {
      console.log('  Skipping: not enough capacity slots available (need at least 2 free)');
      return;
    }

    // Create tasks (more than available slots). Filling the cap takes
    // ~2 × maxConcurrentWorkers requests (the test account's cap is 50), and at
    // a few hundred ms each a serial loop overran the 30s budget. Once the test
    // timed out, afterEach failed the already-claimed workers while the loop was
    // still claiming, freeing capacity mid-loop and producing a bogus
    // "Claimed workers (51) <= 50" on top of the timeout. Run both phases
    // through a bounded pool instead.
    const taskCount = availableSlots + 2;
    const taskIds = await mapPool(Array.from({ length: taskCount }, (_, i) => i), async (i) => {
      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: `Concurrency test task ${i + 1}`,
          description: 'Test task for concurrency limits',
        }),
      });
      cleanup.trackTask(task.id);
      return task.id as string;
    });

    assert(taskIds.length === taskCount, `Created ${taskCount} tasks`);

    // Claim every task concurrently. This is the race the claim route's
    // per-account advisory lock exists for: concurrent claims must never push
    // the account past maxConcurrentWorkers. A refused claim surfaces either as
    // the 429 pre-check or as a 200 with no worker (cap hit under the lock).
    const outcomes = await mapPool(taskIds, async (taskId) => {
      try {
        const worker = await serverClaim(taskId);
        cleanupWorkerIds.push(worker.id);
        cleanup.trackWorker(worker.id);
        return worker.id as string;
      } catch (err: any) {
        if (
          err.message?.includes('Max concurrent workers limit reached') ||
          err.message?.includes('Claim returned no worker')
        ) {
          return null;
        }
        throw err;
      }
    });
    const claimedWorkerIds = outcomes.filter((id): id is string => id !== null);
    console.log(`  Claimed ${claimedWorkerIds.length}, refused ${outcomes.length - claimedWorkerIds.length} of ${taskCount}`);
    assert(claimedWorkerIds.length > 0, 'At least one claim succeeded');

    // availableSlots is a pre-flight snapshot. The test account is shared by every
    // integration run on the test machine, so another run can free a slot during
    // the claim loop — potentially more than once, if other runs' workers keep
    // completing while this loop is still going. Assert what the server actually
    // enforces: the account's total active workers never exceed its limit. The
    // cumulative claimedWorkerIds count is NOT a server invariant once concurrent
    // runs interfere (a prior fix asserted it <= maxConcurrent assuming at most one
    // extra claim could sneak in; that broke again when two did) — just log it.
    const { workers: activeAfter } = await api('/api/workers/mine?status=idle,running,starting,waiting_input');
    assert(
      activeAfter.length <= maxConcurrent,
      `Account active workers (${activeAfter.length}) <= maxConcurrentWorkers (${maxConcurrent})`
    );
    if (claimedWorkerIds.length > availableSlots) {
      console.log(`  Note: claimed ${claimedWorkerIds.length} > pre-flight ${availableSlots} free; a concurrent run released capacity mid-loop`);
    }
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

    // Create two tasks
    const task1 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Error test task 1',
        description: 'Task that will error',
      }),
    });
    const task2 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Error test task 2',
        description: 'Task to claim after error',
      }),
    });
    cleanup.trackTask(task1.id);
    cleanup.trackTask(task2.id);

    // Claim first task
    const worker1 = await serverClaim(task1.id);
    cleanupWorkerIds.push(worker1.id);
    cleanup.trackWorker(worker1.id);
    assert(!!worker1.id, 'Worker 1 claimed task 1');

    // Mark worker as failed
    await api(`/api/workers/${worker1.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        error: 'Agent stuck: made 5 identical calls',
      }),
    });

    // Wait a moment for capacity to update
    await sleep(500);

    // Verify capacity was released by claiming a new task
    const worker2 = await serverClaim(task2.id);
    cleanupWorkerIds.push(worker2.id);
    cleanup.trackWorker(worker2.id);
    assert(!!worker2.id, 'Worker 2 claimed task 2 (capacity released after error)');
  }, TIMEOUT);

  test('should handle multiple runner instances sharing capacity', async () => {
    console.log('\n=== Test: Multiple Local-UI Instances ===');

    // This test validates that capacity is tracked per-account, not per-instance
    // In practice, this would require multiple runner processes running

    // Get active runner instances
    const { activeLocalUis } = await api('/api/workers/active');

    if (activeLocalUis.length === 0) {
      console.log('  Skipping (no active runner instances)');
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
