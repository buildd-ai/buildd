/**
 * `BuilddClient.getWorkerRemote` used to catch every error — timeouts,
 * network faults, 5xx, even a 401/403 refusal — and collapse them all to
 * `null`, the same value it returns for a confirmed 404. `reconcileLocalWorkers`
 * (workers.ts) reads null as "worker no longer exists on remote" and flips the
 * LOCAL worker to 'error', abandoning a session that may still be running
 * fine — while the server, having never heard back, reaps the worker as
 * stale and re-queues its task onto a second one.
 *
 * The fix: null means ONLY a confirmed 404. Everything else — including a
 * response body with no `status` field, which a queued outbox placeholder
 * would produce — is rethrown so callers can tell "gone" from "unknown".
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-get-worker-remote.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { isServerRefusal } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;

function makeClient() {
  return new BuilddClient({
    projectRoots: ['/tmp'],
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
  } as LocalUIConfig);
}

/** A fake transport response: only the members BuilddClient.fetch reads. */
function respondWith(status: number, body: string) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as any;
}

describe('BuilddClient.getWorkerRemote', () => {
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('a confirmed 404 resolves null', async () => {
    respondWith(404, JSON.stringify({ error: 'Worker not found' }));
    const client = makeClient();

    await expect(client.getWorkerRemote('w-1')).resolves.toBeNull();
  });

  test('a timeout rethrows instead of resolving null', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }) as any;
    const client = makeClient();

    await expect(client.getWorkerRemote('w-2')).rejects.toThrow();
  });

  test('a 503 rethrows as a server refusal instead of resolving null', async () => {
    respondWith(503, 'Service Unavailable');
    const client = makeClient();

    const err = await client.getWorkerRemote('w-3').then(() => null, (e: unknown) => e);
    expect(isServerRefusal(err)).toBe(true);
  });

  test('a 401 rethrows as a server refusal instead of resolving null', async () => {
    respondWith(401, JSON.stringify({ error: 'runner key rejected' }));
    const client = makeClient();

    const err = await client.getWorkerRemote('w-4').then(() => null, (e: unknown) => e);
    expect(isServerRefusal(err)).toBe(true);
  });

  test('a body with no status field (e.g. an outbox-queued placeholder) throws, not resolves null', async () => {
    respondWith(200, '{}');
    const client = makeClient();

    await expect(client.getWorkerRemote('w-5')).rejects.toThrow(/status/);
  });

  test('a 200 with worker state resolves the parsed body', async () => {
    const worker = { status: 'working', task: { status: 'assigned' } };
    respondWith(200, JSON.stringify(worker));
    const client = makeClient();

    await expect(client.getWorkerRemote('w-6')).resolves.toEqual(worker);
  });
});
