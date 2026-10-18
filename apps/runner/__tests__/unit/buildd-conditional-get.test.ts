/**
 * The runner's list reads are conditional (spec 3ef37387 R-20): it sends the
 * last answer's ETag as If-None-Match and, on 304, returns that answer again.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-conditional-get.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { isServerRefusal } from '../../src/server-refusal';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const client = () => new BuilddClient({ projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 1 } as LocalUIConfig);

type Reply = { status: number; body?: unknown; etag?: string };
function server(replies: Reply[]) {
  const sent: Array<{ url: string; ifNoneMatch: string | null }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init?.headers as Record<string, string>);
    sent.push({ url, ifNoneMatch: headers.get('if-none-match') });
    const r = replies.shift() ?? { status: 500 };
    const h = new Headers(r.etag ? { ETag: r.etag } : {});
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: h, text: async () => text, json: async () => JSON.parse(text) };
  }) as any;
  return sent;
}

describe('BuilddClient.getIfChanged', () => {
  test('sends the last ETag and returns the last answer on 304', async () => {
    const sent = server([
      { status: 200, body: { missions: [{ id: 'm1' }] }, etag: 'W/"cv1-a"' },
      { status: 304, etag: 'W/"cv1-a"' },
      { status: 200, body: { missions: [{ id: 'm2' }] }, etag: 'W/"cv1-b"' },
    ]);
    const c = client();
    expect(await c.listRecentMissions()).toEqual([{ id: 'm1' }] as any);
    expect(await c.listRecentMissions()).toEqual([{ id: 'm1' }] as any);
    expect(await c.listRecentMissions()).toEqual([{ id: 'm2' }] as any);
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, 'W/"cv1-a"', 'W/"cv1-a"']);
  });

  test('a caller mutating the answer does not change what a 304 returns', async () => {
    server([{ status: 200, body: { tasks: [{ id: 't1' }] }, etag: 'W/"x"' }, { status: 304 }]);
    const c = client();
    const first = await c.listTasks();
    first.push({ id: 'mutated' } as any);
    expect(await c.listTasks()).toEqual([{ id: 't1' }] as any);
  });

  test('without an ETag every read is a plain GET', async () => {
    const sent = server([{ status: 200, body: { tasks: [] } }, { status: 200, body: { tasks: [] } }]);
    const c = client();
    await c.listTasks();
    await c.listTasks();
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, null]);
  });

  test('ETags are per endpoint, query included', async () => {
    const sent = server([
      { status: 200, body: { stages: {} }, etag: 'W/"s1"' },
      { status: 200, body: { stages: {} }, etag: 'W/"s2"' },
      { status: 304 },
    ]);
    const c = client();
    await c.listMissionStages(['a']);
    await c.listMissionStages(['b']);
    await c.listMissionStages(['a']);
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, null, 'W/"s1"']);
  });

  test('an error is a refusal, and does not drop to the cached answer', async () => {
    server([{ status: 200, body: { tasks: [] }, etag: 'W/"x"' }, { status: 500, body: { error: 'boom' } }]);
    const c = client();
    await c.listTasks();
    expect(isServerRefusal(await c.listTasks().catch(e => e))).toBe(true);
  });
});
