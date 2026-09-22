/**
 * A refusal the server RETURNED must not be mistaken for a transport fault.
 *
 * Two defects at one site (`BuilddClient.fetch`):
 *
 *  1. Every non-`allowedErrors` status that is not a queueable 5xx became an
 *     untyped `Error` whose whole payload was the string
 *     `API error: <status> - <body>`. Callers had no way to tell "the server
 *     refused this request" from "the session crashed", so the completion
 *     PATCH's 400 unwound into the runner's crash handler and the stringified
 *     body was persisted as the worker's error.
 *
 *  2. Worse, that throw is raised INSIDE fetch's own `try`, so its own
 *     `catch` inspected it with `isNetworkError` — a substring test over
 *     `err.message`, which by then held the SERVER'S RESPONSE BODY. A 4xx
 *     whose text happened to contain "aborted" / "timed out" / "ECONNRESET"
 *     was therefore enqueued to the outbox and `{}` returned: the caller
 *     concluded the mutation had succeeded. Silent loss.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-server-refusal.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { ServerRefusalError, isServerRefusal } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;

function makeClient(outbox?: { shouldQueue: (m: string, e: string) => boolean; enqueue: (...a: any[]) => void }) {
  const client = new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
  } as LocalUIConfig);
  if (outbox) client.setOutbox(outbox as any);
  return client;
}

/** A fake transport response: only the four members BuilddClient.fetch reads. */
function respondWith(status: number, body: string) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as any;
}

function makeOutbox() {
  const enqueue = mock((..._args: any[]) => {});
  return { shouldQueue: () => true, enqueue, calls: () => enqueue.mock.calls };
}

const GATE_400 = JSON.stringify({
  error: 'This task requires a pull request before completing. Use create_pr to open one.',
  hint: 'create_pr',
  gate: 'output_requirement',
});

describe('BuilddClient refusals', () => {
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('a gate 400 rejects with a typed refusal carrying the gate identity', async () => {
    respondWith(400, GATE_400);
    const client = makeClient();

    const err = await client.updateWorker('w-1', { status: 'completed' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isServerRefusal(err)).toBe(true);
    const refusal = err as ServerRefusalError;
    expect(refusal.name).toBe('ServerRefusalError');
    expect(refusal.status).toBe(400);
    expect(refusal.gate).toBe('output_requirement');
    expect(refusal.hint).toBe('create_pr');
    expect(refusal.isOutcomeGate).toBe(true);
    expect(refusal.method).toBe('PATCH');
    expect(refusal.endpoint).toBe('/api/workers/w-1');
    // The message is the SERVER'S prose, not `API error: 400 - {json}`. It is
    // what lands in workers.error, which is what normalizeErrorSignature
    // clusters — so it has to be the same text the gate ledger recorded.
    expect(refusal.message).toBe('This task requires a pull request before completing. Use create_pr to open one.');
    expect(refusal.message).not.toMatch(/^API error: \d/);
  });

  test('a non-gate refusal is not an outcome-gate refusal, and synthesizes a message when the body has none', async () => {
    respondWith(404, 'Not Found');
    const client = makeClient();

    const err = await client.updateWorker('w-2', { status: 'failed' }).then(
      () => null,
      (e: unknown) => e,
    ) as ServerRefusalError;

    expect(isServerRefusal(err)).toBe(true);
    expect(err.status).toBe(404);
    expect(err.gate).toBeUndefined();
    expect(err.isOutcomeGate).toBe(false);
    expect(err.message).toBe('Server refused PATCH /api/workers/w-2: HTTP 404');
    // The unparsed body is still available for diagnosis.
    expect(err.raw).toBe('Not Found');
  });

  // The silent-loss defect. `isNetworkError` matched the server's own words.
  test('a 4xx whose body contains "aborted" rejects instead of being queued as a network error', async () => {
    respondWith(400, JSON.stringify({ error: 'completion aborted by policy: timed out waiting for a PR' }));
    const outbox = makeOutbox();
    const client = makeClient(outbox);

    const err = await client.updateWorker('w-3', { status: 'completed' }).then(
      () => 'RESOLVED',
      (e: unknown) => e,
    );

    expect(err).not.toBe('RESOLVED');
    expect(isServerRefusal(err)).toBe(true);
    // Queueing it meant retrying a request the server had DECIDED to refuse,
    // while telling the caller it had landed.
    expect(outbox.calls()).toHaveLength(0);
  });

  test('a 401 whose body mentions ECONNRESET is still a refusal, not a transport fault', async () => {
    respondWith(401, JSON.stringify({ error: 'runner key rejected (upstream ECONNRESET)' }));
    const outbox = makeOutbox();
    const client = makeClient(outbox);

    const err = await client.updateWorker('w-4', { status: 'failed' }).then(
      () => 'RESOLVED',
      (e: unknown) => e,
    ) as ServerRefusalError;

    expect(isServerRefusal(err)).toBe(true);
    expect(err.status).toBe(401);
    expect(outbox.calls()).toHaveLength(0);
  });

  // ── Unchanged-behaviour guards ────────────────────────────────────────────

  test('a 5xx still goes to the outbox and resolves empty', async () => {
    respondWith(503, 'Service Unavailable');
    const outbox = makeOutbox();
    const client = makeClient(outbox);

    await expect(client.updateWorker('w-5', { status: 'running' })).resolves.toEqual({});
    expect(outbox.calls()).toHaveLength(1);
    expect(outbox.calls()[0][0]).toBe('PATCH');
    expect(outbox.calls()[0][1]).toBe('/api/workers/w-5');
  });

  test('a 409 on updateWorker still resolves the parsed body (persistTerminalMetrics depends on it)', async () => {
    respondWith(409, JSON.stringify({ abort: true, actualStatus: 'completed' }));
    const client = makeClient();

    await expect(client.updateWorker('w-6', { status: 'completed' }))
      .resolves.toEqual({ abort: true, actualStatus: 'completed' });
  });

  test('a real transport fault is still queued, not reported as a refusal', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as any;
    const outbox = makeOutbox();
    const client = makeClient(outbox);

    await expect(client.updateWorker('w-7', { status: 'running' })).resolves.toEqual({});
    expect(outbox.calls()).toHaveLength(1);
  });
});

describe('isServerRefusal', () => {
  // 16+ runner test files replace whole modules with mock.module, which can
  // leave two copies of this class in one process; `instanceof` then fails on
  // an object that is plainly a refusal.
  test('accepts a duck-typed refusal from another module copy', () => {
    const lookalike = Object.assign(new Error('refused'), { name: 'ServerRefusalError', status: 400 });
    expect(lookalike instanceof ServerRefusalError).toBe(false);
    expect(isServerRefusal(lookalike)).toBe(true);
  });

  test('rejects an ordinary error', () => {
    expect(isServerRefusal(new Error('boom'))).toBe(false);
    expect(isServerRefusal(null)).toBe(false);
    expect(isServerRefusal('ServerRefusalError')).toBe(false);
  });
});

describe('the gate slug the runner matches on', () => {
  // The runner cannot import @buildd/core/gate-events: that module imports the
  // DB client, which is `server-only` and throws on import outside Next. So
  // the slug catalogue lives in a dependency-free module both sides share —
  // this asserts the runner is reading THAT one, not a hand-copied literal.
  test('comes from the shared catalogue', async () => {
    const { GATE_SLUGS } = await import('@buildd/core/gate-slugs');
    respondWith(400, GATE_400);
    const err = await makeClient().updateWorker('w-8', { status: 'completed' }).then(
      () => null,
      (e: unknown) => e,
    ) as ServerRefusalError;
    expect(err.gate).toBe(GATE_SLUGS.OUTPUT_REQUIREMENT);
    expect(err.isOutcomeGate).toBe(true);
  });
});
