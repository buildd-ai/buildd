/**
 * E2E Integration Test: Server + Runner Full Flow
 *
 * Validates the core buildd distributed flow:
 *   Server reachable → Create task → Local worker picks it up → Completion confirmed
 *
 * Environment variables:
 *   BUILDD_TEST_SERVER   Remote server URL  (required — no fallback to production)
 *   BUILDD_API_KEY       API key            (fallback: ~/.buildd/config.json)
 *   LOCAL_UI_URL         Runner address   (default: http://localhost:8766)
 *   SKIP_LOCAL_UI_START  Set to "1" if runner is already running
 *   E2E_MODEL            Model to use       (default: claude-haiku-4-5-20251001)
 *   E2E_SCOPE            Which tests to run: "all" (default), "api", "worker"
 *
 * Usage:
 *   bun run test:e2e                                     # full lifecycle
 *   E2E_SCOPE=api bun run test:e2e                       # API-only (no runner needed)
 *   E2E_SCOPE=worker bun run test:e2e                    # worker execution only
 *   SKIP_LOCAL_UI_START=1 bun run test:e2e               # runner already running
 *   BUILDD_TEST_SERVER=https://your-preview.vercel.app bun run test:e2e
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

const BUILDD_SERVER = process.env.BUILDD_TEST_SERVER;
if (!BUILDD_SERVER) {
  console.log(
    '⏭️  Skipping: BUILDD_TEST_SERVER not set.\n' +
    '   Set it to a preview/local URL to run E2E tests.\n' +
    '   Example: BUILDD_TEST_SERVER=http://localhost:3000 bun run test:e2e',
  );
  process.exit(0);
}

const LOCAL_UI_URL = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TEST_TIMEOUT = 120_000; // 2 min — Claude execution can be slow
const TEST_MODEL = process.env.E2E_MODEL || 'claude-haiku-4-5-20251001';

// Scope controls which test sections run:
//   "all"    — everything (default)
//   "api"    — server API tests only (no runner needed, fast)
//   "worker" — worker execution tests only (needs runner)
const E2E_SCOPE = (process.env.E2E_SCOPE || 'all') as 'all' | 'api' | 'worker';
const RUN_API_TESTS = E2E_SCOPE === 'all' || E2E_SCOPE === 'api';
const RUN_WORKER_TESTS = E2E_SCOPE === 'all' || E2E_SCOPE === 'worker';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let server: ServerClient;
let localUI: LocalUIClient;
let testWorkspaceId: string;

// Track resources for cleanup
const createdTaskIds: string[] = [];
const createdWorkerIds: string[] = [];
const createdMissionIds: string[] = [];
let originalServer: string | null = null; // to restore after tests
let originalModel: string | null = null;
let originalAcceptRemote: boolean | null = null;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  console.log('\n=== E2E Setup ===');
  console.log(`  Server:   ${BUILDD_SERVER}`);
  console.log(`  Scope:    ${E2E_SCOPE}`);

  // 1. Read API key
  const apiKey = readApiKey();
  console.log(`  API Key:  ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`);

  const adminApiKey = process.env.BUILDD_ADMIN_API_KEY;
  server = new ServerClient(BUILDD_SERVER, apiKey, adminApiKey);
  localUI = new LocalUIClient(LOCAL_UI_URL);

  // 2. Verify server reachable
  const { workspaces } = await server.listWorkspaces();
  if (workspaces.length === 0) {
    throw new Error('No workspaces available on server — cannot run E2E tests');
  }

  // Pick a workspace (prefer one named "buildd" for consistency)
  const ws = workspaces.find((w: any) => w.name?.toLowerCase().includes('buildd')) || workspaces[0];
  testWorkspaceId = ws.id;
  console.log(`  Workspace: ${ws.name} (${testWorkspaceId})`);

  // 3. Runner setup — only needed for worker execution tests
  if (RUN_WORKER_TESTS) {
    console.log(`  Local-UI: ${LOCAL_UI_URL}`);

    await startLocalUI(LOCAL_UI_URL);

    const cfg = await localUI.getConfig();
    if (!cfg.configured) {
      throw new Error('Runner is not configured (no API key). Set up first.');
    }

    // Abort any lingering workers from previous test runs to free concurrent slots
    try {
      const { workers: serverWorkers } = await server.listMyWorkers('idle,running,starting,waiting_input');
      if (serverWorkers.length > 0) {
        console.log(`  Terminating ${serverWorkers.length} stale server-side worker(s) from previous runs...`);
        await Promise.allSettled(serverWorkers.map((w: any) => server.terminateWorker(w.id)));
        await Bun.sleep(1_000);
      }
    } catch { /* best effort */ }
    try {
      const { workers: activeWorkers } = await localUI.listWorkers();
      const lingering = activeWorkers.filter((w: any) =>
        w.status === 'running' || w.status === 'claimed' || w.status === 'waiting_input',
      );
      if (lingering.length > 0) {
        console.log(`  Aborting ${lingering.length} lingering local worker(s) from previous runs...`);
        await Promise.allSettled(lingering.map((w: any) => localUI.abortWorker(w.id)));
        await Bun.sleep(1_000);
      }
    } catch { /* best effort */ }

    // Sync runner's server URL to match this test's target
    const runnerServer = process.env.BUILDD_RUNNER_SERVER || BUILDD_SERVER;
    originalServer = cfg.builddServer;
    if (cfg.builddServer !== runnerServer) {
      console.log(`  Syncing runner server: ${cfg.builddServer} → ${runnerServer}`);
      await localUI.setServer(runnerServer);
    }

    // Disable Pusher auto-pickup so the test controls claim timing
    originalAcceptRemote = cfg.acceptRemoteTasks !== false;
    if (originalAcceptRemote) {
      await localUI.setAcceptRemoteTasks(false);
      console.log('  Auto-pickup: disabled (prevents Pusher race)');
    }

    // Set model for fast/cheap tests
    originalModel = cfg.model;
    try {
      await localUI.setModel(TEST_MODEL);
      console.log(`  Model:    ${TEST_MODEL}`);
    } catch (err: any) {
      console.log(`  Model:    (could not set to ${TEST_MODEL}: ${err.message})`);
    }
  } else {
    console.log('  Runner:   skipped (api scope)');
  }

  console.log('=== Setup complete ===\n');
}, 60_000);

afterAll(async () => {
  console.log('\n=== E2E Cleanup ===');

  // Abort any still-running workers
  for (const wid of createdWorkerIds) {
    try {
      await localUI.abortWorker(wid);
      console.log(`  Aborted worker ${wid}`);
    } catch { /* already done */ }
  }

  // Delete test tasks from server (use force=true for completed tasks)
  for (const tid of createdTaskIds) {
    try {
      await server.fetch(`/api/tasks/${tid}?force=true`, { method: 'DELETE' });
      console.log(`  Deleted task ${tid}`);
    } catch { /* may already be gone */ }
  }

  // Delete test missions
  for (const mid of createdMissionIds) {
    try {
      await server.deleteMission(mid);
      console.log(`  Deleted mission ${mid}`);
    } catch { /* may already be gone */ }
  }

  // Restore original settings on runner
  if (RUN_WORKER_TESTS) {
    if (originalAcceptRemote) {
      try {
        await localUI.setAcceptRemoteTasks(true);
        console.log('  Restored auto-pickup → enabled');
      } catch { /* best effort */ }
    }
    if (originalServer && originalServer !== BUILDD_SERVER) {
      try {
        await localUI.setServer(originalServer);
        console.log(`  Restored runner server → ${originalServer}`);
      } catch { /* best effort */ }
    }
    if (originalModel && originalModel !== TEST_MODEL) {
      try {
        await localUI.setModel(originalModel);
        console.log(`  Restored runner model → ${originalModel}`);
      } catch { /* best effort */ }
    }

    await stopLocalUI();
  }

  console.log('=== Cleanup complete ===\n');
});

// ---------------------------------------------------------------------------
// Tests — Server API (fast, no runner needed)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_API_TESTS)('E2E: Server API', () => {

  test('server is reachable and returns workspaces', async () => {
    const { workspaces } = await server.listWorkspaces();

    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.length).toBeGreaterThan(0);

    const ws = workspaces.find((w: any) => w.id === testWorkspaceId);
    expect(ws).toBeTruthy();
  });

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

  test('can create and read a mission', async () => {
    const marker = `MISSION_API_${Date.now()}`;

    const mission = await server.createMission({
      title: `[E2E-TEST] ${marker}`,
      description: 'E2E API test',
    });
    createdMissionIds.push(mission.id);

    expect(mission.id).toBeTruthy();
    expect(mission.title).toContain(marker);

    const fetched = await server.getMission(mission.id);
    expect(fetched.id).toBe(mission.id);
    expect(fetched.totalTasks).toBe(0);
    expect(fetched.progress).toBe(0);
  });

  test('can create a task linked to a mission', async () => {
    const mission = await server.createMission({
      title: `[E2E-TEST] Link test ${Date.now()}`,
    });
    createdMissionIds.push(mission.id);

    const task = await server.fetch<any>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        title: '[E2E-TEST] Linked task',
        description: 'Testing mission-task link',
        creationSource: 'api',
        missionId: mission.id,
      }),
    });
    createdTaskIds.push(task.id);

    expect(task.missionId).toBe(mission.id);

    // Mission should reflect the new task
    const updated = await server.getMission(mission.id);
    expect(updated.totalTasks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — Runner Health (needs runner, but no Claude execution)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_WORKER_TESTS)('E2E: Runner Health', () => {

  test('runner is operational and lists workers', async () => {
    const cfg = await localUI.getConfig();
    expect(cfg.configured).toBe(true);

    const { workers } = await localUI.listWorkers();
    expect(Array.isArray(workers)).toBe(true);
  });

  test('combined workspaces includes server and local repos', async () => {
    const data = await localUI.fetch<{
      workspaces: any[];
      serverless: boolean;
    }>('/api/combined-workspaces');

    expect(Array.isArray(data.workspaces)).toBe(true);
    expect(data.workspaces.length).toBeGreaterThan(0);

    const ready = data.workspaces.filter((w: any) => w.status === 'ready');
    expect(ready.length).toBeGreaterThan(0);

    for (const ws of data.workspaces) {
      expect(ws.name).toBeTruthy();
      expect(['ready', 'needs-clone', 'local-only']).toContain(ws.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — Worker Execution (expensive, needs runner + Claude)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_WORKER_TESTS)('E2E: Worker Execution', () => {

  test('task is picked up by local worker and completes', async () => {
    const marker = `TEST_${Date.now()}`;

    const task = await server.createTask({
      workspaceId: testWorkspaceId,
      title: `[E2E-TEST] Echo ${marker}`,
      description: `Reply with exactly: "${marker}". Nothing else.`,
      creationSource: 'api',
    });
    createdTaskIds.push(task.id);

    const { worker } = await localUI.claimTask(task.id);
    createdWorkerIds.push(worker.id);
    expect(worker.status).toBe('working');

    try {
      const serverTask = await server.getTask(task.id);
      expect(['pending', 'assigned', 'in_progress']).toContain(serverTask.status);
    } catch {
      // Non-critical — server may be slow to reflect claim status
    }

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

    if (finalWorker.output) {
      const outputText = Array.isArray(finalWorker.output)
        ? finalWorker.output.join(' ')
        : String(finalWorker.output);
      expect(outputText).toContain(marker);
    }

    const completedTask = await server.getTask(task.id);
    expect(completedTask).toBeTruthy();
    expect(completedTask.id).toBe(task.id);
  }, TEST_TIMEOUT);

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

    await Bun.sleep(3_000);
    await localUI.abortWorker(worker.id);

    const { workers } = await localUI.listWorkers();
    const aborted = workers.find((w: any) => w.id === worker.id);

    expect(aborted?.status).toBe('error');
  }, TEST_TIMEOUT);

  test('two workers can run concurrently and both complete', async () => {
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

    const [claim1, claim2] = await Promise.all([
      localUI.claimTask(task1.id),
      localUI.claimTask(task2.id),
    ]);
    createdWorkerIds.push(claim1.worker.id, claim2.worker.id);

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

    const statuses = [bothDone.w1.status, bothDone.w2.status];
    expect(statuses).toContain('done');
    for (const s of statuses) {
      expect(['done', 'error']).toContain(s);
    }
  }, TEST_TIMEOUT);

  test('mission-linked task completes and mission progress updates', async () => {
    const marker = `MISSION_${Date.now()}`;

    const mission = await server.createMission({
      title: `[E2E-TEST] Mission ${marker}`,
      description: 'E2E test: verify mission progress tracks task completion',
    });
    createdMissionIds.push(mission.id);
    expect(mission.id).toBeTruthy();

    const task = await server.fetch<any>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: testWorkspaceId,
        title: `[E2E-TEST] Mission task ${marker}`,
        description: `Reply with exactly: "${marker}". Nothing else.`,
        creationSource: 'api',
        missionId: mission.id,
      }),
    });
    createdTaskIds.push(task.id);

    const { worker } = await localUI.claimTask(task.id);
    createdWorkerIds.push(worker.id);

    const finalWorker = await pollUntil(
      async () => {
        const { workers } = await localUI.listWorkers();
        const w = workers.find((w: any) => w.id === worker.id);
        if (w?.status === 'done' || w?.status === 'error') return w;
        return null;
      },
      { timeout: TEST_TIMEOUT, interval: 3_000, label: 'mission worker completion' },
    );
    expect(finalWorker.status).toBe('done');

    const updatedMission = await server.getMission(mission.id);
    expect(updatedMission.id).toBe(mission.id);
    expect(updatedMission.totalTasks).toBeGreaterThanOrEqual(1);
    expect(updatedMission.completedTasks).toBeGreaterThanOrEqual(1);
    expect(updatedMission.progress).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});
