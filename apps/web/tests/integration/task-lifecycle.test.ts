/**
 * Integration Tests: Task Lifecycle
 *
 * Tests the complete task lifecycle from creation through execution to completion.
 * Creates real tasks on the server and validates that connected workers (local-ui)
 * claim and execute them correctly.
 *
 * Tests cover:
 *   - Heartbeat & discovery (server sees local-ui)
 *   - Direct claim flow (API-driven, used by external workers)
 *   - Dashboard dispatch flow (Pusher-driven, used by UI "Start Task")
 *   - Worker lifecycle (status transitions reflected on server)
 *   - Abort handling (force-stop running workers)
 *   - Follow-up messages (send to completed workers)
 *   - Concurrent worker limits (429 when at capacity)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *   - local-ui running with Pusher configured (claims tasks)
 *
 * Usage:
 *   bun run test:integration task-lifecycle
 *
 * Env vars:
 *   BUILDD_TEST_SERVER   - required (preview or local URL)
 *   BUILDD_API_KEY       - required (or config.json)
 *   LOCAL_UI_URL         - defaults to http://localhost:8766
 *   BUILDD_WORKSPACE_ID  - optional, auto-picks first workspace
 *   INTEGRATION_TEST_TIMEOUT - per-test timeout in ms (default: 300000 = 5 min)
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup, sleep } from '../../../../tests/test-utils';

// --- Config ---

const LOCAL_UI = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TIMEOUT = Number(process.env.INTEGRATION_TEST_TIMEOUT) || 300_000; // 5 min per test
const POLL_INTERVAL = 3_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);
const cleanup = createCleanup(api);

// --- Helpers ---

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

async function createTask(workspaceId: string, title: string, description: string): Promise<any> {
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, title, description }),
  });
  cleanup.trackTask(task.id);
  return task;
}

/** Claim a task via local-ui. Retries on 429 (capacity full from parallel tests). */
async function triggerClaim(taskId: string): Promise<string> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${LOCAL_UI}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    if (!res.ok) {
      const text = await res.text();
      // Local-ui wraps server 429 as a 400 error
      if (text.includes('429') && attempt < maxAttempts - 1) {
        await sleep(3_000 * (attempt + 1));
        continue;
      }
      throw new Error(`Local-ui claim failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    const workerId = data.worker?.id;
    if (!workerId) {
      throw new Error('Local-ui claim returned no worker ID');
    }
    console.log(`  Claimed -> worker ${workerId}`);
    cleanup.trackWorker(workerId);
    return workerId;
  }
  throw new Error('triggerClaim: unreachable');
}

async function getTaskStatus(taskId: string): Promise<any> {
  try {
    return await api(`/api/tasks/${taskId}`, { retries: 1 });
  } catch {
    const { tasks } = await api('/api/tasks');
    const task = tasks?.find((t: any) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in task list`);
    return task;
  }
}

async function waitForTaskTerminal(taskId: string, timeoutMs = TIMEOUT): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await getTaskStatus(taskId);
    if (task.status === 'completed' || task.status === 'failed') {
      return { status: task.status, summary: task.result?.summary || '' };
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Task ${taskId} was not completed within ${timeoutMs}ms`);
}

/** Wait for a task to leave 'pending' (claimed by a worker) */
async function waitForTaskClaimed(taskId: string, timeoutMs = 60_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await getTaskStatus(taskId);
    if (task.status !== 'pending') return task;
    await sleep(1_000);
  }
  throw new Error(`Task ${taskId} was not claimed within ${timeoutMs}ms`);
}

async function getLocalWorkerOutput(workerId: string): Promise<string[]> {
  const res = await fetch(`${LOCAL_UI}/api/workers`);
  if (!res.ok) throw new Error(`Failed to get workers from local-ui: ${res.status}`);
  const data = await res.json();
  const worker = data.workers?.find((w: any) => w.id === workerId);
  return worker?.output || [];
}

async function getLocalWorkerStatus(workerId: string): Promise<{ status: string; waitingFor?: any } | null> {
  try {
    const res = await fetch(`${LOCAL_UI}/api/workers`);
    if (!res.ok) return null;
    const data = await res.json();
    const worker = data.workers?.find((w: any) => w.id === workerId);
    if (!worker) return null;
    return { status: worker.status, waitingFor: worker.waitingFor };
  } catch {
    return null;
  }
}

/** Find a worker on local-ui by task ID */
async function findLocalWorkerByTask(taskId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LOCAL_UI}/api/workers`);
    if (!res.ok) return null;
    const data = await res.json();
    const worker = data.workers?.find((w: any) => w.taskId === taskId);
    return worker?.id || null;
  } catch {
    return null;
  }
}

async function cleanupStaleWorkers() {
  try {
    const { workers: stale } = await api('/api/workers/mine?status=running,starting,waiting_input');
    if (stale?.length > 0) {
      console.log(`  Cleaning up ${stale.length} stale worker(s)...`);
      for (const w of stale) {
        try {
          await api(`/api/workers/${w.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: 'Integration test cleanup (stale)' }),
          });
        } catch {}
      }
    }
  } catch (err: any) {
    console.log(`  Warning: could not clean stale workers (${err.message})`);
  }
}

// --- Test suite ---

describe('Task Lifecycle', () => {
  let workspaceId: string;

  beforeAll(async () => {
    // Verify local-ui is running and configured
    let localUiConfig: any;
    try {
      const healthRes = await fetch(`${LOCAL_UI}/api/config`);
      if (!healthRes.ok) throw new Error(`status ${healthRes.status}`);
      localUiConfig = await healthRes.json();
    } catch (err: any) {
      throw new Error(`local-ui not reachable at ${LOCAL_UI} (${err.message}). Start local-ui first.`);
    }

    if (!localUiConfig.configured) {
      throw new Error('local-ui is running but not configured (no API key)');
    }

    console.log(`Local-ui: ${LOCAL_UI} | Server: ${SERVER}`);

    workspaceId = await findWorkspace();
    await cleanupStaleWorkers();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  // ---------------------------------------------------------------
  // 1. Infrastructure tests — verify the plumbing works
  // ---------------------------------------------------------------

  test('heartbeat — server sees local-ui instance', async () => {
    const { activeLocalUis } = await api('/api/workers/active');
    expect(activeLocalUis?.length).toBeGreaterThan(0);

    const ui = activeLocalUis[0];
    expect(ui.capacity).toBeGreaterThan(0);
    expect(ui.workspaceIds).toContain(workspaceId);

    console.log(`  ${activeLocalUis.length} local-ui(s) — ${ui.activeWorkers} active, ${ui.capacity} capacity`);
  }, 30_000);

  test('workers/mine — lists account workers', async () => {
    // Should return an array (may be empty after cleanup)
    const { workers } = await api('/api/workers/mine');
    expect(Array.isArray(workers)).toBe(true);

    // With status filter
    const { workers: running } = await api('/api/workers/mine?status=running');
    expect(Array.isArray(running)).toBe(true);
  }, 15_000);

  // ---------------------------------------------------------------
  // 2. Direct claim flow — API-driven (external workers, local-ui /api/claim)
  // ---------------------------------------------------------------

  test('direct claim — agent echoes a marker', async () => {
    const marker = `DIRECT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task = await createTask(
      workspaceId,
      ' Direct claim',
      `Reply with exactly: "${marker}". Nothing else -- just that string. Do not use any tools.`,
    );
    expect(task.id).toBeTruthy();

    const workerId = await triggerClaim(task.id);
    const result = await waitForTaskTerminal(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId);
    expect(output.join(' ')).toContain(marker);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 3. Dashboard dispatch flow — Pusher-driven (same as "Start Task" button)
  // ---------------------------------------------------------------

  test('dashboard dispatch — start triggers Pusher claim', async () => {
    const marker = `DISPATCH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Create task — stays pending
    const task = await createTask(
      workspaceId,
      ' Dashboard dispatch',
      `Reply with exactly: "${marker}". Nothing else. Do not use any tools.`,
    );
    expect(task.status).toBe('pending');

    // Start via the dashboard API (sends Pusher TASK_ASSIGNED event)
    const startRes = await api(`/api/tasks/${task.id}/start`, {
      method: 'POST',
      body: JSON.stringify({ targetLocalUiUrl: LOCAL_UI }),
    });
    expect(startRes.started).toBe(true);
    console.log(`  Started task ${task.id} via dashboard dispatch`);

    // Wait for local-ui to receive Pusher event and claim it
    await waitForTaskClaimed(task.id);

    // Find the worker that local-ui created
    let workerId: string | null = null;
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      workerId = await findLocalWorkerByTask(task.id);
      if (workerId) break;
      await sleep(1_000);
    }
    expect(workerId).toBeTruthy();
    cleanup.trackWorker(workerId!);

    // Wait for completion
    const result = await waitForTaskTerminal(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId!);
    expect(output.join(' ')).toContain(marker);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 4. Worker lifecycle — status transitions reflected on server
  // ---------------------------------------------------------------

  test('worker lifecycle — status syncs to server', async () => {
    const task = await createTask(
      workspaceId,
      ' Lifecycle',
      'Reply with "LIFECYCLE_OK". Nothing else. Do not use any tools.',
    );
    const workerId = await triggerClaim(task.id);

    // Poll server-side worker status to verify it transitions
    let sawRunning = false;
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      try {
        const w = await api(`/api/workers/${workerId}`, { retries: 0 });
        if (w.status === 'running') sawRunning = true;
        if (w.status === 'completed' || w.status === 'failed') break;
      } catch {}
      await sleep(500);
    }

    expect(sawRunning).toBe(true);

    const finalWorker = await api(`/api/workers/${workerId}`);
    expect(finalWorker.status).toBe('completed');
    expect(finalWorker.completedAt).toBeTruthy();

    // Task status should match
    const taskStatus = await getTaskStatus(task.id);
    expect(taskStatus.status).toBe('completed');
    // Result snapshot should be populated
    expect(taskStatus.result).toBeTruthy();
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 5. CLAUDE.md context — agent has project context
  // ---------------------------------------------------------------

  test('CLAUDE.md context — agent knows the tech stack', async () => {
    const task = await createTask(
      workspaceId,
      ' Context test',
      'What is the primary tech stack used in this project? Reply in 10 words or fewer. Do not use any tools.',
    );

    const workerId = await triggerClaim(task.id);
    const result = await waitForTaskTerminal(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId);
    const outputText = output.join(' ').toLowerCase();
    const hasContext =
      outputText.includes('next') ||
      outputText.includes('drizzle') ||
      outputText.includes('postgres') ||
      outputText.includes('turborepo') ||
      outputText.includes('monorepo') ||
      outputText.includes('bun');

    expect(hasContext).toBe(true);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 6. Abort handling — force-stop running workers
  // ---------------------------------------------------------------

  test('abort handling — worker can be force-stopped', async () => {
    const task = await createTask(
      workspaceId,
      ' Abort test',
      'Read every file in packages/core/db/ one by one using the Read tool. For each file, write a detailed summary. Take your time and be thorough.',
    );

    const workerId = await triggerClaim(task.id);

    // Wait for the worker to actually start running before aborting
    const startWait = Date.now();
    while (Date.now() - startWait < 30_000) {
      const status = await getLocalWorkerStatus(workerId);
      if (status?.status === 'working') break;
      await sleep(500);
    }

    // Abort via local-ui
    const abortRes = await fetch(`${LOCAL_UI}/api/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId }),
    });
    expect(abortRes.ok).toBe(true);

    // Wait for task to reflect the failure
    const start = Date.now();
    let updatedTask: any;
    while (Date.now() - start < 15_000) {
      updatedTask = await getTaskStatus(task.id);
      if (updatedTask.status === 'failed' || updatedTask.status === 'pending') break;
      await sleep(1_000);
    }
    expect(['failed', 'pending']).toContain(updatedTask.status);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 7. Follow-up message — send instruction to completed worker
  // ---------------------------------------------------------------

  test('follow-up message — send to completed worker', async () => {
    const marker = `FOLLOWUP_${Date.now()}`;

    const task = await createTask(
      workspaceId,
      ' Follow-up test',
      'Reply with "INITIAL_DONE". Nothing else. Do not use any tools.',
    );

    const workerId = await triggerClaim(task.id);
    const firstResult = await waitForTaskTerminal(task.id);
    expect(firstResult.status).toBe('completed');

    console.log('  Sending follow-up to completed worker...');
    const sendRes = await fetch(`${LOCAL_UI}/api/workers/${workerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Reply with exactly: "${marker}". Nothing else. Do not use any tools.` }),
    });
    expect(sendRes.ok).toBe(true);

    // Wait for the follow-up session to complete
    const start = Date.now();
    while (Date.now() - start < TIMEOUT) {
      const status = await getLocalWorkerStatus(workerId);
      if (status?.status === 'done' || status?.status === 'error') break;
      await sleep(POLL_INTERVAL);
    }

    const output = await getLocalWorkerOutput(workerId);
    expect(output.join(' ')).toContain(marker);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 8. Concurrent worker limit — 429 when at capacity
  // ---------------------------------------------------------------

  test('concurrent limit — rejects claims beyond capacity', async () => {
    // Use account-level maxConcurrentWorkers (what the claim endpoint actually enforces)
    const account = await api('/api/accounts/me');
    const maxConcurrent = account.maxConcurrentWorkers || 3;

    // Clean up before filling slots
    await cleanupStaleWorkers();

    // Check how many workers are already active (other test files run in parallel)
    const { workers: currentActive } = await api('/api/workers/mine?status=running,starting,waiting_input');
    const alreadyActive = currentActive?.length || 0;
    const slotsToFill = maxConcurrent - alreadyActive;
    console.log(`  Max concurrent: ${maxConcurrent}, already active: ${alreadyActive}, filling: ${slotsToFill}`);

    if (slotsToFill <= 0) {
      // Already at capacity from parallel tests — just verify overflow is rejected
      const overflowTask = await createTask(
        workspaceId,
        ' Overflow',
        'Reply with "OVERFLOW". Do not use any tools.',
      );
      const { status, body } = await apiRaw(`/api/workers/claim`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          taskId: overflowTask.id,
          runner: 'integration-test',
        }),
      });
      expect(status).toBe(429);
      expect(body.error).toContain('Max concurrent workers');
      console.log(`  Correctly rejected: ${body.current}/${body.limit}`);
      return;
    }

    // Fill remaining slots with long-running tasks via local-ui
    const fillerWorkers: string[] = [];
    for (let i = 0; i < slotsToFill; i++) {
      const task = await createTask(
        workspaceId,
        ` Filler ${i}`,
        'Read every file in the root directory one by one using the Read tool. Write a detailed summary for each. Take your time.',
      );
      const workerId = await triggerClaim(task.id);
      fillerWorkers.push(workerId);
    }

    // Wait for all fillers to start running
    for (const wid of fillerWorkers) {
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const status = await getLocalWorkerStatus(wid);
        if (status?.status === 'working') break;
        await sleep(500);
      }
    }

    // Now try to claim one more — server should return 429
    const overflowTask = await createTask(
      workspaceId,
      ' Overflow',
      'Reply with "OVERFLOW". Do not use any tools.',
    );

    const { status, body } = await apiRaw(`/api/workers/claim`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        taskId: overflowTask.id,
        runner: 'integration-test',
      }),
    });

    expect(status).toBe(429);
    expect(body.error).toContain('Max concurrent workers');
    console.log(`  Correctly rejected: ${body.current}/${body.limit}`);

    // Clean up fillers
    for (const wid of fillerWorkers) {
      try {
        await fetch(`${LOCAL_UI}/api/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerId: wid }),
        });
      } catch {}
    }
    await sleep(3_000);
  }, TIMEOUT);
});
