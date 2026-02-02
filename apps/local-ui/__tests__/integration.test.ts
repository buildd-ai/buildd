/**
 * Integration Tests for Local-UI
 *
 * Tests the full task execution flow via HTTP API.
 * Requires: local-ui running on port 8766
 *
 * Run: bun test:integration
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const BASE_URL = process.env.LOCAL_UI_URL || 'http://localhost:8766';
const TEST_TIMEOUT = 60_000;

// Track resources for cleanup
const createdTaskIds: string[] = [];
const createdWorkerIds: string[] = [];

// --- API Helpers ---

async function api<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`API ${method} ${path} failed: ${res.status} ${JSON.stringify(error)}`);
  }

  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForWorker(
  workerId: string,
  options: { timeout?: number; pollInterval?: number } = {}
): Promise<any> {
  const { timeout = TEST_TIMEOUT, pollInterval = 1000 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const { workers } = await api<{ workers: any[] }>('/api/workers');
    const worker = workers.find(w => w.id === workerId);

    if (worker?.status === 'done' || worker?.status === 'error') {
      return worker;
    }

    await sleep(pollInterval);
  }

  throw new Error(`Worker ${workerId} did not complete within ${timeout}ms`);
}

// --- Test Setup ---

let testWorkspaceId: string;

beforeAll(async () => {
  // Verify server is running
  try {
    const config = await api<{ configured: boolean; hasClaudeCredentials: boolean }>('/api/config');
    if (!config.hasClaudeCredentials) {
      throw new Error('No Claude credentials configured');
    }
  } catch (err: any) {
    if (err.message?.includes('fetch failed')) {
      throw new Error(`Local-UI not running at ${BASE_URL}. Start with: bun run dev`);
    }
    throw err;
  }

  // Get a workspace for testing
  const { workspaces } = await api<{ workspaces: any[] }>('/api/workspaces');
  if (workspaces.length === 0) {
    throw new Error('No workspaces available for testing');
  }

  // Prefer buildd workspace for consistent testing
  const workspace = workspaces.find(w => w.name?.includes('buildd')) || workspaces[0];
  testWorkspaceId = workspace.id;
  console.log(`Using workspace: ${workspace.name} (${testWorkspaceId})`);
});

afterAll(async () => {
  // Cleanup: abort any running workers
  for (const workerId of createdWorkerIds) {
    try {
      await api('/api/abort', 'POST', { workerId });
    } catch {
      // Ignore - worker may already be done
    }
  }
});

// --- Tests ---

describe('Local-UI Integration', () => {
  describe('Health & Config', () => {
    test('server is running and configured', async () => {
      const config = await api('/api/config');

      expect(config.configured).toBe(true);
      expect(config.hasClaudeCredentials).toBe(true);
    });

    test('workspaces are available', async () => {
      const { workspaces } = await api('/api/workspaces');

      expect(Array.isArray(workspaces)).toBe(true);
      expect(workspaces.length).toBeGreaterThan(0);
    });

    test('tasks endpoint works', async () => {
      const { tasks } = await api('/api/tasks');

      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe('Task Execution', () => {
    test('creates and executes a simple task', async () => {
      const marker = `TEST_${Date.now()}`;

      // Create task
      const { task } = await api('/api/tasks', 'POST', {
        title: 'Integration Test',
        description: `Reply with exactly: "${marker}". Nothing else.`,
        workspaceId: testWorkspaceId,
      });
      createdTaskIds.push(task.id);
      expect(task.id).toBeTruthy();

      // Claim and start
      const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
      createdWorkerIds.push(worker.id);
      expect(worker.status).toBe('working');

      // Wait for completion
      const finalWorker = await waitForWorker(worker.id);

      expect(finalWorker.status).toBe('done');
      expect(finalWorker.output).toContain(marker);
      expect(finalWorker.milestones.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);

    test('worker can be aborted', async () => {
      // Create a task that would take a while
      const { task } = await api('/api/tasks', 'POST', {
        title: 'Abort Test',
        description: 'Count from 1 to 100, one number per line, slowly.',
        workspaceId: testWorkspaceId,
      });
      createdTaskIds.push(task.id);

      // Start it
      const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
      createdWorkerIds.push(worker.id);

      // Wait briefly then abort
      await sleep(2000);
      await api('/api/abort', 'POST', { workerId: worker.id });

      // Verify aborted
      const { workers } = await api('/api/workers');
      const abortedWorker = workers.find((w: any) => w.id === worker.id);

      expect(abortedWorker?.status).toBe('error');
      expect(abortedWorker?.error).toContain('Aborted');
    }, TEST_TIMEOUT);
  });

  describe('CLAUDE.md Loading', () => {
    test('agent has access to project context', async () => {
      // This test verifies settingSources: ['project'] works
      const { task } = await api('/api/tasks', 'POST', {
        title: 'Context Test',
        description: 'What is the primary stack used in this project? Reply in 10 words or less.',
        workspaceId: testWorkspaceId,
      });
      createdTaskIds.push(task.id);

      const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
      createdWorkerIds.push(worker.id);

      const finalWorker = await waitForWorker(worker.id);

      expect(finalWorker.status).toBe('done');
      // If CLAUDE.md is loaded, agent should know about Next.js/Drizzle/etc
      const output = finalWorker.output?.join(' ').toLowerCase() || '';
      const hasProjectContext =
        output.includes('next') ||
        output.includes('drizzle') ||
        output.includes('postgres') ||
        output.includes('turborepo') ||
        output.includes('monorepo');

      expect(hasProjectContext).toBe(true);
    }, TEST_TIMEOUT);
  });
});

// --- Edge Cases (Educational) ---

describe('Edge Cases', () => {
  test('handles missing workspace gracefully', async () => {
    try {
      await api('/api/tasks', 'POST', {
        title: 'Invalid Workspace',
        description: 'Test',
        workspaceId: 'non-existent-id',
      });
      // If we get here, the API accepted it (may fail at claim time)
    } catch (err: any) {
      // Expected: API should reject invalid workspace
      expect(err.message).toContain('400');
    }
  });

  test('handles empty description', async () => {
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Empty Description Test',
      description: '',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    // Should use title as prompt
    expect(task.id).toBeTruthy();
  });

  test('claim returns error for already-claimed task', async () => {
    // Create and claim a task
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Double Claim Test',
      description: 'Say ok',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Try to claim again - should fail or return same worker
    try {
      const result = await api('/api/claim', 'POST', { taskId: task.id });
      // If it succeeds, it should be the same worker or empty
      expect(result.worker?.id === worker.id || !result.worker).toBe(true);
    } catch (err: any) {
      // Expected: task already claimed
      expect(err.message).toMatch(/claimed|running|400/i);
    }
  }, TEST_TIMEOUT);
});
