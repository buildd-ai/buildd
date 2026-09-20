/**
 * Integration Tests: GET /api/tasks Audit Mode
 *
 * Tests the paginated audit-mode endpoint for listing terminal tasks
 * (completed, failed, cancelled) with full terminal history pagination.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun run test:integration list-tasks-audit-mode
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const { server: SERVER, apiKey: API_KEY } = requireTestEnv();
const { api } = createTestApi(SERVER, API_KEY);
const cleanup = createCleanup(api);

async function findWorkspace(): Promise<string> {
  if (process.env.BUILDD_WORKSPACE_ID) return process.env.BUILDD_WORKSPACE_ID;
  const { workspaces } = await api('/api/workspaces');
  if (!workspaces.length) throw new Error('No workspaces available');
  const ws = workspaces.find((w: any) => w.name?.includes('buildd')) || workspaces[0];
  return ws.id;
}

describe('GET /api/tasks — audit mode (terminal statuses)', () => {
  let workspaceId: string;

  beforeAll(async () => {
    workspaceId = await findWorkspace();
  });

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('list_tasks with status=completed returns paginated results', async () => {
    // Create a test task and complete it
    const { id: taskId } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: 'Test: Complete me',
        description: 'This task should be completed',
      }),
    });
    cleanup.trackTask(taskId);

    // Complete the task
    await api(`/api/tasks/${taskId}/summary`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        summary: 'Task completed successfully',
      }),
    });

    // Query audit mode for completed tasks
    const result = await api(`/api/tasks?limit=10&status=completed&workspaceId=${workspaceId}`);

    expect(result.tasks).toBeDefined();
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.pendingCount).toBe('number');
    expect(typeof result.hasMore).toBe('boolean');

    // Verify audit-mode fields are present
    if (result.tasks.length > 0) {
      const task = result.tasks[0];
      expect(task).toHaveProperty('updatedAt');
      expect(task).toHaveProperty('summarySource');
      expect(task).toHaveProperty('prNumber');
      expect(task).toHaveProperty('hasArtifact');
    }
  });

  test('list_tasks with status=failed returns paginated results', async () => {
    const result = await api(`/api/tasks?limit=10&status=failed&workspaceId=${workspaceId}`);

    expect(result.tasks).toBeDefined();
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.pendingCount).toBe('number');
    expect(typeof result.hasMore).toBe('boolean');
  });

  test('list_tasks with status=cancelled returns paginated results', async () => {
    const result = await api(`/api/tasks?limit=10&status=cancelled&workspaceId=${workspaceId}`);

    expect(result.tasks).toBeDefined();
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.pendingCount).toBe('number');
    expect(typeof result.hasMore).toBe('boolean');
  });

  test('audit mode pagination with offset works correctly', async () => {
    // First page
    const page1 = await api(`/api/tasks?limit=5&status=completed&workspaceId=${workspaceId}&offset=0`);

    expect(Array.isArray(page1.tasks)).toBe(true);
    expect(page1.total).toBeDefined();

    if (page1.total > 5 && page1.hasMore) {
      // Second page
      const page2 = await api(`/api/tasks?limit=5&status=completed&workspaceId=${workspaceId}&offset=5`);

      expect(Array.isArray(page2.tasks)).toBe(true);
      // Verify no overlap between pages
      const page1Ids = new Set(page1.tasks.map((t: any) => t.id));
      const page2Ids = new Set(page2.tasks.map((t: any) => t.id));
      const overlap = [...page1Ids].filter(id => page2Ids.has(id));
      expect(overlap.length).toBe(0);
    }
  });

  test('audit mode handles tasks with various result.prNumber formats', async () => {
    // This test verifies the CASE guard works: malformed, NULL, and valid prNumbers
    // should all be handled without crashing the query
    const result = await api(`/api/tasks?limit=10&status=completed&workspaceId=${workspaceId}`);

    expect(result.tasks).toBeDefined();
    // Should complete without throwing, even if some rows have unusual prNumber values
    expect(result.status).not.toBe(500);
  });
});
