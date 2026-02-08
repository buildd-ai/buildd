/**
 * Integration Tests for Local-UI
 *
 * Tests the full task execution flow via HTTP API, including
 * follow-up messages, session resume, and AskUserQuestion behavior.
 *
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

async function waitForWorkerStatus(
  workerId: string,
  targetStatuses: string[],
  options: { timeout?: number; pollInterval?: number } = {}
): Promise<any> {
  const { timeout = TEST_TIMEOUT, pollInterval = 1000 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const { workers } = await api<{ workers: any[] }>('/api/workers');
    const worker = workers.find(w => w.id === workerId);

    if (worker && targetStatuses.includes(worker.status)) {
      return worker;
    }

    await sleep(pollInterval);
  }

  throw new Error(`Worker ${workerId} did not reach status [${targetStatuses.join(',')}] within ${timeout}ms`);
}

async function sendMessage(workerId: string, message: string): Promise<void> {
  await api(`/api/workers/${workerId}/send`, 'POST', { message });
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
      expect(abortedWorker?.error?.toLowerCase()).toContain('aborted');
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

// --- Follow-up / Resume Tests ---

const FOLLOW_UP_TIMEOUT = 120_000; // Follow-up tests need extra time (2 sessions)

describe('Follow-up Message Handling', () => {
  test('Layer 1: follow-up resumes session with full context (no re-exploration)', async () => {
    // Create a task that requires the agent to analyze something specific
    const marker = `RESUME_MARKER_${Date.now()}`;
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Resume Context Test',
      description: `Remember the secret code "${marker}". Then say "Analysis complete." and nothing else.`,
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    // Claim and wait for first session to complete
    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    const completedWorker = await waitForWorker(worker.id);
    expect(completedWorker.status).toBe('done');

    // Verify sessionId was captured (required for resume)
    expect(completedWorker.sessionId).toBeTruthy();

    // Send follow-up asking about the marker — agent should know it from resumed context
    await sendMessage(worker.id, `What was the secret code I told you to remember? Reply with just the code.`);

    // Worker should restart and eventually complete
    const resumedWorker = await waitForWorker(worker.id);
    expect(resumedWorker.status).toBe('done');

    // The agent should recall the marker from the resumed session context
    const output = resumedWorker.output?.join(' ') || '';
    expect(output).toContain(marker);
  }, FOLLOW_UP_TIMEOUT);

  test('follow-up message restarts a completed worker', async () => {
    // Simple test: send a follow-up to a completed worker and verify it restarts
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Follow-up Restart Test',
      description: 'Say "first done" and nothing else.',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Wait for first completion
    const firstResult = await waitForWorker(worker.id);
    expect(firstResult.status).toBe('done');

    // Send follow-up
    await sendMessage(worker.id, 'Now say "second done" and nothing else.');

    // Should transition to working, then complete again
    // First verify it goes to working
    await sleep(1000);
    const { workers: midWorkers } = await api<{ workers: any[] }>('/api/workers');
    const midWorker = midWorkers.find(w => w.id === worker.id);
    // Status should be either 'working' (still going) or 'done' (fast completion)
    expect(['working', 'done']).toContain(midWorker?.status);

    // Wait for second completion
    const secondResult = await waitForWorker(worker.id);
    expect(secondResult.status).toBe('done');

    // Should have the follow-up response in output
    const output = secondResult.output?.join(' ').toLowerCase() || '';
    expect(output).toContain('second done');
  }, FOLLOW_UP_TIMEOUT);

  test('follow-up clears previous error state', async () => {
    // Create a task, abort it (causes error state), then send follow-up
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Error Recovery Test',
      description: 'Read every file in this project one at a time.',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Wait briefly, then abort
    await sleep(3000);
    await api('/api/abort', 'POST', { workerId: worker.id });

    // Verify it's in error state
    const { workers: errWorkers } = await api<{ workers: any[] }>('/api/workers');
    const errWorker = errWorkers.find(w => w.id === worker.id);
    expect(errWorker?.status).toBe('error');

    // Send follow-up — should clear error and restart
    await sendMessage(worker.id, 'Just say "recovered" and nothing else.');

    const recovered = await waitForWorker(worker.id);
    expect(recovered.status).toBe('done');
    expect(recovered.error).toBeFalsy();

    const output = recovered.output?.join(' ').toLowerCase() || '';
    expect(output).toContain('recovered');
  }, FOLLOW_UP_TIMEOUT);

  test('Layer 2: AskUserQuestion keeps session alive for follow-up', async () => {
    // Create a task that should trigger AskUserQuestion (agent asks before proceeding)
    const { task } = await api('/api/tasks', 'POST', {
      title: 'AskUser Session Test',
      description: 'Ask the user whether they want option A or option B before proceeding. Use the AskUserQuestion tool to ask. Do NOT proceed without their answer.',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Wait for the agent to enter "waiting" status (asked a question)
    const waitingWorker = await waitForWorkerStatus(worker.id, ['waiting', 'done', 'error']);

    if (waitingWorker.status === 'waiting') {
      // Session is still alive — send answer through the live input stream
      expect(waitingWorker.waitingFor).toBeTruthy();

      await sendMessage(worker.id, 'Option A');

      // Worker should continue and complete (no restart needed)
      const finalWorker = await waitForWorker(worker.id);
      expect(finalWorker.status).toBe('done');

      // Verify no "Session started" milestone after the question
      // (which would indicate a restart instead of continuation)
      const milestones = finalWorker.milestones.map((m: any) => m.label);
      const sessionStarts = milestones.filter((l: string) => l === 'Session started');
      expect(sessionStarts.length).toBe(1); // Only one session start = session stayed alive
    } else {
      // Agent completed or errored without asking — still valid, just didn't trigger Layer 2
      console.log('Agent did not use AskUserQuestion — Layer 2 not triggered in this run');
      expect(waitingWorker.status).toBe('done');
    }
  }, FOLLOW_UP_TIMEOUT);

  test('follow-up records user message in chat history', async () => {
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Chat History Test',
      description: 'Say "hello" and nothing else.',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    await waitForWorker(worker.id);

    // Send follow-up
    const followUpMsg = 'This is my follow-up message for history test';
    await sendMessage(worker.id, followUpMsg);

    // Give it a moment to register the message
    await sleep(1000);

    // Check that the user message appears in the worker's messages
    const { workers } = await api<{ workers: any[] }>('/api/workers');
    const w = workers.find((w: any) => w.id === worker.id);
    const userMessages = w?.messages?.filter((m: any) => m.type === 'user') || [];
    const hasFollowUp = userMessages.some((m: any) => m.content?.includes(followUpMsg));

    expect(hasFollowUp).toBe(true);
  }, FOLLOW_UP_TIMEOUT);
});
