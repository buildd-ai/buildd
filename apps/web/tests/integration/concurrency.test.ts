/**
 * Integration Tests: Concurrency Control
 *
 * Tests worker capacity limits, concurrent claims, and race conditions.
 * Validates that buildd correctly enforces maxConcurrentWorkers limits
 * and prevents multiple workers from claiming the same task.
 *
 * Prerequisites:
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *   - Test server running (defaults to https://app.buildd.dev)
 *
 * Usage:
 *   bun test apps/web/tests/integration/concurrency.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// --- Config ---

const SERVER = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const TIMEOUT = 30_000; // 30 seconds per test

// Resolve API key: env var > config.json
function getApiKey(): string | undefined {
  if (process.env.BUILDD_API_KEY) return process.env.BUILDD_API_KEY;
  try {
    const configPath = join(process.env.HOME || '~', '.buildd', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.apiKey;
  } catch {
    return undefined;
  }
}

const API_KEY = getApiKey();

if (!API_KEY) {
  console.log('⏭️  Skipping concurrency tests: no API key found');
  process.exit(0);
}

// --- Helpers ---

async function api(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`API ${options.method || 'GET'} ${endpoint} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- Tests ---

describe('Concurrency Control', () => {
  let workspaceId: string;
  const cleanupWorkerIds: string[] = [];
  const cleanupTaskIds: string[] = [];

  // Setup: Get/create workspace
  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaceId}`);
  });

  // Cleanup after each test
  afterEach(async () => {
    // Clean up workers
    for (const workerId of cleanupWorkerIds) {
      try {
        await api(`/api/workers/${workerId}`, { method: 'DELETE' });
      } catch (err) {
        console.warn(`Failed to cleanup worker ${workerId}:`, err);
      }
    }
    cleanupWorkerIds.length = 0;

    // Clean up tasks
    for (const taskId of cleanupTaskIds) {
      try {
        await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
      } catch (err) {
        console.warn(`Failed to cleanup task ${taskId}:`, err);
      }
    }
    cleanupTaskIds.length = 0;
  });

  test('should enforce maxConcurrentWorkers limit', async () => {
    console.log('\n=== Test: Max Concurrent Workers ===');

    // Get account info (maxConcurrentWorkers)
    const { account } = await api('/api/account');
    const maxConcurrent = account.maxConcurrentWorkers || 5;
    console.log(`  Account max concurrent: ${maxConcurrent}`);

    // Create tasks (more than limit)
    const taskCount = maxConcurrent + 2;
    const taskIds: string[] = [];

    for (let i = 0; i < taskCount; i++) {
      const { task } = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          title: `Concurrency test task ${i + 1}`,
          description: 'Test task for concurrency limits',
          priority: 'normal',
        }),
      });
      taskIds.push(task.id);
      cleanupTaskIds.push(task.id);
    }

    assert(taskIds.length === taskCount, `Created ${taskCount} tasks`);

    // Try to claim all tasks (should only succeed up to maxConcurrent)
    const claimedWorkerIds: string[] = [];

    for (const taskId of taskIds) {
      try {
        const { worker } = await api('/api/workers/claim', {
          method: 'POST',
          body: JSON.stringify({ taskId }),
        });
        claimedWorkerIds.push(worker.id);
        cleanupWorkerIds.push(worker.id);
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
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Race condition test task',
        description: 'Only one worker should claim this',
        priority: 'normal',
      }),
    });
    cleanupTaskIds.push(task.id);

    // Try to claim the same task concurrently (simulate race)
    const claimPromises = Array.from({ length: 3 }, () =>
      api('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ taskId: task.id }),
      }).catch(err => ({ error: err.message }))
    );

    const results = await Promise.all(claimPromises);

    // Count successful claims
    const successfulClaims = results.filter(r => !('error' in r));
    const failedClaims = results.filter(r => 'error' in r);

    assert(successfulClaims.length === 1, 'Exactly one worker claimed the task');
    assert(failedClaims.length === 2, 'Two claims were rejected');

    // Track successful worker for cleanup
    if (successfulClaims.length > 0) {
      cleanupWorkerIds.push((successfulClaims[0] as any).worker.id);
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
        priority: 'normal',
      }),
    });
    const task2 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Capacity test task 2',
        description: 'Second task',
        priority: 'normal',
      }),
    });
    cleanupTaskIds.push(task1.task.id, task2.task.id);

    // Claim first task
    const { worker: worker1 } = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ taskId: task1.task.id }),
    });
    cleanupWorkerIds.push(worker1.id);
    assert(worker1.status === 'working', 'Worker 1 claimed task 1');

    // Mark worker 1 as done
    await api(`/api/workers/${worker1.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });

    // Wait a moment for capacity to update
    await sleep(500);

    // Should now be able to claim second task (capacity released)
    const { worker: worker2 } = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ taskId: task2.task.id }),
    });
    cleanupWorkerIds.push(worker2.id);
    assert(worker2.status === 'working', 'Worker 2 claimed task 2 (capacity released)');
  }, TIMEOUT);

  test('should release capacity when worker errors', async () => {
    console.log('\n=== Test: Capacity Release on Error ===');

    // Create task
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Error test task',
        description: 'Task that will error',
        priority: 'normal',
      }),
    });
    cleanupTaskIds.push(task.id);

    // Claim task
    const { worker } = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ taskId: task.id }),
    });
    cleanupWorkerIds.push(worker.id);

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
      console.log('  ⏭️  Skipping (no active local-ui instances)');
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
