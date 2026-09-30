import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SNAPSHOT_HOST,
  WARM_GENERATIONS_KEPT,
  WARM_LOCK_TTL_MS,
  MAX_SNAPSHOT_BYTES,
  SnapshotStore,
  handleSnapshotRequest,
  parseSnapshotRoute,
  warmKey,
  warmLockKey,
  type BucketObjectLike,
  type BucketPort,
  type SnapshotScope,
} from './snapshots';

/** In-memory R2 with the conditional-put semantics the store relies on. */
class FakeBucket implements BucketPort {
  objects = new Map<string, { data: Uint8Array; etag: string; uploaded: Date }>();
  clock = 1_700_000_000_000;
  private n = 0;
  putCalls: string[] = [];

  private meta(key: string): BucketObjectLike | null {
    const o = this.objects.get(key);
    return o ? { key, size: o.data.byteLength, etag: o.etag, uploaded: o.uploaded } : null;
  }
  async head(key: string) { return this.meta(key); }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const data = o.data;
    return {
      ...this.meta(key)!,
      body: new Response(data).body!,
      text: async () => new TextDecoder().decode(data),
    };
  }
  async put(key: string, value: ReadableStream | string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    this.putCalls.push(key);
    const existing = this.objects.get(key);
    const c = options?.onlyIf;
    if (c?.etagDoesNotMatch === '*' && existing) return null;
    if (c?.etagMatches !== undefined && existing?.etag !== c.etagMatches) return null;
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { data, etag: `e${++this.n}`, uploaded: new Date(this.clock) });
    return this.meta(key);
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(opts: { prefix: string; cursor?: string }) {
    const all = [...this.objects.keys()].filter(k => k.startsWith(opts.prefix)).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const page = all.slice(start, start + 2); // tiny pages, to exercise pagination
    const truncated = start + 2 < all.length;
    return { objects: page.map(k => this.meta(k)!), truncated, cursor: truncated ? String(start + 2) : undefined };
  }
}

const WS = 'ws-aaaa';
const OTHER = 'ws-bbbb';
let bucket: FakeBucket;
let now: number;
let store: SnapshotStore;

beforeEach(() => {
  bucket = new FakeBucket();
  now = 1_700_000_000_000;
  store = new SnapshotStore(bucket, () => now);
});

const scope: SnapshotScope = { workspaceId: WS };

function req(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`https://${SNAPSHOT_HOST}${path}`, { method, body, headers });
}

async function call(method: string, path: string, body?: string, s: SnapshotScope | null = scope, headers: Record<string, string> = {}) {
  const h = { ...headers };
  if (body !== undefined && method === 'PUT' && !('content-length' in h)) h['content-length'] = String(new TextEncoder().encode(body).byteLength);
  return handleSnapshotRequest(req(method, path, body, h), s, store);
}

async function seedGeneration(repo = 'bundle-bytes', cache = 'cache-bytes', ws = WS): Promise<string> {
  const s = { workspaceId: ws };
  const begin = await call('POST', '/warm/begin', '{}', s);
  expect(begin.status).toBe(201);
  const { generation } = await begin.json() as { generation: string };
  expect((await call('PUT', `/warm/${generation}/repo`, repo, s)).status).toBe(201);
  if (cache) expect((await call('PUT', `/warm/${generation}/cache`, cache, s)).status).toBe(201);
  const commit = await call('POST', `/warm/${generation}/commit`, JSON.stringify({ defaultBranch: 'main' }), s);
  expect(commit.status).toBe(201);
  now += 1000;
  return generation;
}

describe('routes', () => {
  test('parseSnapshotRoute recognises only the fixed operations', () => {
    expect(parseSnapshotRoute('GET', '/warm')).toEqual({ op: 'warm_latest' });
    expect(parseSnapshotRoute('POST', '/warm/begin')).toEqual({ op: 'warm_begin' });
    expect(parseSnapshotRoute('GET', '/warm/0001700000000000/repo')).toEqual({ op: 'warm_get', generation: '0001700000000000', part: 'repo' });
    expect(parseSnapshotRoute('PUT', '/warm/0001700000000000/cache')).toEqual({ op: 'warm_put', generation: '0001700000000000', part: 'cache' });
    expect(parseSnapshotRoute('POST', '/warm/0001700000000000/commit')).toEqual({ op: 'warm_commit', generation: '0001700000000000' });
    for (const [m, p] of [
      ['GET', '/warm/../ws-bbbb/0001700000000000/repo'],
      ['GET', `/ws/${OTHER}/warm/0001700000000000/repo`],
      ['GET', '/warm/0001700000000000/manifest'],
      ['GET', '/warm/170/repo'],
      ['GET', '/warm/%2e%2e/repo'],
      ['DELETE', '/warm'],
      ['PUT', '/warm/begin'],
      ['GET', '/'],
    ] as const) {
      expect(parseSnapshotRoute(m, p)).toBeNull();
    }
  });

  test('keys are built from the scope the Worker supplies, never from the request', () => {
    expect(warmKey(WS, '0001700000000000', 'repo')).toBe(`warm/${WS}/0001700000000000/repo.bundle`);
    expect(warmKey(WS, '0001700000000000', 'cache')).toBe(`warm/${WS}/0001700000000000/bun-cache.tar`);
    expect(warmLockKey(WS)).toBe(`warm/${WS}/lock`);
    expect(() => warmKey('../x', '0001700000000000', 'repo')).toThrow();
    expect(() => warmKey(WS, '1/../../x', 'repo')).toThrow();
  });

  test('no scope (warm repos off, run not live, or no workspace from buildd): 503, bucket untouched', async () => {
    const res = await call('GET', '/warm', undefined, null);
    expect(res.status).toBe(503);
    expect(bucket.objects.size).toBe(0);
  });

  test('a query string or a different host cannot redirect the key', async () => {
    await seedGeneration('mine');
    const g = await seedGeneration('other-ws', '', OTHER);
    const res = await handleSnapshotRequest(
      new Request(`https://${SNAPSHOT_HOST}/warm/${g}/repo?workspace=${OTHER}&key=warm/${OTHER}/${g}/repo.bundle`),
      scope, store);
    expect(res.status).toBe(404); // that generation exists only under OTHER
  });
});

describe('warm generations', () => {
  test('begin → put → commit makes a generation visible; the latest manifest describes it', async () => {
    expect((await call('GET', '/warm')).status).toBe(404);
    const g = await seedGeneration('0123456789', 'abc');
    const res = await call('GET', '/warm');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: g, createdAt: now - 1000, repoBytes: 10, cacheBytes: 3, defaultBranch: 'main' });
    const repo = await call('GET', `/warm/${g}/repo`);
    expect(repo.status).toBe(200);
    expect(repo.headers.get('content-length')).toBe('10');
    expect(await repo.text()).toBe('0123456789');
    expect(bucket.objects.has(warmLockKey(WS))).toBe(false);
  });

  test('an uncommitted generation stays invisible', async () => {
    const begin = await call('POST', '/warm/begin', '{}');
    const { generation } = await begin.json() as { generation: string };
    await call('PUT', `/warm/${generation}/repo`, 'x');
    expect((await call('GET', '/warm')).status).toBe(404);
  });

  test('one refresh per workspace in flight: a second begin is refused, another workspace is not affected', async () => {
    expect((await call('POST', '/warm/begin', '{}')).status).toBe(201);
    expect((await call('POST', '/warm/begin', '{}')).status).toBe(409);
    expect((await call('POST', '/warm/begin', '{}', { workspaceId: OTHER })).status).toBe(201);
  });

  test('two concurrent begins: exactly one wins (conditional put)', async () => {
    const [a, b] = await Promise.all([call('POST', '/warm/begin', '{}'), call('POST', '/warm/begin', '{}')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  test('a stale lock (holder died) is taken over after the TTL', async () => {
    expect((await call('POST', '/warm/begin', '{}')).status).toBe(201);
    now += WARM_LOCK_TTL_MS + 1;
    bucket.clock = now;
    expect((await call('POST', '/warm/begin', '{}')).status).toBe(201);
  });

  test('puts and commits need the generation the lock holds', async () => {
    const begin = await call('POST', '/warm/begin', '{}');
    const { generation } = await begin.json() as { generation: string };
    const other = String(Number(generation) + 5).padStart(16, '0');
    expect((await call('PUT', `/warm/${other}/repo`, 'x')).status).toBe(409);
    expect((await call('POST', `/warm/${other}/commit`, '{"defaultBranch":"main"}')).status).toBe(409);
    // Commit before the repo part exists is refused too.
    expect((await call('POST', `/warm/${generation}/commit`, '{"defaultBranch":"main"}')).status).toBe(409);
  });

  test('commit validates the default branch name', async () => {
    const { generation } = await (await call('POST', '/warm/begin', '{}')).json() as { generation: string };
    await call('PUT', `/warm/${generation}/repo`, 'x');
    for (const bad of ['', '../main', 'a b', '-x', 'x'.repeat(300)]) {
      expect((await call('POST', `/warm/${generation}/commit`, JSON.stringify({ defaultBranch: bad }))).status).toBe(400);
    }
  });

  test('size guards: a PUT needs a content-length within the limit', async () => {
    const { generation } = await (await call('POST', '/warm/begin', '{}')).json() as { generation: string };
    const noLen = await handleSnapshotRequest(
      req('PUT', `/warm/${generation}/repo`, new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), {}),
      scope, store);
    expect(noLen.status).toBe(411);
    expect((await call('PUT', `/warm/${generation}/repo`, 'x', scope, { 'content-length': String(MAX_SNAPSHOT_BYTES + 1) })).status).toBe(413);
  });

  test('keeps the latest two generations and prunes older ones, orphans included', async () => {
    const gens: string[] = [];
    for (let i = 0; i < 4; i++) gens.push(await seedGeneration(`b${i}`, `c${i}`));
    // An orphan (upload that never committed) older than the kept pair.
    bucket.objects.set(warmKey(WS, '0000000000000001', 'repo'), { data: new Uint8Array([1]), etag: 'x', uploaded: new Date(0) });
    await seedGeneration('b4', 'c4');
    const keys = [...bucket.objects.keys()].filter(k => k.startsWith(`warm/${WS}/`)).sort();
    const kept = new Set(keys.map(k => k.split('/')[2]));
    expect(kept.size).toBe(WARM_GENERATIONS_KEPT);
    expect([...kept]).not.toContain('0000000000000001');
    expect([...kept]).not.toContain(gens[0]);
    const latest = await (await call('GET', '/warm')).json() as { repoBytes: number };
    expect(latest.repoBytes).toBe(2);
  });

  test('pruning one workspace never touches another', async () => {
    await seedGeneration('other', 'o', OTHER);
    for (let i = 0; i < 3; i++) await seedGeneration(`b${i}`);
    expect([...bucket.objects.keys()].filter(k => k.startsWith(`warm/${OTHER}/`)).length).toBeGreaterThan(0);
  });

  test('generation numbers increase even if the clock steps back', async () => {
    const g1 = await seedGeneration();
    now -= 60_000;
    const g2 = await seedGeneration();
    expect(g2 > g1).toBe(true);
  });
});
