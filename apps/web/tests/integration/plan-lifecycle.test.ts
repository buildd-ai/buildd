/**
 * Integration test: Plan lifecycle
 *
 * Tests the full plan submission → review → approve/revise flow.
 * Creates a real task in planning mode, claims it, submits a plan,
 * verifies GET returns it, requests revisions, then approves.
 *
 * Does NOT require a running agent — exercises API endpoints directly.
 *
 * Usage:
 *   BUILDD_API_KEY=bld_xxx bun run apps/web/tests/integration/plan-lifecycle.test.ts
 *
 * Env vars:
 *   BUILDD_API_KEY      - required
 *   BUILDD_SERVER       - defaults to https://app.buildd.dev
 *   BUILDD_WORKSPACE_ID - optional, auto-picks first workspace
 */

const SERVER = process.env.BUILDD_SERVER || 'https://app.buildd.dev';
const API_KEY = process.env.BUILDD_API_KEY;

if (!API_KEY) {
  console.log('⏭️  Skipping plan lifecycle test: BUILDD_API_KEY not set');
  process.exit(0);
}

// Track resources for cleanup
let createdTaskId: string | null = null;
let createdWorkerId: string | null = null;

async function api(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`API ${options.method || 'GET'} ${endpoint} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** Returns { status, body } without throwing on non-2xx */
async function apiRaw(endpoint: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...options.headers,
    },
  });
  return { status: res.status, body: await res.json() };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function cleanup() {
  if (createdWorkerId) {
    try {
      await api(`/api/workers/${createdWorkerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', error: 'Plan lifecycle test cleanup' }),
      });
    } catch {}
  }
  if (createdTaskId) {
    try {
      await api(`/api/tasks/${createdTaskId}`, { method: 'DELETE' });
    } catch {}
  }
}

async function run() {
  console.log(`\nPlan Lifecycle Test — ${SERVER}\n`);

  // Step 1: Find a workspace
  let workspaceId = process.env.BUILDD_WORKSPACE_ID;
  if (!workspaceId) {
    console.log('Step 1: Finding workspace...');
    const { workspaces } = await api('/api/workspaces');
    assert(workspaces.length > 0, 'Account has at least one workspace');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})\n`);
  }

  // Step 2: Create a task in planning mode
  console.log('Step 2: Create planning-mode task...');
  const task = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId,
      title: '[INTEG-TEST] Plan lifecycle',
      description: 'Auto-created by plan lifecycle integration test. Safe to delete.',
      mode: 'planning',
    }),
  });
  createdTaskId = task.id;
  assert(!!task.id, `Task created: ${task.id}`);
  assert(task.status === 'pending', 'Task status is pending');
  assert(task.mode === 'planning', 'Task mode is planning');

  // Step 3: Claim the task (creates a worker)
  console.log('\nStep 3: Claim task...');
  const { workers } = await api('/api/workers/claim', {
    method: 'POST',
    body: JSON.stringify({ maxTasks: 1, workspaceId, runner: 'plan-lifecycle-test' }),
  });
  assert(workers.length > 0, 'Claimed a worker');
  const worker = workers[0];
  createdWorkerId = worker.id;
  console.log(`  Worker: ${worker.id}\n`);

  // Set worker to running (simulating agent startup)
  await api(`/api/workers/${worker.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'running', currentAction: 'Analyzing codebase' }),
  });

  // Step 4: GET plan before submission — should return 404
  console.log('Step 4: Verify no plan exists yet...');
  const noPlan = await apiRaw(`/api/workers/${worker.id}/plan`);
  assert(noPlan.status === 404, 'GET /plan returns 404 when no plan exists');
  assert(noPlan.body.error === 'No plan found', 'Error message is "No plan found"');

  // Step 5: Submit a plan
  console.log('\nStep 5: Submit plan...');
  const planContent = '## Implementation Plan\n\n1. Update schema\n2. Add migration\n3. Write tests';
  const submitResult = await api(`/api/workers/${worker.id}/plan`, {
    method: 'POST',
    body: JSON.stringify({ plan: planContent }),
  });
  assert(submitResult.message === 'Plan submitted successfully', 'Plan submitted');
  assert(!!submitResult.artifact, 'Artifact returned');

  // Step 6: Verify worker transitioned to awaiting_plan_approval
  console.log('\nStep 6: Verify worker status...');
  const workerAfterSubmit = await api(`/api/workers/${worker.id}`);
  assert(workerAfterSubmit.status === 'awaiting_plan_approval', 'Worker status is awaiting_plan_approval');

  // Step 7: GET plan — should return the plan
  console.log('\nStep 7: GET plan...');
  const getPlan = await api(`/api/workers/${worker.id}/plan`);
  assert(!!getPlan.plan, 'Plan returned');
  assert(getPlan.plan.content === planContent, 'Plan content matches what was submitted');

  // Step 8: Request revision
  console.log('\nStep 8: Request plan revision...');
  const reviseResult = await api(`/api/workers/${worker.id}/plan/revise`, {
    method: 'POST',
    body: JSON.stringify({ feedback: 'Add error handling steps and rollback plan' }),
  });
  assert(reviseResult.message.includes('Revision request sent'), 'Revision request sent');

  // Worker should be back to running
  const workerAfterRevise = await api(`/api/workers/${worker.id}`);
  assert(workerAfterRevise.status === 'running', 'Worker back to running after revision request');
  assert(!!workerAfterRevise.pendingInstructions, 'Worker has pending instructions with feedback');

  // Step 9: Resubmit updated plan
  console.log('\nStep 9: Resubmit updated plan...');
  const updatedPlanContent = planContent + '\n4. Add error handling\n5. Write rollback migration';
  const resubmit = await api(`/api/workers/${worker.id}/plan`, {
    method: 'POST',
    body: JSON.stringify({ plan: updatedPlanContent }),
  });
  assert(resubmit.message === 'Plan submitted successfully', 'Updated plan submitted');

  // Verify plan was updated (not duplicated)
  const updatedPlan = await api(`/api/workers/${worker.id}/plan`);
  assert(updatedPlan.plan.content === updatedPlanContent, 'Plan content was updated');

  // Step 10: Approve the plan
  console.log('\nStep 10: Approve plan...');
  const approveResult = await api(`/api/workers/${worker.id}/plan/approve`, {
    method: 'POST',
  });
  assert(approveResult.message.includes('Plan approved'), 'Plan approved');

  // Worker should be running again
  const workerAfterApprove = await api(`/api/workers/${worker.id}`);
  assert(workerAfterApprove.status === 'running', 'Worker back to running after approval');

  // Step 11: Verify revision can't happen when not awaiting approval
  console.log('\nStep 11: Verify state guards...');
  const badRevise = await apiRaw(`/api/workers/${worker.id}/plan/revise`, {
    method: 'POST',
    body: JSON.stringify({ feedback: 'Should fail' }),
  });
  assert(badRevise.status === 400, 'Revise rejected when worker is running (not awaiting approval)');

  const badApprove = await apiRaw(`/api/workers/${worker.id}/plan/approve`, {
    method: 'POST',
  });
  assert(badApprove.status === 400, 'Approve rejected when worker is running (not awaiting approval)');

  console.log('\n✅ All plan lifecycle tests passed!\n');
}

run()
  .catch((err) => {
    console.error(`\n❌ Test failed: ${err.message}\n`);
    process.exit(1);
  })
  .finally(cleanup);
