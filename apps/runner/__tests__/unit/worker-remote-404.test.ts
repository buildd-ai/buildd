/**
 * BuilddClient.getWorkerRemote — null means "this worker does not exist on the
 * server" (a 404), and nothing else. The periodic reconcile reads null as a
 * deleted worker: it marks the local worker errored and stops reporting it.
 *
 * It used to return null whenever the body carried a truthy `error`. A
 * worker's own row has an `error` column, and a question park writes
 * `needs_input: <question>` into it. So every parked question read as a 404 at
 * the next reconcile: the runner forgot the worker, never told the server, and
 * the server row stayed `waiting_input` (holding an account slot, and drawn as
 * a run with a question on Health) until a sweep found it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/worker-remote-404.test.ts
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';

const realFetch = globalThis.fetch;

function stubFetch(status: number, json: unknown) {
  globalThis.fetch = (() => Promise.resolve(
    new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }),
  )) as any;
}

function makeClient() {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'https://coordination.example.invalid',
    apiKey: 'bld_test_key_value_0123456789',
    maxConcurrent: 1,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as any);
}

describe('BuilddClient.getWorkerRemote', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns a question-parked worker whose row carries a needs_input error', async () => {
    stubFetch(200, {
      id: 'w1', status: 'waiting_input', error: 'needs_input: Which repo should this go in?',
      waitingFor: { type: 'question', prompt: 'Which repo should this go in?' },
      task: { status: 'assigned' },
    });
    const remote = await makeClient().getWorkerRemote('w1');
    expect(remote).not.toBeNull();
    expect(remote?.status).toBe('waiting_input');
  });

  it('returns a failed worker with an error, so reconcile reads it as terminal', async () => {
    stubFetch(200, { id: 'w1', status: 'failed', error: 'Agent crashed', task: { status: 'failed' } });
    const remote = await makeClient().getWorkerRemote('w1');
    expect(remote?.status).toBe('failed');
  });

  it('returns null for a 404', async () => {
    stubFetch(404, { error: 'Worker not found' });
    expect(await makeClient().getWorkerRemote('w1')).toBeNull();
  });
});
