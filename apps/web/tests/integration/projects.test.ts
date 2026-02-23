/**
 * Integration Tests: Project Scoping Feature
 *
 * Tests the projects registry on workspaces and project field on tasks/observations.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   BUILDD_TEST_SERVER=http://localhost:3000 bun test apps/web/tests/integration/projects.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api, apiRaw } = createTestApi(SERVER, API_KEY);

// --- Helpers ---

let workspaceId: string;
const cleanup = createCleanup(api);

function marker(): string {
  return `TEST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  console.log(`  Using workspace: ${ws.name} (${ws.id})`);
  return ws.id;
}

// Track created observation IDs for cleanup
const createdObservationIds: string[] = [];

async function cleanupAll() {
  // Clean observations
  for (const id of createdObservationIds) {
    try {
      await api(`/api/workspaces/${workspaceId}/observations/${id}`, {
        method: 'DELETE',
        retries: 0,
      });
    } catch {}
  }
  // Clean tasks
  await cleanup.runCleanup();
}

// --- Test suite ---

describe('Project Scoping', () => {
  beforeAll(async () => {
    workspaceId = await findWorkspace();
  }, TIMEOUT);

  afterAll(async () => {
    await cleanupAll();
    cleanup.dispose();
  });

  // ---------------------------------------------------------------
  // Projects Registry
  // ---------------------------------------------------------------

  test('PUT replaces workspace projects array', async () => {
    const projects = [
      { name: '@test/web', path: 'apps/web' },
      { name: '@test/core', path: 'packages/core' },
    ];

    const data = await api(`/api/workspaces/${workspaceId}/projects`, {
      method: 'PUT',
      body: JSON.stringify({ projects }),
    });

    expect(data.projects).toHaveLength(2);
    expect(data.projects[0].name).toBe('@test/web');
    expect(data.projects[1].name).toBe('@test/core');
  }, TIMEOUT);

  test('GET returns current projects', async () => {
    // Set known state first
    await api(`/api/workspaces/${workspaceId}/projects`, {
      method: 'PUT',
      body: JSON.stringify({ projects: [{ name: '@test/get-check', path: 'apps/check' }] }),
    });

    const data = await api(`/api/workspaces/${workspaceId}/projects`);

    expect(Array.isArray(data.projects)).toBe(true);
    expect(data.projects.some((p: any) => p.name === '@test/get-check')).toBe(true);
  }, TIMEOUT);

  test('POST upserts project by name (create + update)', async () => {
    // Reset to empty
    await api(`/api/workspaces/${workspaceId}/projects`, {
      method: 'PUT',
      body: JSON.stringify({ projects: [] }),
    });

    // Create
    const { status: createStatus } = await apiRaw(`/api/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: '@test/upsert', path: 'apps/upsert' }),
    });
    expect(createStatus).toBe(201);

    // Update same name
    const { status: updateStatus, body } = await apiRaw(`/api/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: '@test/upsert', path: 'apps/upsert-v2', description: 'Updated' }),
    });
    expect(updateStatus).toBe(200);
    expect(body.project.path).toBe('apps/upsert-v2');
    expect(body.project.description).toBe('Updated');
    // Should still be one project, not two
    expect(body.projects).toHaveLength(1);
  }, TIMEOUT);

  test('PUT validates project structure', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/projects`, {
      method: 'PUT',
      body: JSON.stringify({ projects: [{ path: 'no-name' }] }),
    });

    expect(status).toBe(400);
    expect(body.error).toContain('name');
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // Tasks with Project
  // ---------------------------------------------------------------

  test('create task with project field', async () => {
    const mk = marker();
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: `${mk} project task`,
        project: '@test/web',
      }),
    });

    cleanup.trackTask(task.id);
    expect(task.id).toBeTruthy();
    expect(task.project).toBe('@test/web');
  }, TIMEOUT);

  test('update task project via PATCH', async () => {
    const mk = marker();
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: `${mk} patch-project` }),
    });
    cleanup.trackTask(task.id);

    const updated = await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ project: '@test/core' }),
    });

    expect(updated.project).toBe('@test/core');
  }, TIMEOUT);

  test('task project returned in GET', async () => {
    const mk = marker();
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: `${mk} get-project`, project: '@test/api' }),
    });
    cleanup.trackTask(task.id);

    const fetched = await api(`/api/tasks/${task.id}`);
    expect(fetched.project).toBe('@test/api');
  }, TIMEOUT);

  test('clear task project to null', async () => {
    const mk = marker();
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, title: `${mk} clear-project`, project: '@test/web' }),
    });
    cleanup.trackTask(task.id);

    const cleared = await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ project: null }),
    });

    expect(cleared.project).toBeNull();
  }, TIMEOUT);

  // ---------------------------------------------------------------
  // Observations with Project
  // ---------------------------------------------------------------

  test('create observation with project field', async () => {
    const mk = marker();
    const { observation } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: `${mk} project obs`,
        content: `Observation with project ${mk}`,
        project: '@test/web',
      }),
    });
    createdObservationIds.push(observation.id);

    expect(observation.project).toBe('@test/web');
  }, TIMEOUT);

  test('list observations filtered by project', async () => {
    const mk = marker();
    // Create observations with different projects
    const { observation: obs1 } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'pattern',
        title: `${mk} filtered-a`,
        content: `Project filter test A ${mk}`,
        project: `@test/filter-${mk}`,
      }),
    });
    createdObservationIds.push(obs1.id);

    const { observation: obs2 } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'pattern',
        title: `${mk} filtered-b`,
        content: `Project filter test B ${mk}`,
        project: '@test/other',
      }),
    });
    createdObservationIds.push(obs2.id);

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?project=${encodeURIComponent(`@test/filter-${mk}`)}&limit=50`
    );

    expect(observations.some((o: any) => o.id === obs1.id)).toBe(true);
    expect(observations.some((o: any) => o.id === obs2.id)).toBe(false);
  }, TIMEOUT);

  test('search observations filtered by project', async () => {
    const mk = marker();
    const { observation: obs } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'gotcha',
        title: `${mk} search-project`,
        content: `Search project filter ${mk}`,
        project: `@test/search-${mk}`,
      }),
    });
    createdObservationIds.push(obs.id);

    const { results } = await api(
      `/api/workspaces/${workspaceId}/observations/search?query=${encodeURIComponent(mk)}&project=${encodeURIComponent(`@test/search-${mk}`)}`
    );

    expect(results.some((r: any) => r.id === obs.id)).toBe(true);
  }, TIMEOUT);

  test('observations without project filter return all', async () => {
    const mk = marker();
    const { observation: obs1 } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: `${mk} no-filter-a`,
        content: `No filter A ${mk}`,
        project: '@test/a',
      }),
    });
    createdObservationIds.push(obs1.id);

    const { observation: obs2 } = await api(`/api/workspaces/${workspaceId}/observations`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'discovery',
        title: `${mk} no-filter-b`,
        content: `No filter B ${mk}`,
        project: '@test/b',
      }),
    });
    createdObservationIds.push(obs2.id);

    const { observations } = await api(
      `/api/workspaces/${workspaceId}/observations?search=${encodeURIComponent(mk)}&limit=50`
    );

    const ids = observations.map((o: any) => o.id);
    expect(ids).toContain(obs1.id);
    expect(ids).toContain(obs2.id);
  }, TIMEOUT);

  // Clean up projects registry at the end
  afterAll(async () => {
    try {
      await api(`/api/workspaces/${workspaceId}/projects`, {
        method: 'PUT',
        body: JSON.stringify({ projects: [] }),
        retries: 0,
      });
    } catch {}
  });
});
