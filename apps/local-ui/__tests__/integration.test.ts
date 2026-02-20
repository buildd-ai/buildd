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

// Require BUILDD_TEST_SERVER to be set — prevents accidental production hits
if (!process.env.BUILDD_TEST_SERVER) {
  console.log(
    '⏭️  Skipping: BUILDD_TEST_SERVER not set.\n' +
    '   Set it to a preview/local URL to run integration tests.\n' +
    '   Example: BUILDD_TEST_SERVER=http://localhost:3000 bun test:integration',
  );
  process.exit(0);
}

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
let originalServer: string | null = null;

beforeAll(async () => {
  // Verify server is running
  try {
    const config = await api<{ configured: boolean; hasClaudeCredentials: boolean; builddServer?: string }>('/api/config');
    if (!config.hasClaudeCredentials) {
      throw new Error('No Claude credentials configured');
    }

    // Repoint local-ui to the test server if needed
    originalServer = config.builddServer || null;
    const testServer = process.env.BUILDD_TEST_SERVER!;
    if (config.builddServer !== testServer) {
      console.log(`Repointing local-ui: ${config.builddServer} → ${testServer}`);
      await api('/api/config/server', 'POST', { server: testServer });
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

  // Cleanup: delete test tasks from the server
  for (const taskId of createdTaskIds) {
    try {
      await api(`/api/tasks/${taskId}`, 'DELETE');
    } catch {
      // Ignore - task may already be deleted
    }
  }

  // Restore original server URL
  if (originalServer) {
    try {
      await api('/api/config/server', 'POST', { server: originalServer });
      console.log(`Restored local-ui server → ${originalServer}`);
    } catch { /* best effort */ }
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

// --- Agent Teams & P2P Endpoints ---

const TEAM_TIMEOUT = 180_000; // Teams need extra time (multi-agent coordination)

describe('Agent Teams (Dogfood)', () => {
  test('agent can spawn a team and team state is accessible via P2P endpoint', async () => {
    // This test verifies the full flow:
    // 1. Agent receives a task that encourages team usage
    // 2. Agent uses TeamCreate to create a team
    // 3. Agent spawns subagents via Task tool
    // 4. worker.teamState gets populated via PostToolUse hook
    // 5. GET /api/workers/{id}/team returns the team state
    //
    // Note: Whether the agent actually uses TeamCreate depends on the model's
    // judgment. We prompt it strongly but can't guarantee it.
    // If it doesn't use teams, the test verifies graceful degradation.

    const { task } = await api('/api/tasks', 'POST', {
      title: 'Team Test: Multi-agent research',
      description: [
        'You MUST use the TeamCreate tool to create a team called "research-team".',
        'Then use the Task tool to spawn one subagent named "explorer" with subagent_type "Explore" to search for README files.',
        'After spawning the subagent, use SendMessage to send a broadcast saying "Task started".',
        'Then say "Team setup complete" and finish.',
        '',
        'IMPORTANT: You MUST call TeamCreate, Task, and SendMessage tools. Do not skip any of these steps.',
      ].join('\n'),
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    // Wait for completion
    const finalWorker = await waitForWorker(worker.id, { timeout: TEAM_TIMEOUT });

    // Check if the agent used team tools
    if (finalWorker.teamState) {
      // Team was created — verify full P2P flow
      expect(finalWorker.teamState.teamName).toBeTruthy();

      // Test P2P endpoint
      const teamRes = await fetch(`${BASE_URL}/api/workers/${worker.id}/team`);
      expect(teamRes.ok).toBe(true);
      const teamData = await teamRes.json();
      expect(teamData.team).toBeDefined();
      expect(teamData.team.teamName).toBe(finalWorker.teamState.teamName);

      // If subagents were spawned, verify members
      if (teamData.team.members?.length > 0) {
        expect(teamData.team.members[0].name).toBeTruthy();
        expect(teamData.team.members[0].spawnedAt).toBeGreaterThan(0);
      }

      // If messages were sent, verify messages array
      if (teamData.team.messages?.length > 0) {
        expect(teamData.team.messages[0].content).toBeTruthy();
        expect(teamData.team.messages[0].timestamp).toBeGreaterThan(0);
      }

      // Verify milestones include team events
      const milestoneLabels = finalWorker.milestones.map((m: any) => m.label);
      const hasTeamMilestone = milestoneLabels.some(
        (l: string) => l.includes('Team created') || l.includes('Subagent')
      );
      expect(hasTeamMilestone).toBe(true);

      console.log(`  Team: ${teamData.team.teamName}`);
      console.log(`  Members: ${teamData.team.members?.length || 0}`);
      console.log(`  Messages: ${teamData.team.messages?.length || 0}`);
    } else {
      // Agent didn't use team tools — check that P2P endpoint returns null gracefully
      const teamRes = await fetch(`${BASE_URL}/api/workers/${worker.id}/team`);
      expect(teamRes.ok).toBe(true);
      const teamData = await teamRes.json();
      expect(teamData.team).toBeNull();
      console.log('  Agent did not use TeamCreate — graceful degradation verified');
    }
  }, TEAM_TIMEOUT);

  test('trace endpoint returns tool calls and messages', async () => {
    // Create a simple task that generates tool calls
    const { task } = await api('/api/tasks', 'POST', {
      title: 'Trace Endpoint Test',
      description: 'Read the file package.json in the current directory. Then say "done".',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    const finalWorker = await waitForWorker(worker.id);
    expect(finalWorker.status).toBe('done');

    // Test trace endpoint
    const traceRes = await fetch(`${BASE_URL}/api/workers/${worker.id}/trace`);
    expect(traceRes.ok).toBe(true);
    const traceData = await traceRes.json();

    expect(Array.isArray(traceData.toolCalls)).toBe(true);
    expect(Array.isArray(traceData.messages)).toBe(true);

    // Should have at least some tool calls (Read at minimum)
    expect(traceData.toolCalls.length).toBeGreaterThan(0);

    // Should have messages (at least assistant text)
    expect(traceData.messages.length).toBeGreaterThan(0);

    // Verify structure
    const firstToolCall = traceData.toolCalls[0];
    expect(firstToolCall.name).toBeTruthy();
    expect(firstToolCall.timestamp).toBeGreaterThan(0);

    console.log(`  Tool calls: ${traceData.toolCalls.length}`);
    console.log(`  Messages: ${traceData.messages.length}`);
  }, TEST_TIMEOUT);

  test('team endpoint returns null for worker without team', async () => {
    // Simple task — no team usage expected
    const { task } = await api('/api/tasks', 'POST', {
      title: 'No Team Test',
      description: 'Say "hello" and nothing else. Do not create any teams.',
      workspaceId: testWorkspaceId,
    });
    createdTaskIds.push(task.id);

    const { worker } = await api('/api/claim', 'POST', { taskId: task.id });
    createdWorkerIds.push(worker.id);

    const finalWorker = await waitForWorker(worker.id);
    expect(finalWorker.status).toBe('done');

    // Team endpoint should return null
    const teamRes = await fetch(`${BASE_URL}/api/workers/${worker.id}/team`);
    expect(teamRes.ok).toBe(true);
    const teamData = await teamRes.json();
    expect(teamData.team).toBeNull();
  }, TEST_TIMEOUT);
});
