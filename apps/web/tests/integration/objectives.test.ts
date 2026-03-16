/**
 * Integration Tests: Objectives Management
 *
 * Tests the complete objectives CRUD lifecycle including:
 *   - Create objective (POST /api/missions)
 *   - List objectives (GET /api/missions)
 *   - Get single objective (GET /api/missions/[id])
 *   - Update objective (PATCH /api/missions/[id])
 *   - Delete objective (DELETE /api/missions/[id])
 *   - Task linking via objectiveId
 *   - Progress computation (including > 0 with completed tasks)
 *   - Schedule auto-creation with cronExpression
 *   - Validation (400 for bad input)
 *   - Not-found (404 for nonexistent IDs)
 *   - Auth (401 unauthenticated, 403 worker-level key)
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_ADMIN_API_KEY or BUILDD_API_KEY set (objectives require admin-level key)
 *
 * Usage:
 *   bun run test:integration objectives
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
const objectiveIds: string[] = [];
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
  // Clean up tasks first (they reference objectives)
  for (const id of taskIds.reverse()) {
    try {
      await api(`/api/tasks/${id}?force=true`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
  // Then clean up objectives
  for (const id of objectiveIds.reverse()) {
    try {
      await api(`/api/missions/${id}`, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

describe('Objectives CRUD', () => {
  let createdId: string;

  test('POST creates objective with title', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test Objective' }),
    });
    expect(data.id).toBeDefined();
    expect(data.title).toBe('Test Objective');
    expect(data.status).toBe('active');
    expect(data.priority).toBe(0);
    createdId = data.id;
    objectiveIds.push(createdId);
  }, TIMEOUT);

  test('POST with workspaceId pins to workspace', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Workspace-pinned Objective',
        workspaceId,
      }),
    });
    expect(data.id).toBeDefined();
    expect(data.workspaceId).toBe(workspaceId);
    objectiveIds.push(data.id);
  }, TIMEOUT);

  test('POST with cronExpression auto-creates schedule', async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Scheduled Objective',
        workspaceId,
        cronExpression: '0 9 * * *',
      }),
    });
    expect(data.id).toBeDefined();
    expect(data.scheduleId).toBeDefined();
    expect(data.cronExpression).toBe('0 9 * * *');
    objectiveIds.push(data.id);
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
    objectiveIds.push(data.id);
  }, TIMEOUT);

  test('GET lists objectives', async () => {
    const data = await api('/api/missions');
    expect(Array.isArray(data.objectives)).toBe(true);
    expect(data.objectives.length).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);

  test('GET lists objectives filtered by status', async () => {
    const data = await api('/api/missions?status=active');
    expect(Array.isArray(data.objectives)).toBe(true);
    for (const obj of data.objectives) {
      expect(obj.status).toBe('active');
    }
  }, TIMEOUT);

  test('GET lists objectives filtered by workspaceId', async () => {
    const data = await api(`/api/missions?workspaceId=${workspaceId}`);
    expect(Array.isArray(data.objectives)).toBe(true);
    for (const obj of data.objectives) {
      expect(obj.workspaceId).toBe(workspaceId);
    }
  }, TIMEOUT);

  test('GET /[id] returns objective with linked tasks and progress', async () => {
    const data = await api(`/api/missions/${createdId}`);
    expect(data.id).toBe(createdId);
    expect(data.title).toBe('Test Objective');
    expect(data.totalTasks).toBe(0);
    expect(data.completedTasks).toBe(0);
    expect(data.progress).toBe(0);
    expect(Array.isArray(data.tasks)).toBe(true);
  }, TIMEOUT);

  test('PATCH updates title, description, status', async () => {
    const data = await api(`/api/missions/${createdId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'Updated Objective',
        description: 'A description',
        status: 'paused',
      }),
    });
    expect(data.title).toBe('Updated Objective');
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

  test('DELETE removes objective, tasks keep objectiveId=null', async () => {
    // Create a temporary objective and link a task
    const obj = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Delete-test Objective' }),
    });

    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Task for delete test',
        objectiveId: obj.id,
      }),
    });
    taskIds.push(task.id);

    // Delete the objective
    const res = await api(`/api/missions/${obj.id}`, { method: 'DELETE' });
    expect(res.success).toBe(true);

    // Verify task still exists with null objectiveId
    const taskAfter = await api(`/api/tasks/${task.id}`);
    expect(taskAfter.id).toBe(task.id);
    expect(taskAfter.objectiveId).toBeNull();
  }, TIMEOUT);
});

// ── Task Linking ──────────────────────────────────────────────────────────────

describe('Task Linking', () => {
  let objectiveId: string;

  beforeAll(async () => {
    const data = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Linking Test Objective' }),
    });
    objectiveId = data.id;
    objectiveIds.push(objectiveId);
  });

  test('POST /tasks with objectiveId links task to objective', async () => {
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Linked task 1',
        objectiveId,
      }),
    });
    expect(task.objectiveId).toBe(objectiveId);
    taskIds.push(task.id);
  }, TIMEOUT);

  test('PATCH /tasks/[id] with objectiveId links existing task', async () => {
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
      body: JSON.stringify({ objectiveId }),
    });
    expect(updated.objectiveId).toBe(objectiveId);
  }, TIMEOUT);

  test('PATCH /tasks/[id] with objectiveId=null unlinks task', async () => {
    // Use the task from the previous test
    const lastTaskId = taskIds[taskIds.length - 1];
    const updated = await api(`/api/tasks/${lastTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ objectiveId: null }),
    });
    expect(updated.objectiveId).toBeNull();

    // Re-link for subsequent tests
    await api(`/api/tasks/${lastTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ objectiveId }),
    });
  }, TIMEOUT);

  test('GET /objectives/[id] progress reflects completed/total tasks', async () => {
    const data = await api(`/api/missions/${objectiveId}`);
    expect(data.totalTasks).toBeGreaterThanOrEqual(2);
    expect(data.completedTasks).toBe(0);
    expect(data.progress).toBe(0);
  }, TIMEOUT);

  test('Progress > 0 when tasks are completed', async () => {
    // Create a new objective with tasks we control
    const obj = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Progress Test Objective' }),
    });
    objectiveIds.push(obj.id);

    // Create 2 tasks linked to it
    const t1 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: 'Progress task 1', objectiveId: obj.id }),
    });
    taskIds.push(t1.id);

    const t2 = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: 'Progress task 2', objectiveId: obj.id }),
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
    const data = await api(`/api/missions/${obj.id}`);
    expect(data.totalTasks).toBe(2);
    expect(data.completedTasks).toBe(1);
    expect(data.progress).toBe(50);
  }, TIMEOUT);

  test('Progress = 0 when no tasks linked', async () => {
    const empty = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Empty objective' }),
    });
    objectiveIds.push(empty.id);

    const data = await api(`/api/missions/${empty.id}`);
    expect(data.progress).toBe(0);
    expect(data.totalTasks).toBe(0);
  }, TIMEOUT);

  test('GET /tasks/[id] includes objective relation', async () => {
    const task = await api(`/api/tasks/${taskIds[0]}`);
    expect(task.objective).toBeDefined();
    expect(task.objective.id).toBe(objectiveId);
    expect(task.objective.title).toBe('Linking Test Objective');
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
    const obj = await api('/api/missions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Validation test' }),
    });
    objectiveIds.push(obj.id);

    const { status, body } = await apiRaw(`/api/missions/${obj.id}`, {
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

  test('GET /objectives/[id] returns 404 for nonexistent ID', async () => {
    const { status } = await apiRaw(`/api/missions/${fakeId}`);
    expect(status).toBe(404);
  }, TIMEOUT);

  test('PATCH /objectives/[id] returns 404 for nonexistent ID', async () => {
    const { status } = await apiRaw(`/api/missions/${fakeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(status).toBe(404);
  }, TIMEOUT);

  test('DELETE /objectives/[id] returns 404 for nonexistent ID', async () => {
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
