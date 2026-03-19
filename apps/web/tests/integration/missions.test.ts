/**
 * Integration Tests: Missions Management
 *
 * Tests the complete missions CRUD lifecycle including:
 *   - Create mission (POST /api/missions)
 *   - List missions (GET /api/missions)
 *   - Get single mission (GET /api/missions/[id])
 *   - Update mission (PATCH /api/missions/[id])
 *   - Delete mission (DELETE /api/missions/[id])
 *   - Task linking via missionId
 *   - Progress computation (including > 0 with completed tasks)
 *   - Schedule auto-creation with cronExpression
 *   - Validation (400 for bad input)
 *   - Not-found (404 for nonexistent IDs)
 *   - Auth (401 unauthenticated, 403 worker-level key)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_ADMIN_API_KEY or BUILDD_API_KEY set (missions require admin-level key)
 *
 * Usage:
 *   bun run test:integration missions
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();

const ADMIN_KEY = process.env.BUILDD_ADMIN_API_KEY || process.env.BUILDD_API_KEY;
if (!ADMIN_KEY) {
  console.log('Skipping: BUILDD_ADMIN_API_KEY (or BUILDD_API_KEY) not set');
  process.exit(0);
}

const { api, apiRaw } = createTestApi(SERVER, ADMIN_KEY);
const cleanup = createCleanup(api);

let workspaceId: string;
const missionIds: string[] = [];
const taskIds: string[] = [];

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

beforeAll(async () => {
  workspaceId = await findWorkspace();
});

afterAll(async () => {
  // Clean up tasks first (they reference missions)
  for (const id of taskIds.reverse()) {
    try {
      await api(`/api/tasks/${id}?force=true`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
  // Then clean up missions
  for (const id of missionIds.reverse()) {
    try {
      await api(`/api/missions/${id}`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

describe('Missions CRUD', () => {
  let createdId: string;

  test('POST creates mission with title', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test Mission' }),
    });
    expect(data.id).toBeDefined();
    expect(data.title).toBe('Test Mission');
    expect(data.status).toBe('active');
    expect(data.priority).toBe(0);
    createdId = data.id;
    missionIds.push(createdId);
  }, TIMEOUT);

  test('POST with workspaceId pins to workspace', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace-pinned Mission',
        workspaceId,
      }),
    });
    expect(data.id).toBeDefined();
    expect(data.workspaceId).toBe(workspaceId);
    missionIds.push(data.id);
  }, TIMEOUT);

  test('POST with cronExpression auto-creates schedule', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Scheduled Mission',
        workspaceId,
        cronExpression: '0 9 * * *',
      }),
    });
    expect(data.id).toBeDefined();
    expect(data.scheduleId).toBeDefined();
    expect(data.cronExpression).toBe('0 9 * * *');
    missionIds.push(data.id);
  }, TIMEOUT);

  test('POST with cronExpression but no workspaceId skips schedule', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Cron without workspace',
        cronExpression: '0 9 * * *',
      }),
    });
    expect(data.id).toBeDefined();
    expect(data.scheduleId).toBeNull();
    expect(data.cronExpression).toBe('0 9 * * *');
    missionIds.push(data.id);
  }, TIMEOUT);

  test('GET lists missions', async () => {
    const data = await api('/api/missions');
    expect(Array.isArray(data.missions)).toBe(true);
    expect(data.missions.length).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);

  test('GET lists missions filtered by status', async () => {
    const data = await api('/api/missions?status=active');
    expect(Array.isArray(data.missions)).toBe(true);
    for (const m of data.missions) {
      expect(m.status).toBe('active');
    }
  }, TIMEOUT);

  test('GET lists missions filtered by workspaceId', async () => {
    const data = await api(`/api/missions?workspaceId=${workspaceId}`);
    expect(Array.isArray(data.missions)).toBe(true);
    for (const m of data.missions) {
      expect(m.workspaceId).toBe(workspaceId);
    }
  }, TIMEOUT);

  test('GET /[id] returns mission with linked tasks and progress', async () => {
    const data = await api(`/api/missions/${createdId}`);
    expect(data.id).toBe(createdId);
    expect(data.title).toBe('Test Mission');
    expect(data.totalTasks).toBe(0);
    expect(data.completedTasks).toBe(0);
    expect(data.progress).toBe(0);
    expect(Array.isArray(data.tasks)).toBe(true);
  }, TIMEOUT);

  test('PATCH updates title, description, status', async () => {
    const data = await api(`/api/missions/${createdId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'Updated Mission',
        description: 'A description',
        status: 'paused',
      }),
    });
    expect(data.title).toBe('Updated Mission');
    expect(data.description).toBe('A description');
    expect(data.status).toBe('paused');
  }, TIMEOUT);

  test('PATCH with cronExpression creates schedule', async () => {
    const data = await api(`/api/missions/${createdId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        cronExpression: '0 12 * * 1',
        workspaceId,
      }),
    });
    expect(data.scheduleId).toBeDefined();
    expect(data.cronExpression).toBe('0 12 * * 1');
  }, TIMEOUT);

  test('PATCH clearing cronExpression removes schedule', async () => {
    // createdId already has a schedule from previous test
    const data = await api(`/api/missions/${createdId}`, {
      method: 'PATCH',
      body: JSON.stringify({ cronExpression: null }),
    });
    expect(data.scheduleId).toBeNull();
    expect(data.cronExpression).toBeNull();
  }, TIMEOUT);

  test('DELETE removes mission, tasks keep missionId=null', async () => {
    // Create a temporary mission and link a task
    const m = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Delete-test Mission' }),
    });

    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Task for delete test',
        missionId: m.id,
      }),
    });
    taskIds.push(task.id);

    // Delete the mission
    const res = await api(`/api/missions/${m.id}`, { method: 'DELETE' });
    expect(res.success).toBe(true);

    // Verify task still exists with null missionId
    const taskAfter = await api(`/api/tasks/${task.id}`);
    expect(taskAfter.id).toBe(task.id);
    expect(taskAfter.missionId).toBeNull();
  }, TIMEOUT);
});

// ── Task Linking ──────────────────────────────────────────────────────────────

describe('Task Linking', () => {
  let missionId: string;

  beforeAll(async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Linking Test Mission' }),
    });
    missionId = data.id;
    missionIds.push(missionId);
  });

  test('POST /tasks with missionId links task to mission', async () => {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Linked task 1',
        missionId,
      }),
    });
    expect(task.missionId).toBe(missionId);
    taskIds.push(task.id);
  }, TIMEOUT);

  test('PATCH /tasks/[id] with missionId links existing task', async () => {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Unlinked task',
      }),
    });
    taskIds.push(task.id);

    const updated = await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ missionId }),
    });
    expect(updated.missionId).toBe(missionId);
  }, TIMEOUT);

  test('PATCH /tasks/[id] with missionId=null unlinks task', async () => {
    // Use the task from the previous test
    const lastTaskId = taskIds[taskIds.length - 1];
    const updated = await api(`/api/tasks/${lastTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ missionId: null }),
    });
    expect(updated.missionId).toBeNull();

    // Re-link for subsequent tests
    await api(`/api/tasks/${lastTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ missionId }),
    });
  }, TIMEOUT);

  test('GET /missions/[id] progress reflects completed/total tasks', async () => {
    const data = await api(`/api/missions/${missionId}`);
    expect(data.totalTasks).toBeGreaterThanOrEqual(2);
    expect(data.completedTasks).toBe(0);
    expect(data.progress).toBe(0);
  }, TIMEOUT);

  test('Progress > 0 when tasks are completed', async () => {
    // Create a new mission with tasks we control
    const m = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Progress Test Mission' }),
    });
    missionIds.push(m.id);

    // Create 2 tasks linked to it
    const t1 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: 'Progress task 1', missionId: m.id }),
    });
    taskIds.push(t1.id);

    const t2 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: 'Progress task 2', missionId: m.id }),
    });
    taskIds.push(t2.id);

    // Claim and complete one task via worker flow
    const claim = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, runner: 'test-progress', taskId: t1.id }),
    });
    if (claim.workers?.length > 0) {
      await api(`/api/workers/${claim.workers[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' }),
      });
    }

    // Check progress — should be 50% (1/2)
    const data = await api(`/api/missions/${m.id}`);
    expect(data.totalTasks).toBe(2);
    expect(data.completedTasks).toBe(1);
    expect(data.progress).toBe(50);
  }, TIMEOUT);

  test('Progress = 0 when no tasks linked', async () => {
    const empty = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Empty mission' }),
    });
    missionIds.push(empty.id);

    const data = await api(`/api/missions/${empty.id}`);
    expect(data.progress).toBe(0);
    expect(data.totalTasks).toBe(0);
  }, TIMEOUT);

  test('GET /tasks/[id] includes mission relation', async () => {
    const task = await api(`/api/tasks/${taskIds[0]}`);
    expect(task.mission).toBeDefined();
    expect(task.mission.id).toBe(missionId);
    expect(task.mission.title).toBe('Linking Test Mission');
  }, TIMEOUT);
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('Validation', () => {
  test('POST without title returns 400', async () => {
    const { status, body } = await apiRaw('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ description: 'no title' }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('title');
  }, TIMEOUT);

  test('PATCH with invalid status returns 400', async () => {
    const m = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Validation test' }),
    });
    missionIds.push(m.id);

    const { status, body } = await apiRaw(`/api/missions/${m.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'invalid_status' }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('status');
  }, TIMEOUT);
});

// ── Not Found ─────────────────────────────────────────────────────────────────

describe('Not Found', () => {
  const fakeId = '00000000-0000-0000-0000-000000000000';

  test('GET /missions/[id] returns 404 for nonexistent ID', async () => {
    const { status } = await apiRaw(`/api/missions/${fakeId}`);
    expect(status).toBe(404);
  }, TIMEOUT);

  test('PATCH /missions/[id] returns 404 for nonexistent ID', async () => {
    const { status } = await apiRaw(`/api/missions/${fakeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(status).toBe(404);
  }, TIMEOUT);

  test('DELETE /missions/[id] returns 404 for nonexistent ID', async () => {
    const { status } = await apiRaw(`/api/missions/${fakeId}`, {
      method: 'DELETE',
    });
    expect(status).toBe(404);
  }, TIMEOUT);
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Auth', () => {
  test('Unauthenticated GET returns 401', async () => {
    const res = await fetch(`${SERVER}/api/missions`);
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('Unauthenticated POST returns 401', async () => {
    const res = await fetch(`${SERVER}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Should fail' }),
    });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('Unauthenticated PATCH returns 401', async () => {
    const res = await fetch(`${SERVER}/api/missions/some-id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('Unauthenticated DELETE returns 401', async () => {
    const res = await fetch(`${SERVER}/api/missions/some-id`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  }, TIMEOUT);

  test('Worker-level API key returns 403 on GET', async () => {
    // Use BUILDD_WORKER_API_KEY if available to test worker-level rejection
    const workerKey = process.env.BUILDD_WORKER_API_KEY;
    if (!workerKey) {
      console.log('    (skipped: BUILDD_WORKER_API_KEY not set)');
      return;
    }
    const res = await fetch(`${SERVER}/api/missions`, {
      headers: { Authorization: `Bearer ${workerKey}` },
    });
    expect(res.status).toBe(403);
  }, TIMEOUT);
});
