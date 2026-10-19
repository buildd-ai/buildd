/**
 * The runner asks the server for the lean, conditional and batched read
 * shapes (spec 3ef37387): the task list with its stages conditionally, worker
 * status with view=status, every live worker's status in one read, the
 * workspace list at most once a minute, and no admin-only cleanup once the
 * server has refused it.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-lean-reads.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { BuilddClient, WORKSPACES_CACHE_MS } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });

const client = () => new BuilddClient({ projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 1 } as LocalUIConfig);

type Reply = { status: number; body?: unknown; etag?: string };
function server(replies: Reply[]) {
  const sent: Array<{ url: string; method: string; ifNoneMatch: string | null }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init?.headers as Record<string, string>);
    sent.push({ url: String(url), method: init?.method ?? 'GET', ifNoneMatch: headers.get('if-none-match') });
    const r = replies.shift() ?? { status: 500, body: { error: 'no reply scripted' } };
    const h = new Headers(r.etag ? { ETag: r.etag } : {});
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: h, text: async () => text, json: async () => JSON.parse(text) };
  }) as any;
  return sent;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('listTasksWithStages', () => {
  test('is one conditional read: the second sends If-None-Match and a 304 returns tasks and stages again', async () => {
    const sent = server([
      { status: 200, body: { tasks: [{ id: 't1', missionId: 'm1' }], missionStages: { m1: { stage: 'build' } } }, etag: 'W/"cv1-a"' },
      { status: 304, etag: 'W/"cv1-a"' },
    ]);
    const c = client();
    const first = await c.listTasksWithStages();
    const second = await c.listTasksWithStages();
    expect(second).toEqual(first);
    expect(second.missionStages).toEqual({ m1: { stage: 'build' } } as any);
    expect(sent.map(s => s.url.replace('http://server.invalid', ''))).toEqual(['/api/tasks?include=missionStages', '/api/tasks?include=missionStages']);
    expect(sent.map(s => s.ifNoneMatch)).toEqual([null, 'W/"cv1-a"']);
  });
});

describe('getWorkerRemote', () => {
  test('asks for the status view', async () => {
    const sent = server([{ status: 200, body: { id: A, status: 'running', error: null, task: { status: 'in_progress' } } }]);
    const remote = await client().getWorkerRemote(A);
    expect(remote?.status).toBe('running');
    expect(sent[0].url).toBe(`http://server.invalid/api/workers/${A}?view=status`);
  });
});

describe('getWorkerStatuses', () => {
  test('reads every named worker in one request', async () => {
    const sent = server([{ status: 200, body: { workers: { [A]: { status: 'running', error: null, task: { status: 'in_progress' } } }, missing: [B] } }]);
    const r = await client().getWorkerStatuses([A, B]);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`http://server.invalid/api/workers/status?ids=${A},${B}`);
    expect(r?.workers[A].status).toBe('running');
    expect(r?.missing).toEqual([B]);
  });

  test('a server without the route (its [id] route answers 404) yields null, so the caller reads one by one', async () => {
    server([{ status: 404, body: { error: 'Worker not found' } }]);
    expect(await client().getWorkerStatuses([A])).toBeNull();
  });

  test('splits more ids than one read allows', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const sent = server([
      { status: 200, body: { workers: {}, missing: ids.slice(0, 100) } },
      { status: 200, body: { workers: {}, missing: ids.slice(100) } },
    ]);
    const r = await client().getWorkerStatuses(ids);
    expect(sent).toHaveLength(2);
    expect(r?.missing).toHaveLength(150);
  });

  test('a transport failure throws (unknown is not gone)', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as any;
    await expect(client().getWorkerStatuses([A])).rejects.toThrow();
  });
});

describe('listWorkspaces', () => {
  test('is read at most once per WORKSPACES_CACHE_MS', async () => {
    let now = 1_000_000;
    Date.now = () => now;
    const sent = server([
      { status: 200, body: { workspaces: [{ id: 'w1' }] } },
      { status: 200, body: { workspaces: [{ id: 'w1' }, { id: 'w2' }] } },
    ]);
    const c = client();
    expect(await c.listWorkspaces()).toEqual([{ id: 'w1' }]);
    now += WORKSPACES_CACHE_MS - 1;
    expect(await c.listWorkspaces()).toEqual([{ id: 'w1' }]);
    expect(sent).toHaveLength(1);
    now += 2;
    expect(await c.listWorkspaces()).toEqual([{ id: 'w1' }, { id: 'w2' }]);
    expect(sent).toHaveLength(2);
  });

  test('a write to workspaces drops the cached list', async () => {
    const sent = server([
      { status: 200, body: { workspaces: [] } },
      { status: 200, body: { id: 'w9' } },
      { status: 200, body: { workspaces: [{ id: 'w9' }] } },
    ]);
    const c = client();
    await c.listWorkspaces();
    await c.createWorkspace({ name: 'n' } as any);
    expect(await c.listWorkspaces()).toEqual([{ id: 'w9' }]);
    expect(sent).toHaveLength(3);
  });
});

describe('runCleanup', () => {
  test('stops asking once the server refuses it (a non-admin key)', async () => {
    const sent = server([{ status: 401, body: { error: 'Unauthorized - requires session auth or admin-level API token' } }]);
    const c = client();
    await expect(c.runCleanup()).rejects.toThrow();
    expect(await c.runCleanup()).toBeNull();
    expect(sent).toHaveLength(1);
  });
});
