/**
 * Integration Tests for Local-UI (API-only)
 *
 * Tests health, config, and edge cases via HTTP API.
 * Does NOT require a Claude agent — agent-driven tests live in test:dogfood.
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

});

// --- Skill Scanning ---

describe('Skill Scanning', () => {
  test('scan returns skills array (may be empty if no .claude/skills/ exists)', async () => {
    const data = await api('/api/skills/scan', 'POST', {
      workspaceId: testWorkspaceId,
    });

    expect(Array.isArray(data.skills)).toBe(true);
    // Each skill should have required fields
    for (const skill of data.skills) {
      expect(skill.slug).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(typeof skill.content).toBe('string');
      expect(typeof skill.path).toBe('string');
      expect(['new', 'modified', 'registered']).toContain(skill.status);
    }
  });

  test('scan fails with missing workspaceId', async () => {
    try {
      await api('/api/skills/scan', 'POST', {});
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toMatch(/400/);
    }
  });

  test('scan fails with invalid workspaceId', async () => {
    try {
      await api('/api/skills/scan', 'POST', {
        workspaceId: 'non-existent-workspace-id',
      });
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toMatch(/404/);
    }
  });

  test('register fails with missing required fields', async () => {
    try {
      await api('/api/skills/register', 'POST', {
        workspaceId: testWorkspaceId,
        // Missing slug, name, content
      });
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toMatch(/400/);
    }
  });

  test('register creates skill with source=local_scan and enabled=false', async () => {
    const uniqueSlug = `test-scan-${Date.now()}`;
    try {
      const data = await api('/api/skills/register', 'POST', {
        workspaceId: testWorkspaceId,
        slug: uniqueSlug,
        name: 'Integration Test Skill',
        description: 'Created by integration test',
        content: '# Test\n\nThis is a test skill.',
      });

      expect(data.skill).toBeTruthy();
      expect(data.skill.slug).toBe(uniqueSlug);
      expect(data.skill.source).toBe('local_scan');
      expect(data.skill.enabled).toBe(false);
    } catch (err: any) {
      // 409 is acceptable if slug already exists from previous test run
      if (!err.message?.includes('409')) {
        throw err;
      }
    }
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
      // Expected: API should reject invalid workspace (400 from server, 502 from proxy)
      expect(err.message).toMatch(/400|500|502/);
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

  test('second claim does not return same task', async () => {
    // Create a single task and claim it
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Double Claim Test',
      description: 'Say ok',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Try to claim again — should either fail (no pending tasks) or return a different task
    try {
      const result = await api('/api/claim', 'POST', { taskId: task.id });
      // If it succeeds, the worker should NOT be for the same task (already claimed)
      if (result.worker) {
        createdWorkerIds.push(result.worker.id);
        expect(result.worker.taskId).not.toBe(task.id);
      }
    } catch {
      // Expected: no tasks to claim or failed
    }
  }, TEST_TIMEOUT);
});
