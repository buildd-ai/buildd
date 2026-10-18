/**
 * lib/change-version.ts without a database: the ETag's inputs, the
 * If-None-Match comparison, the caller key and fail-open. The SQL side (AC-4,
 * R-35 on the real routes) is apps/web/tests/db/list-change-version.test.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  CHANGE_VERSION_BUCKET_MS, changeTag, listCallerKey, matchesIfNoneMatch, memoryChangeVersionStore,
  setChangeVersionStoreForTests, withChangeVersion, type ChangeVersionStore,
} from './change-version';

afterEach(() => setChangeVersionStoreForTests(null));

const req = (url: string, etag?: string) => new Request(url, { headers: etag ? { 'if-none-match': etag } : {} });
const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('matchesIfNoneMatch', () => {
  it('compares weakly, reads a list, and honours *', () => {
    expect(matchesIfNoneMatch('W/"cv1-a"', 'W/"cv1-a"')).toBe(true);
    expect(matchesIfNoneMatch('"cv1-a"', 'W/"cv1-a"')).toBe(true);
    expect(matchesIfNoneMatch('W/"x", W/"cv1-a"', 'W/"cv1-a"')).toBe(true);
    expect(matchesIfNoneMatch('*', 'W/"cv1-a"')).toBe(true);
    expect(matchesIfNoneMatch('W/"cv1-b"', 'W/"cv1-a"')).toBe(false);
    expect(matchesIfNoneMatch(null, 'W/"cv1-a"')).toBe(false);
  });
});

describe('changeTag', () => {
  it('moves with a bump, the query, the caller and the time bucket, and ignores query order', async () => {
    const store = memoryChangeVersionStore();
    setChangeVersionStoreForTests(store);
    const now = 10 * CHANGE_VERSION_BUCKET_MS;
    const base = await changeTag(req('http://x/api/tasks?a=1&b=2'), { scopes: ['w1'], caller: 'a:1', now });
    expect(base).toMatch(/^W\/"cv1-/);
    expect(await changeTag(req('http://x/api/tasks?b=2&a=1'), { scopes: ['w1'], caller: 'a:1', now })).toBe(base);
    expect(await changeTag(req('http://x/api/tasks?a=1&b=3'), { scopes: ['w1'], caller: 'a:1', now })).not.toBe(base);
    expect(await changeTag(req('http://x/api/tasks?a=1&b=2'), { scopes: ['w1'], caller: 'a:2', now })).not.toBe(base);
    expect(await changeTag(req('http://x/api/tasks?a=1&b=2'), { scopes: ['w1'], caller: 'a:1', now: now + CHANGE_VERSION_BUCKET_MS })).not.toBe(base);
    await store.bump(['w1']);
    expect(await changeTag(req('http://x/api/tasks?a=1&b=2'), { scopes: ['w1'], caller: 'a:1', now })).not.toBe(base);
  });

  it('moves with `vary` (what the body reads that no counter sees)', async () => {
    setChangeVersionStoreForTests(memoryChangeVersionStore());
    const now = 10 * CHANGE_VERSION_BUCKET_MS;
    const at = (vary?: unknown[]) => changeTag(req('http://x/api/tasks'), { scopes: ['w1'], caller: 'a:1', now, vary });
    expect(await at([])).toBe(await at());
    expect(await at(['2026-01-01T00:00:00.000Z'])).not.toBe(await at([null]));
    expect(await at(['2026-01-01T00:00:00.000Z'])).toBe(await at(['2026-01-01T00:00:00.000Z']));
  });

  it('is null when the counters cannot be read', async () => {
    setChangeVersionStoreForTests({ ...memoryChangeVersionStore(), read: async () => null });
    expect(await changeTag(req('http://x/api/tasks'), { scopes: ['w1'], caller: 'a:1' })).toBeNull();
  });
});

describe('withChangeVersion', () => {
  it('fails open: no counters, no ETag, the read runs every time', async () => {
    const failing: ChangeVersionStore = {
      bump: async () => false, read: async () => { throw new Error('down'); },
      getBody: async () => { throw new Error('down'); }, setBody: async () => { throw new Error('down'); },
    };
    setChangeVersionStoreForTests(failing);
    let loads = 0;
    const res = await withChangeVersion(req('http://x/api/tasks', '*'), { scopes: ['w1'], caller: 'a:1' }, async () => { loads++; return ok({ n: 1 })(); });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
    expect(loads).toBe(1);
  });

  it('does not cache an error', async () => {
    const store = memoryChangeVersionStore();
    setChangeVersionStoreForTests(store);
    const res = await withChangeVersion(req('http://x/api/tasks'), { scopes: ['w1'], caller: 'a:1' }, async () => new Response('{}', { status: 500 }));
    expect(res.status).toBe(500);
    expect(res.headers.get('etag')).toBeNull();
    expect(store.bodies.size).toBe(0);
  });
});

describe('listCallerKey', () => {
  it('separates every credential that narrows the same account', () => {
    const account = { id: 'acc', teamId: 't', level: 'worker', workspaceIds: null, scopes: null };
    const full = listCallerKey({ account });
    expect(listCallerKey({ account: { ...account } })).toBe(full);
    expect(listCallerKey({ account: { ...account, taskScope: { taskId: 'k', workspaceId: 'w' } } })).not.toBe(full);
    expect(listCallerKey({ account: { ...account, workspaceIds: ['w'] } })).not.toBe(full);
    expect(listCallerKey({ account: { ...account, oauthGrantId: 'g' } })).not.toBe(full);
    expect(listCallerKey({ account: { ...account, level: 'admin' } })).not.toBe(full);
    expect(listCallerKey({ userId: 'acc' })).not.toBe(full);
  });
});

describe('reach', () => {
  it('a narrower reach never gets the wider reach\'s cached body (the scopes are in the key)', async () => {
    setChangeVersionStoreForTests(memoryChangeVersionStore());
    let loads = 0;
    const load = (body: unknown) => async () => { loads++; return ok(body)(); };
    const wide = await withChangeVersion(req('http://x/api/tasks'), { scopes: ['w1', 'w2'], caller: 'a:1' }, load({ w: ['w1', 'w2'] }));
    const narrow = await withChangeVersion(req('http://x/api/tasks', wide.headers.get('etag')!), { scopes: ['w1'], caller: 'a:1' }, load({ w: ['w1'] }));
    expect(narrow.status).toBe(200);
    expect(narrow.headers.get('x-buildd-list-cache')).toBeNull();
    expect(await narrow.json()).toEqual({ w: ['w1'] });
    expect(loads).toBe(2);
  });

  it('is not cached here: the module has no reach cache to go stale', async () => {
    const mod = await import('./change-version') as Record<string, unknown>;
    expect(mod.cachedReach).toBeUndefined();
    expect(mod.REACH_CACHE_TTL_SEC).toBeUndefined();
  });
});
