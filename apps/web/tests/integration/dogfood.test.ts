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
 *   BUILDD_API_KEY=bld_xxx bun run test:dogfood
 *   # or reads from .env / config.json automatically
 *
 * Env vars:
 *   BUILDD_API_KEY      - required (or config.json)
 *   BUILDD_SERVER       - defaults to https://app.buildd.dev
 *   LOCAL_UI_URL        - defaults to http://localhost:8766
 *   BUILDD_WORKSPACE_ID - optional, auto-picks first workspace
 *   DOGFOOD_TIMEOUT     - per-test timeout in ms (default: 300000 = 5 min)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// --- Config ---

const SERVER = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const LOCAL_UI = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TIMEOUT = Number(process.env.DOGFOOD_TIMEOUT) || 300_000; // 5 min per test
const POLL_INTERVAL = 3_000; // 3 seconds between polls

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
  console.log('⏭️  Skipping dogfood tests: no API key found (set BUILDD_API_KEY or ~/.buildd/config.json)');
  process.exit(0);
}

// --- Tracking for cleanup ---

const cleanupWorkerIds: string[] = [];
const cleanupTaskIds: string[] = [];

// --- API helpers ---

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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- Pre-flight: check for live workers ---

const { activeLocalUis } = await api('/api/workers/active');
const totalCapacity = (activeLocalUis || []).reduce((sum: number, ui: any) => sum + ui.capacity, 0);
const totalActive = (activeLocalUis || []).reduce((sum: number, ui: any) => sum + ui.activeWorkers, 0);

if (!activeLocalUis?.length) {
  console.log('⏭️  Skipping dogfood tests: no live workers found. Start local-ui first.');
  process.exit(0);
}

console.log(`🟢 ${activeLocalUis.length} local-ui instance(s) alive — ${totalActive} active workers, ${totalCapacity} capacity remaining`);

// --- Helpers ---

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  // Prefer buildd workspace
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

/**
 * Trigger a claim via local-ui and return the worker ID.
 * Falls back to polling if local-ui isn't reachable.
 */
async function triggerClaim(taskId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LOCAL_UI}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    if (res.ok) {
      const data = await res.json();
      const workerId = data.worker?.id;
      if (workerId) {
        console.log(`  Claimed via local-ui → worker ${workerId}`);
        cleanupWorkerIds.push(workerId);
        return workerId;
      }
    }
    console.log(`  Local-ui claim returned ${res.status}`);
  } catch {
    console.log(`  Local-ui not reachable at ${LOCAL_UI}`);
  }
  return null;
}

/**
 * Wait for a worker to complete by polling the task status endpoint.
 * We always poll via task (not worker) because the worker may belong to
 * a different account (local-ui's API key) than the dogfood test's API key.
 */
async function waitForWorkerCompletion(taskId: string, _workerId?: string | null): Promise<any> {
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    const task = await api(`/api/tasks/${taskId}`);
    if (task.status === 'completed' || task.status === 'failed') {
      return { status: task.status, summary: task.result?.summary || '' };
    }

    await sleep(POLL_INTERVAL);
  }

  throw new Error(`Task ${taskId} was not completed within ${TIMEOUT}ms`);
}

/**
 * Get worker output from local-ui (where agent text is stored).
 */
async function getLocalWorkerOutput(workerId: string): Promise<string[]> {
  try {
    const res = await fetch(`${LOCAL_UI}/api/workers`);
    if (res.ok) {
      const data = await res.json();
      const worker = data.workers?.find((w: any) => w.id === workerId);
      return worker?.output || [];
    }
  } catch {}
  return [];
}

/**
 * Wait for a task to be claimed (worker created) by polling the task status.
 * Returns the worker ID once claimed.
 */
async function waitForClaim(taskId: string, knownWorkerId?: string | null): Promise<string> {
  if (knownWorkerId) return knownWorkerId;

  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    const task = await api(`/api/tasks/${taskId}`);
    // Task moves from 'pending' to 'assigned' when claimed
    if (task.status !== 'pending' && task.claimedBy) {
      // Find the worker via the task's workers (if endpoint supports it) or via status
      if (task.workers?.length) {
        const wid = task.workers[0].id;
        cleanupWorkerIds.push(wid);
        return wid;
      }
      // Can't get worker ID from task alone — return empty and poll by task
      return '';
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Task ${taskId} was not claimed within ${TIMEOUT}ms`);
}

async function cleanup() {
  console.log('\nCleanup...');
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
  console.log('  Done.\n');
}

// --- Test cases ---

async function testSimpleExecution(workspaceId: string) {
  console.log('\n═══ Test 1: Simple execution ═══');
  const marker = `DOGFOOD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  console.log('  Creating task...');
  const task = await createTask(
    workspaceId,
    '[DOGFOOD] Simple execution',
    `Reply with exactly: "${marker}". Nothing else — just that string.`,
  );
  assert(!!task.id, `Task created: ${task.id}`);

  const workerId = await triggerClaim(task.id);

  console.log('  Waiting for worker to complete...');
  const worker = await waitForWorkerCompletion(task.id, workerId);

  assert(worker.status === 'completed', `Worker completed (status: ${worker.status})`);

  // Check agent output from local-ui (server doesn't store text output)
  if (workerId) {
    const output = await getLocalWorkerOutput(workerId);
    const outputText = output.join(' ');
    assert(outputText.includes(marker), `Output contains marker "${marker}"`);
  }
}

async function testClaudemdContext(workspaceId: string) {
  console.log('\n═══ Test 2: CLAUDE.md context loading ═══');

  console.log('  Creating task...');
  const task = await createTask(
    workspaceId,
    '[DOGFOOD] Context test',
    'What is the primary tech stack used in this project? Reply in 10 words or fewer.',
  );
  assert(!!task.id, `Task created: ${task.id}`);

  const workerId = await triggerClaim(task.id);

  console.log('  Waiting for worker to complete...');
  const worker = await waitForWorkerCompletion(task.id, workerId);

  assert(worker.status === 'completed', `Worker completed (status: ${worker.status})`);

  // Check agent output from local-ui for context awareness
  if (workerId) {
    const output = await getLocalWorkerOutput(workerId);
    const outputText = output.join(' ').toLowerCase();
    const hasContext =
      outputText.includes('next') ||
      outputText.includes('drizzle') ||
      outputText.includes('postgres') ||
      outputText.includes('turborepo') ||
      outputText.includes('monorepo') ||
      outputText.includes('bun');

    assert(hasContext, 'Output references project stack (Next.js, Drizzle, etc)');
  }
}

async function testFailHandling(workspaceId: string) {
  console.log('\n═══ Test 3: Fail handling ═══');

  console.log('  Creating task...');
  const task = await createTask(
    workspaceId,
    '[DOGFOOD] Fail test',
    'Count from 1 to 1000 slowly, one number per line.',
  );
  assert(!!task.id, `Task created: ${task.id}`);

  const workerId = await triggerClaim(task.id);

  // Wait for worker to be claimed
  console.log('  Waiting for worker to claim...');
  const confirmedWorkerId = await waitForClaim(task.id, workerId);
  assert(!!confirmedWorkerId, `Worker claimed the task: ${confirmedWorkerId}`);

  // Force-fail via local-ui's abort endpoint (avoids 403 from cross-account worker ownership)
  console.log('  Aborting worker via local-ui...');
  const abortRes = await fetch(`${LOCAL_UI}/api/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: confirmedWorkerId }),
  });
  assert(abortRes.ok, `Abort request succeeded (status: ${abortRes.status})`);

  // Wait for task to reflect the failure
  console.log('  Waiting for task status to update...');
  const start = Date.now();
  let updatedTask: any;
  while (Date.now() - start < 15_000) {
    updatedTask = await api(`/api/tasks/${task.id}`);
    if (updatedTask.status === 'failed' || updatedTask.status === 'pending') break;
    await sleep(1_000);
  }
  assert(
    updatedTask.status === 'failed' || updatedTask.status === 'pending',
    `Task status updated: ${updatedTask.status}`,
  );
}

// --- Main ---

async function run() {
  console.log(`\n🐕 Dogfood Tests — testing buildd through buildd`);
  console.log(`  Server: ${SERVER}`);
  console.log(`  Local UI: ${LOCAL_UI}`);
  console.log(`  Timeout: ${TIMEOUT / 1000}s per test\n`);

  const workspaceId = await findWorkspace();

  await testSimpleExecution(workspaceId);
  await testClaudemdContext(workspaceId);
  await testFailHandling(workspaceId);

  console.log('\n✅ All dogfood tests passed!\n');
}

run()
  .catch((err) => {
    console.error(`\n❌ Dogfood test failed: ${err.message}\n`);
    process.exit(1);
  })
  .finally(cleanup);
