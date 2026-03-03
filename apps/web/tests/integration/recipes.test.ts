/**
 * Integration test: Recipe CRUD + execution
 *
 * Tests:
 *   1. List recipes (initially empty)
 *   2. Create a recipe with steps + dependencies
 *   3. Validate step validation (missing ref, duplicate ref, bad dependsOn)
 *   4. Get single recipe
 *   5. Update recipe
 *   6. Run recipe → creates tasks with resolved dependencies
 *   7. Delete recipe
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (admin-level key)
 *
 * Usage:
 *   bun test apps/web/tests/integration/recipes.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server, apiKey } = requireTestEnv();
const { api, apiRaw } = createTestApi(server, apiKey);
const cleanup = createCleanup(api);

describe('Recipe CRUD', () => {
  let workspaceId: string;
  let recipeId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})`);
  }, TIMEOUT);

  afterAll(async () => {
    // Clean up recipe if it still exists
    if (recipeId) {
      await api(`/api/workspaces/${workspaceId}/recipes/${recipeId}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('GET recipes returns empty or existing list', async () => {
    const { recipes } = await api(`/api/workspaces/${workspaceId}/recipes`);
    expect(Array.isArray(recipes)).toBe(true);
  }, TIMEOUT);

  test('POST recipe requires name and steps', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Missing steps' }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('steps');
  }, TIMEOUT);

  test('POST recipe rejects empty steps array', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Empty', steps: [] }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('at least 1');
  }, TIMEOUT);

  test('POST recipe rejects steps without ref', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad step',
        steps: [{ title: 'No ref here' }],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('ref and title');
  }, TIMEOUT);

  test('POST recipe rejects duplicate step refs', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Dup refs',
        steps: [
          { ref: 'step1', title: 'First' },
          { ref: 'step1', title: 'Duplicate' },
        ],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('Duplicate step ref');
  }, TIMEOUT);

  test('POST recipe rejects unknown dependsOn ref', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad dep',
        steps: [
          { ref: 'step1', title: 'First' },
          { ref: 'step2', title: 'Second', dependsOn: ['nonexistent'] },
        ],
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('unknown ref');
  }, TIMEOUT);

  test('POST recipe creates valid recipe', async () => {
    const { recipe } = await api(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({
        name: '[INTEG-TEST] Deploy Pipeline',
        description: 'Auto-created by integration test. Safe to delete.',
        category: 'ops',
        steps: [
          { ref: 'build', title: 'Build {{project}}', description: 'Compile the project' },
          { ref: 'test', title: 'Test {{project}}', dependsOn: ['build'] },
          { ref: 'deploy', title: 'Deploy {{project}} to {{env}}', dependsOn: ['test'] },
        ],
        variables: { project: '', env: 'staging' },
      }),
    });

    expect(recipe.id).toBeTruthy();
    expect(recipe.name).toBe('[INTEG-TEST] Deploy Pipeline');
    expect(recipe.category).toBe('ops');
    expect(recipe.steps).toHaveLength(3);
    recipeId = recipe.id;
  }, TIMEOUT);

  test('GET single recipe returns created recipe', async () => {
    const { recipe } = await api(`/api/workspaces/${workspaceId}/recipes/${recipeId}`);
    expect(recipe.id).toBe(recipeId);
    expect(recipe.name).toBe('[INTEG-TEST] Deploy Pipeline');
    expect(recipe.steps).toHaveLength(3);
  }, TIMEOUT);

  test('GET nonexistent recipe returns 404', async () => {
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/recipes/00000000-0000-0000-0000-000000000000`);
    expect(status).toBe(404);
  }, TIMEOUT);

  test('PATCH recipe updates name and description', async () => {
    const { recipe } = await api(`/api/workspaces/${workspaceId}/recipes/${recipeId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: '[INTEG-TEST] Updated Pipeline',
        description: 'Updated description',
      }),
    });
    expect(recipe.name).toBe('[INTEG-TEST] Updated Pipeline');
    expect(recipe.description).toBe('Updated description');
    expect(recipe.steps).toHaveLength(3); // unchanged
  }, TIMEOUT);

  test('PATCH recipe rejects empty steps', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes/${recipeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ steps: [] }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('non-empty');
  }, TIMEOUT);
});

describe('Recipe Execution', () => {
  let workspaceId: string;
  let recipeId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;

    // Create a recipe to run
    const { recipe } = await api(`/api/workspaces/${workspaceId}/recipes`, {
      method: 'POST',
      body: JSON.stringify({
        name: '[INTEG-TEST] Run Recipe',
        description: 'Auto-created for execution test. Safe to delete.',
        steps: [
          { ref: 'research', title: 'Research {{topic}}' },
          { ref: 'write', title: 'Write about {{topic}}', dependsOn: ['research'] },
        ],
        variables: { topic: '' },
      }),
    });
    recipeId = recipe.id;
  }, TIMEOUT);

  afterAll(async () => {
    // Clean up recipe
    if (recipeId) {
      await api(`/api/workspaces/${workspaceId}/recipes/${recipeId}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('POST run recipe creates tasks with interpolated titles', async () => {
    const { tasks: taskIds } = await api(`/api/workspaces/${workspaceId}/recipes/${recipeId}/run`, {
      method: 'POST',
      body: JSON.stringify({
        variables: { topic: 'AI agents' },
      }),
    });

    expect(Array.isArray(taskIds)).toBe(true);
    expect(taskIds).toHaveLength(2);

    // Track for cleanup
    for (const tid of taskIds) {
      cleanup.trackTask(tid);
    }

    // Verify first task title was interpolated
    const task1 = await api(`/api/tasks/${taskIds[0]}`);
    expect(task1.title).toBe('Research AI agents');

    // Verify second task has dependency on first
    const task2 = await api(`/api/tasks/${taskIds[1]}`);
    expect(task2.title).toBe('Write about AI agents');
    expect(task2.dependsOn).toContain(taskIds[0]);
  }, TIMEOUT);

  test('POST run nonexistent recipe returns 404', async () => {
    const { status } = await apiRaw(`/api/workspaces/${workspaceId}/recipes/00000000-0000-0000-0000-000000000000/run`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(status).toBe(404);
  }, TIMEOUT);

  test('DELETE recipe succeeds', async () => {
    const { status, body } = await apiRaw(`/api/workspaces/${workspaceId}/recipes/${recipeId}`, {
      method: 'DELETE',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify it's gone
    const { status: getStatus } = await apiRaw(`/api/workspaces/${workspaceId}/recipes/${recipeId}`);
    expect(getStatus).toBe(404);

    recipeId = ''; // prevent afterAll double-delete
  }, TIMEOUT);
});
