/**
 * Dogfood Tests — Full E2E through buildd's own task coordination
 *
 * Creates real tasks on the server and waits for a connected worker
 * (local-ui or other runner) to claim and execute them. This is
 * "eating our own dogfood" — the system tests itself.
 *
 * Prerequisites:
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *   - local-ui running (claims tasks and runs Claude)
 *
 * Usage:
 *   bun test apps/web/tests/integration/dogfood.test.ts
 *
 * Env vars:
 *   BUILDD_API_KEY      - required (or config.json)
 *   BUILDD_SERVER       - defaults to local-ui's configured server
 *   LOCAL_UI_URL        - defaults to http://localhost:8766
 *   BUILDD_WORKSPACE_ID - optional, auto-picks first workspace
 *   DOGFOOD_TIMEOUT     - per-test timeout in ms (default: 300000 = 5 min)
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// --- Config ---

const LOCAL_UI = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TIMEOUT = Number(process.env.DOGFOOD_TIMEOUT) || 300_000; // 5 min per test
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
        // Retry on 5xx (transient server errors), fail immediately on 4xx
        if (res.status >= 500 && attempt < maxRetries) {
          lastError = new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
      }
      return body;
    } catch (err: any) {
      // Retry on network errors
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

async function getTaskStatus(taskId: string): Promise<any> {
  // Try individual endpoint first, fall back to list endpoint
  try {
    return await api(`/api/tasks/${taskId}`, { retries: 1 });
  } catch {
    // Fall back to finding it in the task list
    const { tasks } = await api('/api/tasks');
    const task = tasks?.find((t: any) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in task list`);
    return task;
  }
}

async function waitForWorkerCompletion(taskId: string): Promise<any> {
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    const task = await getTaskStatus(taskId);
    if (task.status === 'completed' || task.status === 'failed') {
      return { status: task.status, summary: task.result?.summary || '' };
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Task ${taskId} was not completed within ${TIMEOUT}ms`);
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

async function waitForWaiting(workerId: string, timeoutMs = 120_000): Promise<{ prompt: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getLocalWorkerStatus(workerId);
    if (status?.status === 'waiting' && status.waitingFor) {
      return { prompt: status.waitingFor.prompt };
    }
    if (status?.status === 'done' || status?.status === 'error') {
      throw new Error(`Worker ${workerId} finished (${status.status}) without asking a question`);
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Worker ${workerId} did not reach 'waiting' status within ${timeoutMs}ms`);
}

// --- Test suite ---

describe('dogfood', () => {
  let workspaceId: string;

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

    console.log(`Local-ui: ${LOCAL_UI} | Server: ${SERVER}`);

    workspaceId = await findWorkspace();

    // Clean up stale workers from previous runs to free concurrency slots
    try {
      const { workers: staleWorkers } = await api('/api/workers/mine?status=running,starting,waiting_input');
      if (staleWorkers?.length > 0) {
        console.log(`  Cleaning up ${staleWorkers.length} stale worker(s)...`);
        for (const w of staleWorkers) {
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

  test('heartbeat — server sees local-ui instance', async () => {
    const { activeLocalUis } = await api('/api/workers/active');
    expect(activeLocalUis?.length).toBeGreaterThan(0);

    // Log details for debugging
    const totalCapacity = (activeLocalUis || []).reduce((sum: number, ui: any) => sum + ui.capacity, 0);
    const totalActive = (activeLocalUis || []).reduce((sum: number, ui: any) => sum + ui.activeWorkers, 0);
    console.log(`  ${activeLocalUis.length} local-ui(s) — ${totalActive} active, ${totalCapacity} capacity`);
  }, 30_000);

  test('simple execution — agent echoes a marker', async () => {
    const marker = `DOGFOOD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Simple execution',
      `Reply with exactly: "${marker}". Nothing else -- just that string. Do not use any tools.`,
    );
    expect(task.id).toBeTruthy();

    const workerId = await triggerClaim(task.id);
    const result = await waitForWorkerCompletion(task.id);
    expect(result.status).toBe('completed');

    const output = await getLocalWorkerOutput(workerId);
    expect(output.join(' ')).toContain(marker);
  }, TIMEOUT);

  test('CLAUDE.md context — agent knows the tech stack', async () => {
    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Context test',
      'What is the primary tech stack used in this project? Reply in 10 words or fewer. Do not use any tools.',
    );
    expect(task.id).toBeTruthy();

    const workerId = await triggerClaim(task.id);
    const result = await waitForWorkerCompletion(task.id);
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

  test('abort handling — worker can be force-stopped', async () => {
    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Abort test',
      'Wait for further instructions before doing anything. Do not take any action yet.',
    );
    expect(task.id).toBeTruthy();

    const workerId = await triggerClaim(task.id);

    // Give the worker a moment to start
    await sleep(5_000);

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

  test('follow-up message — send instruction to completed worker', async () => {
    const marker = `FOLLOWUP_${Date.now()}`;

    // First: create a simple task and let it complete
    const task = await createTask(
      workspaceId,
      '[DOGFOOD] Follow-up test',
      'Reply with "INITIAL_DONE". Nothing else. Do not use any tools.',
    );
    expect(task.id).toBeTruthy();

    const workerId = await triggerClaim(task.id);
    const firstResult = await waitForWorkerCompletion(task.id);
    expect(firstResult.status).toBe('completed');

    // Now send a follow-up message to the completed worker
    // This triggers a new session with context from the previous run
    console.log('  Sending follow-up to completed worker...');
    const sendRes = await fetch(`${LOCAL_UI}/api/workers/${workerId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Reply with exactly: "${marker}". Nothing else. Do not use any tools.` }),
    });
    expect(sendRes.ok).toBe(true);

    // Wait for the follow-up session to complete
    // The worker restarts, so poll local-ui status directly
    const start = Date.now();
    while (Date.now() - start < TIMEOUT) {
      const status = await getLocalWorkerStatus(workerId);
      if (status?.status === 'done' || status?.status === 'error') break;
      await sleep(POLL_INTERVAL);
    }

    const output = await getLocalWorkerOutput(workerId);
    const outputText = output.join(' ');
    expect(outputText).toContain(marker);
  }, TIMEOUT);
});
