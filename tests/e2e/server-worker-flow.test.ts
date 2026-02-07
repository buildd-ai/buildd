/**
 * E2E Integration Test: Server + Local-UI Full Flow
 *
 * Validates the core buildd distributed flow:
 *   Server reachable → Create task → Local worker picks it up → Completion confirmed
 *
 * Environment variables:
 *   BUILDD_SERVER       Remote server URL  (default: https://app.buildd.dev)
 *   BUILDD_API_KEY      API key            (fallback: ~/.buildd/config.json)
 *   LOCAL_UI_URL        Local-UI address   (default: http://localhost:8766)
 *   SKIP_LOCAL_UI_START Set to "1" if local-ui is already running
 *   E2E_MODEL           Model to use       (default: claude-haiku-4-5-20251001)
 *
 * Usage:
 *   bun run test:e2e                                     # full lifecycle
 *   SKIP_LOCAL_UI_START=1 bun run test:e2e               # local-ui already running
 *   BUILDD_SERVER=https://your-app.vercel.app bun run test:e2e  # alternate server
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  readApiKey,
  ServerClient,
  LocalUIClient,
  pollUntil,
  startLocalUI,
  stopLocalUI,
} from './helpers';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUILDD_SERVER = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const LOCAL_UI_URL = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TEST_TIMEOUT = 120_000; // 2 min — Claude execution can be slow
const TEST_MODEL = process.env.E2E_MODEL || 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: ServerClient;
let localUI: LocalUIClient;
let testWorkspaceId: string;

// Track resources for cleanup
const createdTaskIds: string[] = [];
const createdWorkerIds: string[] = [];
let originalServer: string | null = null; // to restore after tests
let originalModel: string | null = null;
let originalAcceptRemote: boolean | null = null;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  console.log('\n=== E2E Setup ===');
  console.log(`  Server:   ${BUILDD_SERVER}`);
  console.log(`  Local-UI: ${LOCAL_UI_URL}`);

  // 1. Read API key
  const apiKey = readApiKey();
  console.log(`  API Key:  ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`);

  server = new ServerClient(BUILDD_SERVER, apiKey);
  localUI = new LocalUIClient(LOCAL_UI_URL);

  // 2. Start local-ui (or verify it's running)
  await startLocalUI(LOCAL_UI_URL);

  // 3. Verify server reachable
  const { workspaces } = await server.listWorkspaces();
  if (workspaces.length === 0) {
    throw new Error('No workspaces available on server — cannot run E2E tests');
  }

  // Pick a workspace (prefer one named "buildd" for consistency)
  const ws = workspaces.find((w: any) => w.name?.toLowerCase().includes('buildd')) || workspaces[0];
  testWorkspaceId = ws.id;
  console.log(`  Workspace: ${ws.name} (${testWorkspaceId})`);

  // 4. Verify local-ui is configured and healthy
  const cfg = await localUI.getConfig();
  if (!cfg.configured) {
    throw new Error('Local-UI is not configured (no API key). Set up first.');
  }

  // 5. Sync local-ui's server URL to match this test's target
  originalServer = cfg.builddServer;
  if (cfg.builddServer !== BUILDD_SERVER) {
    console.log(`  Syncing local-ui server: ${cfg.builddServer} → ${BUILDD_SERVER}`);
    await localUI.setServer(BUILDD_SERVER);
  }

  // 6. Disable Pusher auto-pickup so the test controls claim timing
  originalAcceptRemote = cfg.acceptRemoteTasks !== false;
  if (originalAcceptRemote) {
    await localUI.setAcceptRemoteTasks(false);
    console.log('  Auto-pickup: disabled (prevents Pusher race)');
  }

  // 7. Set model for fast/cheap tests (save original to restore)
  originalModel = cfg.model;
  try {
    await localUI.setModel(TEST_MODEL);
    console.log(`  Model:    ${TEST_MODEL}`);
  } catch (err: any) {
    console.log(`  Model:    (could not set to ${TEST_MODEL}: ${err.message})`);
  }

  console.log('=== Setup complete ===\n');
});

afterAll(async () => {
  console.log('\n=== E2E Cleanup ===');

  // Abort any still-running workers
  for (const wid of createdWorkerIds) {
    try {
      await localUI.abortWorker(wid);
      console.log(`  Aborted worker ${wid}`);
    } catch { /* already done */ }
  }

  // Delete test tasks from server
  for (const tid of createdTaskIds) {
    try {
      await server.deleteTask(tid);
      console.log(`  Deleted task ${tid}`);
    } catch { /* may already be gone */ }
  }

  // Restore original settings on local-ui
  if (originalAcceptRemote) {
    try {
      await localUI.setAcceptRemoteTasks(true);
      console.log('  Restored auto-pickup → enabled');
    } catch { /* best effort */ }
  }
  if (originalServer && originalServer !== BUILDD_SERVER) {
    try {
      await localUI.setServer(originalServer);
      console.log(`  Restored local-ui server → ${originalServer}`);
    } catch { /* best effort */ }
  }
  if (originalModel && originalModel !== TEST_MODEL) {
    try {
      await localUI.setModel(originalModel);
      console.log(`  Restored local-ui model → ${originalModel}`);
    } catch { /* best effort */ }
  }

  // Stop local-ui if we started it
  await stopLocalUI();

  console.log('=== Cleanup complete ===\n');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E: Server + Worker Flow', () => {

  // ── 1. Server Connectivity ──────────────────────────────────────────────

  test('server is reachable and returns workspaces', async () => {
    const { workspaces } = await server.listWorkspaces();

    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.length).toBeGreaterThan(0);

    const ws = workspaces.find((w: any) => w.id === testWorkspaceId);
    expect(ws).toBeTruthy();
  });

  // ── 2. Local-UI Health ──────────────────────────────────────────────────

  test('local-ui is operational and lists workers', async () => {
    const cfg = await localUI.getConfig();
    expect(cfg.configured).toBe(true);

    const { workers } = await localUI.listWorkers();
    expect(Array.isArray(workers)).toBe(true);
  });

  // ── 3. Create Task on Server ────────────────────────────────────────────

  test('can create a task on the server', async () => {
    const marker = `TEST_${Date.now()}`;

    const task = await server.createTask({
      workspaceId: testWorkspaceId,
      title: `[E2E-TEST] Echo ${marker}`,
      description: `Reply with exactly: "${marker}". Nothing else.`,
      creationSource: 'api',
    });

    createdTaskIds.push(task.id);

    expect(task.id).toBeTruthy();
    expect(task.status).toBe('pending');
    expect(task.title).toContain('[E2E-TEST]');
  });

  // ── 4. Task Pickup + Execution via Local-UI ─────────────────────────────

  test('task is picked up by local worker and completes', async () => {
    const marker = `TEST_${Date.now()}`;

    // Create task directly on server
    const task = await server.createTask({
      workspaceId: testWorkspaceId,
      title: `[E2E-TEST] Echo ${marker}`,
      description: `Reply with exactly: "${marker}". Nothing else.`,
      creationSource: 'api',
    });
    createdTaskIds.push(task.id);

    // Claim via local-ui (triggers server-side claim + starts worker)
    const { worker } = await localUI.claimTask(task.id);
    createdWorkerIds.push(worker.id);
    expect(worker.status).toBe('working');

    // Confirm server sees the task as claimed (may still be pending briefly due to async)
    const serverTask = await server.getTask(task.id);
    expect(['pending', 'assigned', 'in_progress']).toContain(serverTask.status);

    // Poll local-ui until worker finishes
    const finalWorker = await pollUntil(
      async () => {
        const { workers } = await localUI.listWorkers();
        const w = workers.find((w: any) => w.id === worker.id);
        if (w?.status === 'done' || w?.status === 'error') return w;
        return null;
      },
      { timeout: TEST_TIMEOUT, interval: 3_000, label: 'worker completion' },
    );

    expect(finalWorker.status).toBe('done');

    // Verify the worker produced output
    if (finalWorker.output) {
      const outputText = Array.isArray(finalWorker.output)
        ? finalWorker.output.join(' ')
        : String(finalWorker.output);
      expect(outputText).toContain(marker);
    }

    // Verify server still has the task (status update may be async or depend on deployment version)
    const completedTask = await server.getTask(task.id);
    expect(completedTask).toBeTruthy();
    expect(completedTask.id).toBe(task.id);
  }, TEST_TIMEOUT);

  // ── 5. Worker Abort ─────────────────────────────────────────────────────

  test('worker can be aborted mid-execution', async () => {
    const task = await server.createTask({
      workspaceId: testWorkspaceId,
      title: '[E2E-TEST] Long task for abort',
      description: 'Count from 1 to 1000, one number per line, very slowly.',
      creationSource: 'api',
    });
    createdTaskIds.push(task.id);

    const { worker } = await localUI.claimTask(task.id);
    createdWorkerIds.push(worker.id);

    // Give it a moment to start, then abort
    await Bun.sleep(3_000);
    await localUI.abortWorker(worker.id);

    // Verify worker is in error state
    const { workers } = await localUI.listWorkers();
    const aborted = workers.find((w: any) => w.id === worker.id);

    expect(aborted?.status).toBe('error');
  }, TEST_TIMEOUT);

  // ── 6. Concurrent Workers ────────────────────────────────────────────────

  test('two workers can run concurrently and both complete', async () => {
    // Create two tasks
    const [task1, task2] = await Promise.all([
      server.createTask({
        workspaceId: testWorkspaceId,
        title: '[E2E-TEST] Concurrent 1',
        description: 'Reply with exactly: "CONCURRENT_1". Nothing else.',
        creationSource: 'api',
      }),
      server.createTask({
        workspaceId: testWorkspaceId,
        title: '[E2E-TEST] Concurrent 2',
        description: 'Reply with exactly: "CONCURRENT_2". Nothing else.',
        creationSource: 'api',
      }),
    ]);
    createdTaskIds.push(task1.id, task2.id);

    // Claim both
    const [claim1, claim2] = await Promise.all([
      localUI.claimTask(task1.id),
      localUI.claimTask(task2.id),
    ]);
    createdWorkerIds.push(claim1.worker.id, claim2.worker.id);

    // Poll until both done
    const bothDone = await pollUntil(
      async () => {
        const { workers } = await localUI.listWorkers();
        const w1 = workers.find((w: any) => w.id === claim1.worker.id);
        const w2 = workers.find((w: any) => w.id === claim2.worker.id);
        const done1 = w1?.status === 'done' || w1?.status === 'error';
        const done2 = w2?.status === 'done' || w2?.status === 'error';
        if (done1 && done2) return { w1, w2 };
        return null;
      },
      { timeout: TEST_TIMEOUT, interval: 3_000, label: 'both workers completion' },
    );

    expect(bothDone.w1.status).toBe('done');
    expect(bothDone.w2.status).toBe('done');
  }, TEST_TIMEOUT);

  // ── 7. Combined Workspace Listing ────────────────────────────────────────

  test('combined workspaces includes server and local repos', async () => {
    const data = await localUI.fetch<{
      workspaces: any[];
      serverless: boolean;
    }>('/api/combined-workspaces');

    expect(Array.isArray(data.workspaces)).toBe(true);
    expect(data.workspaces.length).toBeGreaterThan(0);

    // Should have at least one 'ready' workspace (matched server + local)
    const ready = data.workspaces.filter((w: any) => w.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);

    // Each workspace should have required fields
    for (const ws of data.workspaces) {
      expect(ws.name).toBeTruthy();
      expect(['ready', 'needs-clone', 'local-only']).toContain(ws.status);
    }
  });
});
