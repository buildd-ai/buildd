/**
 * Integration test: Worker waiting_input flow
 *
 * Tests that workers can report waiting_input status with waitingFor data,
 * and that it auto-clears when the worker resumes.
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/worker-state-machine.test.ts
 */

import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server, apiKey } = requireTestEnv();
const { api, apiRaw } = createTestApi(server, apiKey);
const cleanup = createCleanup(api);

describe('Worker State Machine', () => {
  let workspaceId: string;
  let workerId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})`);

    // Create a test task and claim it
    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: '[INTEG-TEST] Worker waitingFor flow',
        description: 'Auto-created by integration test. Safe to delete.',
      }),
    });
    cleanup.trackTask(task.id);

    const { workers } = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ maxTasks: 1, workspaceId, runner: 'test' }),
    });
    if (!workers.length) throw new Error('Failed to claim a worker');
    workerId = workers[0].id;
    cleanup.trackWorker(workerId);
    console.log(`  Worker: ${workerId}`);
  });

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('should set worker to running', async () => {
    const running = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', currentAction: 'Integration test running', progress: 10 }),
    });
    expect(running.status).toBe('running');
    expect(running.waitingFor).toBeNull();
  }, TIMEOUT);

  test('should set waiting_input with waitingFor data', async () => {
    const waiting = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'waiting_input',
        currentAction: 'Auth method',
        waitingFor: {
          type: 'question',
          prompt: 'Which authentication method should we use?',
          options: ['JWT tokens', 'Session cookies', 'OAuth2'],
        },
      }),
    });
    expect(waiting.status).toBe('waiting_input');
    expect(waiting.waitingFor).not.toBeNull();
    expect(waiting.waitingFor.type).toBe('question');
    expect(waiting.waitingFor.prompt).toBe('Which authentication method should we use?');
    expect(waiting.waitingFor.options).toHaveLength(3);
  }, TIMEOUT);

  test('should return waitingFor via GET', async () => {
    const fetched = await api(`/api/workers/${workerId}`);
    expect(fetched.status).toBe('waiting_input');
    expect(fetched.waitingFor?.prompt).toBe('Which authentication method should we use?');
  }, TIMEOUT);

  test('should auto-clear waitingFor on resume', async () => {
    const resumed = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', currentAction: 'User chose JWT' }),
    });
    expect(resumed.status).toBe('running');
    expect(resumed.waitingFor).toBeNull();

    // Verify via GET
    const cleared = await api(`/api/workers/${workerId}`);
    expect(cleared.waitingFor).toBeNull();
  }, TIMEOUT);

  test('should clear waitingFor with explicit null', async () => {
    // Set waiting again
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'waiting_input',
        waitingFor: { type: 'confirmation', prompt: 'Ready to deploy?' },
      }),
    });

    // Explicitly clear
    const explicitClear = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', waitingFor: null }),
    });
    expect(explicitClear.waitingFor).toBeNull();
  }, TIMEOUT);
});
