/**
 * The runner backs off on the server's read rate limit (a 429 with
 * Retry-After) instead of retrying hot: until Retry-After passes, a GET to the
 * same endpoint is refused locally, without a request.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/read-backoff.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { ReadBackoff, parseRetryAfter, rateLimitedRetryAfterSec } from '../../src/read-backoff';
import { BuilddClient } from '../../src/buildd';
import { ServerRefusalError, isServerRefusal } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

const NOW = 1_800_000_000_000;

describe('parseRetryAfter', () => {
  test('seconds', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3);
    expect(parseRetryAfter('0', NOW)).toBe(1);
  });
  test('an HTTP date', () => {
    expect(parseRetryAfter(new Date(NOW + 10_000).toUTCString(), NOW)).toBe(10);
  });
  test('missing or junk', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
  });
});

describe('ReadBackoff', () => {
  test('holds one endpoint (query ignored) until Retry-After passes', () => {
    let now = NOW;
    const b = new ReadBackoff(() => now);
    b.note('/api/missions/stages?ids=a', '5');
    expect(b.remainingSec('/api/missions/stages?ids=b')).toBe(5);
    expect(b.remainingSec('/api/tasks')).toBe(0);
    now += 4_001;
    expect(b.remainingSec('/api/missions/stages')).toBe(1);
    now += 1_000;
    expect(b.remainingSec('/api/missions/stages')).toBe(0);
  });

  test('a 429 without Retry-After is not a rate-limit hold', () => {
    const b = new ReadBackoff(() => NOW);
    b.note('/api/tasks', null);
    expect(b.remainingSec('/api/tasks')).toBe(0);
  });
});

describe('rateLimitedRetryAfterSec', () => {
  test('reads the seconds off a rate-limit refusal, nothing else', () => {
    const rl = ServerRefusalError.from({ status: 429, raw: JSON.stringify({ code: 'rate_limited', retryAfterSec: 7, error: 'x' }), method: 'GET', endpoint: '/api/tasks' });
    expect(rateLimitedRetryAfterSec(rl)).toBe(7);
    const cap = ServerRefusalError.from({ status: 429, raw: JSON.stringify({ code: 'max_concurrent_workers' }), method: 'POST', endpoint: '/api/workers/claim' });
    expect(rateLimitedRetryAfterSec(cap)).toBeNull();
    expect(rateLimitedRetryAfterSec(new Error('boom'))).toBeNull();
  });
});

describe('BuilddClient: GET backs off on 429', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function client() {
    return new BuilddClient({ projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 1 } as LocalUIConfig);
  }

  test('after a 429, the next GET to that endpoint is refused without a request', async () => {
    let calls = 0;
    const body = JSON.stringify({ error: 'Rate limited', code: 'rate_limited', retryAfterSec: 30 });
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '30' }), text: async () => body, json: async () => JSON.parse(body) };
    }) as any;
    const c = client();
    const first = await c.listRecentMissions().catch(e => e);
    expect(isServerRefusal(first)).toBe(true);
    expect(calls).toBe(1);
    const second = await c.listRecentMissions().catch(e => e);
    expect(isServerRefusal(second)).toBe(true);
    expect((second as ServerRefusalError).status).toBe(429);
    expect(rateLimitedRetryAfterSec(second)).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  test('writes are never held by a read backoff', async () => {
    let calls = 0;
    const rl = JSON.stringify({ code: 'rate_limited', retryAfterSec: 30 });
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls++;
      if ((init?.method ?? 'GET') === 'GET') return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '30' }), text: async () => rl, json: async () => JSON.parse(rl) };
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{}', json: async () => ({}) };
    }) as any;
    const c = client();
    await c.listTasks().catch(() => {});
    await c.createTask({ workspaceId: 'w', title: 't', description: 'd' } as any);
    expect(calls).toBe(2);
  });
});
