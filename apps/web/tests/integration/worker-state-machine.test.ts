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

const { server, apiKey } = requireTestEnv();
const { api } = createTestApi(server, apiKey);
const cleanup = createCleanup(api);

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function run() {
  console.log(`\nTesting against: ${server}\n`);

  // Step 1: Find a workspace
  let workspaceId = process.env.BUILDD_WORKSPACE_ID;
  if (!workspaceId) {
    console.log('Step 1: Finding workspace...');
    const { workspaces } = await api('/api/workspaces');
    assert(workspaces.length > 0, 'Account has at least one workspace');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})\n`);
  }

  // Step 2: Create a test task
  console.log('Step 2: Create test task...');
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      title: '[INTEG-TEST] Worker waitingFor flow',
      description: 'Auto-created by integration test. Safe to delete.',
    }),
  });
  cleanup.trackTask(task.id);
  assert(!!task.id, `Task created: ${task.id}`);
  assert(task.status === 'pending', `Task status is pending`);

  // Step 3: Claim the task
  console.log('\nStep 3: Claim task...');
  const { workers } = await api('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({ maxTasks: 1, workspaceId, runner: 'test' }),
  });
  assert(workers.length > 0, 'Claimed a worker');
  // The claim might pick a different task if others are pending - find ours or use whatever was claimed
  const worker = workers[0];
  cleanup.trackWorker(worker.id);
  console.log(`  Worker: ${worker.id}, Task: ${worker.task.title}\n`);

  // Step 4: Set worker to running
  console.log('Step 4: Set worker to running...');
  const running = await api(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'running', currentAction: 'Integration test running', progress: 10 }),
  });
  assert(running.status === 'running', 'Worker status is running');
  assert(running.waitingFor === null, 'waitingFor is null when running');

  // Step 5: Set worker to waiting_input with waitingFor data
  console.log('\nStep 5: Set worker to waiting_input with waitingFor...');
  const waiting = await api(`/api/workers/${worker.id}`, {
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
  assert(waiting.status === 'waiting_input', 'Worker status is waiting_input');
  assert(waiting.waitingFor !== null, 'waitingFor is not null');
  assert(waiting.waitingFor.type === 'question', 'waitingFor.type is question');
  assert(waiting.waitingFor.prompt === 'Which authentication method should we use?', 'waitingFor.prompt matches');
  assert(Array.isArray(waiting.waitingFor.options) && waiting.waitingFor.options.length === 3, 'waitingFor.options has 3 items');

  // Step 6: Verify via GET
  console.log('\nStep 6: Verify via GET...');
  const fetched = await api(`/api/workers/${worker.id}`);
  assert(fetched.status === 'waiting_input', 'GET returns waiting_input status');
  assert(fetched.waitingFor?.prompt === 'Which authentication method should we use?', 'GET returns waitingFor data');

  // Step 7: Resume worker - waitingFor should auto-clear
  console.log('\nStep 7: Resume worker (auto-clear waitingFor)...');
  const resumed = await api(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'running', currentAction: 'User chose JWT' }),
  });
  assert(resumed.status === 'running', 'Worker status back to running');
  assert(resumed.waitingFor === null, 'waitingFor auto-cleared on resume');

  // Step 8: Verify cleared via GET
  console.log('\nStep 8: Verify cleared via GET...');
  const cleared = await api(`/api/workers/${worker.id}`);
  assert(cleared.waitingFor === null, 'GET confirms waitingFor cleared');

  // Step 9: Test explicit waitingFor: null
  console.log('\nStep 9: Set waiting again, then explicitly clear...');
  await api(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'waiting_input',
      waitingFor: { type: 'confirmation', prompt: 'Ready to deploy?' },
    }),
  });
  const explicitClear = await api(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'running', waitingFor: null }),
  });
  assert(explicitClear.waitingFor === null, 'Explicit waitingFor: null clears it');

  console.log('\n All tests passed!\n');
}

run()
  .catch((err) => {
    console.error(`\nTest failed: ${err.message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });
