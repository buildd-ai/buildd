/**
 * Integration test: Artifact lifecycle + PR-or-artifact enforcement
 *
 * Tests:
 *   1. Creating artifacts for a worker via POST /api/workers/[id]/artifacts
 *   2. Listing artifacts via GET /api/workers/[id]/artifacts
 *   3. Enforcement: completing a worker with commits but no PR or artifact → 400
 *   4. Completing a worker with an artifact succeeds
 *   5. Plan artifact (task_plan type) satisfies the artifact requirement
 *
 * Prerequisites:
 *   - BUILDD_TEST_SERVER set (preview or local URL)
 *   - BUILDD_API_KEY set (or in ~/.buildd/config.json)
 *
 * Usage:
 *   bun test apps/web/tests/integration/artifacts.test.ts
 */

import { describe, test, beforeAll, afterAll, expect } from 'bun:test';
import { requireTestEnv, createTestApi, createCleanup } from '../../../../tests/test-utils';

const TIMEOUT = 30_000;

const { server, apiKey } = requireTestEnv();
const { api, apiRaw } = createTestApi(server, apiKey);
const cleanup = createCleanup(api);

describe('Artifact Lifecycle', () => {
  let workspaceId: string;
  let workerId: string;
  let taskId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;
    console.log(`  Using workspace: ${workspaces[0].name} (${workspaceId})`);

    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: '[INTEG-TEST] Artifact lifecycle',
        description: 'Auto-created by integration test. Safe to delete.',
      }),
    });
    taskId = task.id;
    cleanup.trackTask(task.id);

    const { workers } = await api('/api/workers/claim', {
      method: 'POST',
      body: JSON.stringify({ maxTasks: 1, workspaceId, runner: 'test' }),
    });
    if (!workers.length) throw new Error('Failed to claim a worker');
    workerId = workers[0].id;
    cleanup.trackWorker(workerId);
    console.log(`  Worker: ${workerId}`);

    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', progress: 10 }),
    });
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('GET artifacts returns empty list initially', async () => {
    const { artifacts } = await api(`/api/workers/${workerId}/artifacts`);
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts.length).toBe(0);
  }, TIMEOUT);

  test('POST artifact creates a content artifact', async () => {
    const { artifact } = await api(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'content',
        title: 'Test Report',
        content: 'This is the artifact content from the integration test.',
      }),
    });

    expect(artifact.id).toBeTruthy();
    expect(artifact.type).toBe('content');
    expect(artifact.title).toBe('Test Report');
    expect(artifact.content).toBe('This is the artifact content from the integration test.');
    expect(artifact.shareUrl).toBeTruthy();
    expect(artifact.shareToken).toBeTruthy();
  }, TIMEOUT);

  test('GET artifacts returns created artifact', async () => {
    const { artifacts } = await api(`/api/workers/${workerId}/artifacts`);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].type).toBe('content');
    expect(artifacts[0].title).toBe('Test Report');
  }, TIMEOUT);

  test('POST rejects invalid artifact type', async () => {
    const { status, body } = await apiRaw(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'task_plan',
        title: 'Should fail',
        content: 'Workers cannot create plan artifacts directly',
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('Invalid type');
  }, TIMEOUT);

  test('POST link artifact requires url', async () => {
    const { status, body } = await apiRaw(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'link',
        title: 'A link without url',
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('url is required');
  }, TIMEOUT);

  test('POST link artifact with url succeeds', async () => {
    const { artifact } = await api(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'link',
        title: 'External resource',
        url: 'https://example.com/result',
      }),
    });
    expect(artifact.type).toBe('link');
    expect(artifact.metadata?.url).toBe('https://example.com/result');
  }, TIMEOUT);

  test('completing worker with artifact succeeds', async () => {
    const updated = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', summary: 'Artifacts created and verified.' }),
    });
    expect(updated.status).toBe('completed');
  }, TIMEOUT);

  test('completed task has result captured', async () => {
    const task = await api(`/api/tasks/${taskId}`).catch(async () => {
      const { tasks } = await api('/api/tasks');
      return tasks?.find((t: any) => t.id === taskId);
    });
    expect(task.status).toBe('completed');
    expect(task.result).toBeTruthy();
  }, TIMEOUT);
});

describe('PR-or-Artifact Enforcement', () => {
  let workspaceId: string;
  let workerId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;

    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: '[INTEG-TEST] Enforcement — commits with no output',
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

    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', commitCount: 3, progress: 80 }),
    });
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('completing with commits but no PR or artifact is rejected with 400', async () => {
    const { status, body } = await apiRaw(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        summary: 'Done (but forgot to create PR or artifact)',
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toContain('commit');
    expect(body.hint).toBe('create_pr or create_artifact');
  }, TIMEOUT);

  test('completing after creating artifact succeeds', async () => {
    await api(`/api/workers/${workerId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'summary',
        title: 'Work Summary',
        content: 'Completed the implementation with 3 commits.',
      }),
    });

    const updated = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        summary: 'Done — artifact created.',
      }),
    });
    expect(updated.status).toBe('completed');
  }, TIMEOUT);
});

describe('Plan as Artifact', () => {
  let workspaceId: string;
  let workerId: string;

  beforeAll(async () => {
    const { workspaces } = await api('/api/workspaces');
    if (!workspaces.length) throw new Error('No workspaces available for testing');
    workspaceId = workspaces[0].id;

    const task = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        title: '[INTEG-TEST] Plan as artifact',
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

    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', progress: 20 }),
    });
  }, TIMEOUT);

  afterAll(async () => {
    await cleanup.runCleanup();
    cleanup.dispose();
  });

  test('submitting a plan creates a task_plan artifact', async () => {
    const { artifact, worker } = await api(`/api/workers/${workerId}/plan`, {
      method: 'POST',
      body: JSON.stringify({
        plan: '## Implementation Plan\n\n1. Analyze the codebase\n2. Write the feature\n3. Add tests',
      }),
    });

    expect(artifact.type).toBe('task_plan');
    expect(artifact.content).toContain('Implementation Plan');
    expect(worker.status).toBe('awaiting_plan_approval');
  }, TIMEOUT);

  test('GET plan returns the submitted plan', async () => {
    const { plan } = await api(`/api/workers/${workerId}/plan`);
    expect(plan.type).toBe('task_plan');
    expect(plan.content).toContain('Implementation Plan');
  }, TIMEOUT);

  test('plan artifact satisfies PR-or-artifact enforcement', async () => {
    // Resume worker (simulate plan approved, now back to running with commits)
    await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'running', commitCount: 2, progress: 90 }),
    });

    // Complete — plan artifact exists, so enforcement passes even with commits
    const updated = await api(`/api/workers/${workerId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        summary: 'Implemented according to approved plan.',
      }),
    });
    expect(updated.status).toBe('completed');
  }, TIMEOUT);
});
