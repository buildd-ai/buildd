/**
 * Dogfood Tests — Full E2E through buildd's own task coordination
 *
 * Creates real tasks on the server and waits for a connected worker
 * (local-ui or other runner) to claim and execute them. This is
 * "eating our own dogfood" — the system tests itself.
 *
 * Tests cover:
 *   - Heartbeat & discovery (server sees local-ui)
 *   - Direct claim flow (API-driven, used by external workers)
 *   - Dashboard dispatch flow (Pusher-driven, used by UI "Start Task")
 *   - Worker lifecycle (status transitions reflected on server)
 *   - Abort handling (force-stop running workers)
 *   - Follow-up messages (send to completed workers)
 *   - Concurrent worker limits (429 when at capacity)
 *   - Observations CRUD (create, list, search, compact, batch)
 *   - Task reassignment (pending re-broadcast, assigned rejection)
 *   - Plan approval (submit plan, verify state, approve)
 *   - Stale cleanup (maintenance endpoint smoke test)
 *   - Waiting input (question/answer cycle with live worker)
 *
 * Prerequisites:
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *   - local-ui running (claims tasks and runs Claude)
 *
 * Usage:
 *   bun test apps/web/tests/integration/dogfood.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// --- Config ---

const LOCAL_UI = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TIMEOUT = Number(process.env.DOGFOOD_TIMEOUT) || 300_000;
const POLL_INTERVAL = 3_000;

function getFileConfig(): { apiKey?: string; builddServer?: string } {
  try {
    const configPath = join(process.env.HOME || '~', '.buildd', 'config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

const fileConfig = getFileConfig();
const API_KEY = process.env.BUILDD_API_KEY || fileConfig.apiKey;
let SERVER = process.env.BUILDD_SERVER || fileConfig.builddServer || 'https://app.buildd.dev';

// --- Tracking for cleanup ---

const cleanupWorkerIds: string[] = [];
const cleanupTaskIds: string[] = [];

// --- API helpers ---

async function api(endpoint: string, options: RequestInit & { retries?: number } = {}) {
  const maxRetries = options.retries ?? 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
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
        if (res.status >= 500 && attempt < maxRetries) {
          lastError = new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
      }
      return body;
    } catch (err: any) {
      if (attempt < maxRetries && (err instanceof TypeError || err.message?.includes('fetch failed'))) {
        lastError = err;
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error(`API ${endpoint} failed after ${maxRetries} retries`);
}

/** api() variant that returns { status, body } instead of throwing on non-2xx */
async function apiRaw(endpoint: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
  return { status: res.status, body: await res.json() };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
  cleanupTaskIds.push(task.id);
  return task;
}

async function triggerClaim(taskId: string): Promise<string> {
  const res = await fetch(`${LOCAL_UI}/api/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  if (!res.ok) {
    throw new Error(`Local-ui claim failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const workerId = data.worker?.id;
  if (!workerId) {
    throw new Error('Local-ui claim returned no worker ID');
  }
  console.log(`  Claimed -> worker ${workerId}`);
  cleanupWorkerIds.push(workerId);
  return workerId;
}

/** Claim a task directly on the server (creates a DB worker, no local-ui) */
async function serverClaim(workspaceId: string, taskId: string): Promise<string> {
  const res = await api('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, taskId, runner: 'dogfood-test' }),
  });
  const worker = res.workers?.[0];
  if (!worker) throw new Error(`Server claim returned no worker for task ${taskId}`);
  cleanupWorkerIds.push(worker.id);
  return worker.id;
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
    const { workers: stale } = await api('/api/workers/mine?status=running,starting,waiting_input,idle');
    if (stale?.length > 0) {
      console.log(`  Cleaning up ${stale.length} stale worker(s)...`);
      for (const w of stale) {
        try {
          await api(`/api/workers/${w.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: 'Dogfood test cleanup (stale)' }),
          });
        } catch {}
      }
    }
  } catch (err: any) {
    console.log(`  Warning: could not clean stale workers (${err.message})`);
  }
}

// --- Test suite ---

describe('dogfood', () => {
  let workspaceId: string;
  let hasPusher = false;

  beforeAll(async () => {
    if (!API_KEY) {
      throw new Error('No API key found (set BUILDD_API_KEY or ~/.buildd/config.json)');
    }

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

    // Use local-ui's server URL if we didn't get one from env
    if (!process.env.BUILDD_SERVER && localUiConfig.builddServer) {
      SERVER = localUiConfig.builddServer;
    }

    // Check if Pusher is configured (needed for dashboard dispatch test)
    // Local-ui needs pusherKey to receive task assignment events
    const localConfig = getFileConfig() as any;
    hasPusher = !!(
      process.env.PUSHER_KEY ||
      process.env.NEXT_PUBLIC_PUSHER_KEY ||
      localConfig.pusherKey
    );

    console.log(`Local-ui: ${LOCAL_UI} | Server: ${SERVER} | Pusher: ${hasPusher ? 'yes' : 'no'}`);

    workspaceId = await findWorkspace();
    await cleanupStaleWorkers();
  }, TIMEOUT);

  afterAll(async () => {
    console.log('Cleanup...');
    for (const wid of cleanupWorkerIds) {
      try {
        await api(`/api/workers/${wid}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: 'Dogfood test cleanup' }),
        });
      } catch {}
    }
    for (const tid of cleanupTaskIds) {
      try {
        await api(`/api/tasks/${tid}`, { method: 'DELETE' });
      } catch {}
    }
  });

  // ---------------------------------------------------------------
  // 1. Infrastructure — verify the plumbing works
  // ---------------------------------------------------------------

  test('heartbeat — server sees local-ui instance', async () => {
    // Heartbeat fires every 30s — retry to account for timing
    let activeLocalUis: any[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await api('/api/workers/active');
      activeLocalUis = res.activeLocalUis || [];
      if (activeLocalUis.length > 0) break;
      await sleep(5_000);
    }

    expect(activeLocalUis.length).toBeGreaterThan(0);

    const ui = activeLocalUis[0];
    expect(ui.workspaceIds).toContain(workspaceId);
    console.log(`  ${activeLocalUis.length} local-ui(s) — ${ui.activeWorkers} active, ${ui.capacity} capacity`);
  }, 90_000);

  test('workers/mine — lists account workers', async () => {
    const { workers } = await api('/api/workers/mine');
    expect(Array.isArray(workers)).toBe(true);

    const { workers: running } = await api('/api/workers/mine?status=running');
    expect(Array.isArray(running)).toBe(true);
  }, 15_000);

  // ---------------------------------------------------------------
  // 2. Direct claim flow — API-driven
  // ---------------------------------------------------------------

  test('direct claim — agent echoes a marker', async () => {
    const marker = `DIRECT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Direct claim',
      `Reply with exactly: "${marker}". Nothing else -- just that string. Do not use any tools.`,
    );

    const workerId = await triggerClaim(task.id);
    const result = await waitForTaskTerminal(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId);
    expect(output.join(' ')).toContain(marker);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 3. Dashboard dispatch — Pusher-driven (same as "Start Task" button)
  // ---------------------------------------------------------------

  test('dashboard dispatch — start triggers Pusher claim', async () => {
    if (!hasPusher) {
      console.log('  SKIP: Pusher not configured on local-ui');
      return;
    }

    const marker = `DISPATCH_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Dashboard dispatch',
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
    cleanupWorkerIds.push(workerId!);

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
      '[DOGFOOD] Lifecycle',
      'Write a 50-word paragraph about why TypeScript is useful for large codebases. Do not use any tools.',
    );
    const workerId = await triggerClaim(task.id);

    // Poll local-ui for status transitions
    let sawWorking = false;
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const local = await getLocalWorkerStatus(workerId);
      if (local?.status === 'working') sawWorking = true;
      if (local?.status === 'done' || local?.status === 'error') break;
      await sleep(200);
    }

    // Verify task completed on server (task status is updated when worker completes)
    const taskStatus = await getTaskStatus(task.id);
    expect(taskStatus.status).toBe('completed');
    expect(taskStatus.result).toBeTruthy();

    console.log(`  sawWorking: ${sawWorking}`);
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // 5. CLAUDE.md context — agent has project context
  // ---------------------------------------------------------------

  test('CLAUDE.md context — agent knows the tech stack', async () => {
    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Context test',
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
      '[DOGFOOD] Abort test',
      'Read every file in packages/core/db/ one by one using the Read tool. For each file, write a detailed summary. Take your time and be thorough.',
    );

    const workerId = await triggerClaim(task.id);

    // Wait for the worker to actually start running
    const startWait = Date.now();
    while (Date.now() - startWait < 30_000) {
      const status = await getLocalWorkerStatus(workerId);
      if (status?.status === 'working') break;
      await sleep(500);
    }

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
      '[DOGFOOD] Follow-up test',
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
    await cleanupStaleWorkers();

    const { activeLocalUis } = await api('/api/workers/active');
    const maxConcurrent = activeLocalUis?.[0]?.maxConcurrent || 3;
    console.log(`  Max concurrent: ${maxConcurrent}`);

    // Create server-side workers directly (not through local-ui)
    // These stay "running" because nothing will complete them
    const fillerWorkers: string[] = [];
    for (let i = 0; i < maxConcurrent; i++) {
      const task = await createTask(workspaceId, `[DOGFOOD] Filler ${i}`, 'Filler task');
      const workerId = await serverClaim(workspaceId, task.id);
      // Transition to running so they count against the limit
      await api(`/api/workers/${workerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'running' }),
      });
      fillerWorkers.push(workerId);
    }

    // Now try to claim one more — server should return 429
    const overflowTask = await createTask(workspaceId, '[DOGFOOD] Overflow', 'Should be rejected');

    const { status, body } = await apiRaw('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, taskId: overflowTask.id, runner: 'dogfood-test' }),
    });

    expect(status).toBe(429);
    expect(body.error).toContain('Max concurrent workers');
    console.log(`  Correctly rejected: ${body.current}/${body.limit}`);

    // Clean up: fail all filler workers
    for (const wid of fillerWorkers) {
      try {
        await api(`/api/workers/${wid}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: 'Dogfood test cleanup' }),
        });
      } catch {}
    }
  }, 60_000);

  // ---------------------------------------------------------------
  // 9. Observations — CRUD and search
  // ---------------------------------------------------------------

  test('observations — create, list, search, compact, batch', async () => {
    const marker = `OBS_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // Create observation
    const { observation } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: `${marker} Test Discovery`,
        content: `Integration test observation created by dogfood tests: ${marker}`,
        files: ['tests/integration/dogfood.test.ts'],
        concepts: ['testing', 'dogfood'],
      }),
    });
    expect(observation.id).toBeTruthy();
    expect(observation.type).toBe('discovery');

    // List with type filter
    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?type=discovery&limit=50`
    );
    expect(observations.some((o: any) => o.id === observation.id)).toBe(true);

    // Search by marker
    const { results } = await api(
      `/api/workspaces/${workspaceId}/observations/search?query=${encodeURIComponent(marker)}`
    );
    expect(results.some((r: any) => r.id === observation.id)).toBe(true);

    // Compact digest
    const { markdown, count } = await api(
      `/api/workspaces/${workspaceId}/observations/compact`
    );
    expect(count).toBeGreaterThan(0);
    expect(markdown).toContain(marker);

    // Batch get
    const { observations: batch } = await api(
      `/api/workspaces/${workspaceId}/observations/batch?ids=${observation.id}`
    );
    expect(batch.length).toBe(1);
    expect(batch[0].id).toBe(observation.id);

    // Cleanup: delete test observation
    try {
      await api(`/api/workspaces/${workspaceId}/observations/${observation.id}`, {
        method: 'DELETE',
      });
    } catch {}
  }, 30_000);

  // ---------------------------------------------------------------
  // 10. Task reassignment — reset and re-claim
  // ---------------------------------------------------------------

  test('task reassignment — pending re-broadcast and assigned rejection', async () => {
    // Test A: Reassign a pending task (no force needed, just re-broadcasts)
    const task = await createTask(workspaceId, '[DOGFOOD] Reassign test', 'Placeholder for reassign');

    const reassignPending = await api(`/api/tasks/${task.id}/reassign`, {
      method: 'POST',
    });
    expect(reassignPending.reassigned).toBe(true);

    // Task should still be pending
    let taskStatus = await getTaskStatus(task.id);
    expect(taskStatus.status).toBe('pending');

    // Test B: Claim the task, then try to reassign without force
    const workerId = await serverClaim(workspaceId, task.id);
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running' }),
    });

    taskStatus = await getTaskStatus(task.id);
    expect(taskStatus.status).toBe('assigned');

    // Reassign without force → should return reassigned: false
    const { status: noForceStatus, body: noForceBody } = await apiRaw(`/api/tasks/${task.id}/reassign`, {
      method: 'POST',
    });
    expect(noForceBody.reassigned).toBe(false);
    expect(noForceBody.reason).toContain('force=true');

    // Test C: Reassign with force but non-owner, non-stale → should be 403
    const { status: forceStatus, body: forceBody } = await apiRaw(`/api/tasks/${task.id}/reassign?force=true`, {
      method: 'POST',
    });
    expect(forceStatus).toBe(403);
    expect(forceBody.reassigned).toBe(false);

    // Cleanup
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', error: 'Dogfood test cleanup' }),
    });
  }, 30_000);

  // ---------------------------------------------------------------
  // 11. Plan approval — submit and approve via API
  // ---------------------------------------------------------------

  test('plan approval — submit plan, verify state, approve', async () => {
    const task = await createTask(workspaceId, '[DOGFOOD] Plan test', 'Plan: improve error handling');
    const workerId = await serverClaim(workspaceId, task.id);

    // Set worker to running
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running' }),
    });

    // Submit plan
    const planContent = '## Plan\n\n1. Add error boundaries\n2. Implement retry logic\n3. Add logging';
    const planRes = await api(`/api/workers/${workerId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: planContent }),
    });
    expect(planRes.message).toContain('Plan submitted');

    // Verify worker is awaiting approval
    const { body: workerAfterPlan } = await apiRaw(`/api/workers/${workerId}`);
    expect(workerAfterPlan.status).toBe('awaiting_plan_approval');

    // Get plan
    const { plan: retrievedPlan } = await api(`/api/workers/${workerId}/plan`);
    expect(retrievedPlan).toBeTruthy();
    expect(retrievedPlan.content).toContain('error boundaries');

    // Approve plan
    const approveRes = await api(`/api/workers/${workerId}/plan/approve`, {
      method: 'POST',
    });
    expect(approveRes.worker.status).toBe('running');

    // Verify worker is back to running with pending instructions
    const { body: workerAfterApprove } = await apiRaw(`/api/workers/${workerId}`);
    expect(workerAfterApprove.status).toBe('running');
    expect(workerAfterApprove.pendingInstructions).toContain('APPROVED');

    // Cleanup
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', error: 'Dogfood test cleanup' }),
    });
  }, 30_000);

  // ---------------------------------------------------------------
  // 12. Stale cleanup — maintenance endpoint smoke test
  // ---------------------------------------------------------------

  test('stale cleanup — cleanup endpoint returns correct structure', async () => {
    const { status, body } = await apiRaw('/api/tasks/cleanup', {
      method: 'POST',
    });

    if (status === 200) {
      // Admin auth accepted — verify response structure
      expect(typeof body.cleaned.stalledWorkers).toBe('number');
      expect(typeof body.cleaned.orphanedTasks).toBe('number');
      expect(typeof body.cleaned.expiredPlans).toBe('number');
      expect(typeof body.cleaned.staleHeartbeats).toBe('number');
    } else {
      // Non-admin API key → auth error (expected)
      expect(status).toBe(401);
      console.log(`  Cleanup requires admin auth (got ${status}) — expected for non-admin key`);
    }
  }, 15_000);

  // ---------------------------------------------------------------
  // 13. Waiting input — question/answer cycle with live worker
  // ---------------------------------------------------------------

  test('waiting input — worker asks question, receives answer', async () => {
    const marker = `INPUT_${Date.now()}`;

    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Waiting input test',
      [
        'You must ask the user a clarification question before doing anything else.',
        'Use the AskUserQuestion tool to ask: "What output format?" with options "JSON" and "YAML".',
        `After they respond, reply with exactly "CHOSEN_${marker}: [their answer]".`,
        'Do not use any other tools. Do not skip the question.',
      ].join(' '),
    );

    const workerId = await triggerClaim(task.id);

    // Wait for worker to enter waiting state
    let waitingFor: any = null;
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      const local = await getLocalWorkerStatus(workerId);
      if (local?.waitingFor) {
        waitingFor = local.waitingFor;
        break;
      }
      // If worker finished without asking, break early
      if (local?.status === 'done' || local?.status === 'error') break;
      await sleep(1_000);
    }

    if (!waitingFor) {
      // Agent didn't trigger AskUserQuestion — graceful skip
      console.log('  SKIP: Agent did not ask a question (AskUserQuestion not triggered)');
      return;
    }

    console.log(`  Worker waiting: ${JSON.stringify(waitingFor).slice(0, 100)}`);

    // Wait a sync cycle so server reflects waiting_input
    await sleep(12_000);
    const { body: serverWorker } = await apiRaw(`/api/workers/${workerId}`);
    expect(serverWorker.status).toBe('waiting_input');
    expect(serverWorker.waitingFor).toBeTruthy();

    // Send answer via local-ui
    const sendRes = await fetch(`${LOCAL_UI}/api/workers/${workerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'JSON' }),
    });
    expect(sendRes.ok).toBe(true);

    // Wait for completion
    const result = await waitForTaskTerminal(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId);
    expect(output.join(' ')).toContain(`CHOSEN_${marker}`);
  }, TIMEOUT);
});
