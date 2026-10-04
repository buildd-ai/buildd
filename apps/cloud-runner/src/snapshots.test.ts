import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SNAPSHOT_HOST,
  WARM_GENERATIONS_KEPT,
  WARM_LOCK_TTL_MS,
  MAX_SNAPSHOT_BYTES,
  MAX_PART_BYTES,
  SnapshotStore,
  handleSnapshotRequest,
  parseSnapshotRoute,
  parkKey,
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
  /** Open multipart uploads: id → key and parts. R2's rules: equal non-final parts, completed in order. */
  uploads = new Map<string, { key: string; parts: Map<number, { data: Uint8Array; etag: string }> }>();
  aborted: string[] = [];
  async createMultipartUpload(key: string) {
    const uploadId = `mp-${++this.n}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { key, uploadId };
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const b = this;
    const up = () => {
      const u = b.uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error('NoSuchUpload');
      return u;
    };
    return {
      key, uploadId,
      async uploadPart(partNumber: number, value: ReadableStream | string) {
        const u = up();
        const data = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
        const etag = `p${partNumber}-${++b.n}`;
        u.parts.set(partNumber, { data, etag });
        return { partNumber, etag };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        const u = up();
        const sizes = parts.map(p => u.parts.get(p.partNumber)?.data.byteLength ?? -1);
        if (parts.some(p => u.parts.get(p.partNumber)?.etag !== p.etag)) throw new Error('InvalidPart');
        if (sizes.slice(0, -1).some(s => s !== sizes[0])) throw new Error('parts differ in size');
        const total = sizes.reduce((a, b2) => a + b2, 0);
        const data = new Uint8Array(total);
        let at = 0;
        for (const p of parts) { data.set(u.parts.get(p.partNumber)!.data, at); at += u.parts.get(p.partNumber)!.data.byteLength; }
        b.objects.set(key, { data, etag: `e${++b.n}`, uploaded: new Date(b.clock) });
        b.uploads.delete(uploadId);
        return b.meta(key)!;
      },
      async abort() {
        b.aborted.push(uploadId);
        b.uploads.delete(uploadId);
      },
    };
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

  test('a refresh in flight does not hide the committed generation below it', async () => {
    const g = await seedGeneration('committed');
    const { generation } = await (await call('POST', '/warm/begin', '{}')).json() as { generation: string };
    await call('PUT', `/warm/${generation}/repo`, 'half-uploaded');
    const res = await call('GET', '/warm');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { generation: string }).generation).toBe(g);
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

describe('streamed multipart uploads (a bundle of unknown length)', () => {
  const ID = 'x-buildd-upload-id';
  async function begin(): Promise<string> {
    return ((await (await call('POST', '/warm/begin', '{}')).json()) as { generation: string }).generation;
  }
  async function create(gen: string, part = 'repo'): Promise<string> {
    const r = await call('POST', `/warm/${gen}/${part}/multipart`, '{}');
    expect(r.status).toBe(201);
    return ((await r.json()) as { uploadId: string }).uploadId;
  }
  const putPart = (gen: string, n: number, body: string, uploadId: string, part = 'repo') =>
    call('PUT', `/warm/${gen}/${part}/multipart/${n}`, body, scope, { [ID]: uploadId });

  test('routes', () => {
    const g = '0001700000000000';
    expect(parseSnapshotRoute('POST', `/warm/${g}/repo/multipart`)).toEqual({ op: 'warm_mp_create', generation: g, part: 'repo' });
    expect(parseSnapshotRoute('PUT', `/warm/${g}/cache/multipart/7`)).toEqual({ op: 'warm_mp_part', generation: g, part: 'cache', partNumber: 7 });
    expect(parseSnapshotRoute('POST', `/warm/${g}/repo/multipart/complete`)).toEqual({ op: 'warm_mp_complete', generation: g, part: 'repo' });
    expect(parseSnapshotRoute('DELETE', `/warm/${g}/repo/multipart`)).toEqual({ op: 'warm_mp_abort', generation: g, part: 'repo' });
    for (const [m, p] of [
      ['PUT', `/warm/${g}/repo/multipart/0`],
      ['PUT', `/warm/${g}/repo/multipart/10001`],
      ['PUT', `/warm/${g}/repo/multipart/01`],
      ['PUT', `/warm/${g}/manifest/multipart/1`],
      ['GET', `/warm/${g}/repo/multipart`],
    ] as const) expect(parseSnapshotRoute(m, p)).toBeNull();
  });

  test('create → parts → complete writes the part at the generation key; the commit sees it', async () => {
    const gen = await begin();
    const id = await create(gen);
    const p1 = await putPart(gen, 1, 'aaaa', id);
    expect(p1.status).toBe(201);
    const p2 = await putPart(gen, 2, 'bb', id);
    const parts = [await p1.json(), await p2.json()];
    const done = await call('POST', `/warm/${gen}/repo/multipart/complete`, JSON.stringify({ parts }), scope, { [ID]: id });
    expect(done.status).toBe(201);
    expect(await done.json()).toEqual({ bytes: 6 });
    expect(new TextDecoder().decode(bucket.objects.get(warmKey(WS, gen, 'repo'))!.data)).toBe('aaaabb');
    const commit = await call('POST', `/warm/${gen}/commit`, JSON.stringify({ defaultBranch: 'dev' }));
    expect(commit.status).toBe(201);
    expect(((await commit.json()) as { repoBytes: number }).repoBytes).toBe(6);
  });

  test('every part is streamed to the bucket with its known length', async () => {
    const lengths: number[] = [];
    const gen = await begin();
    const id = await create(gen);
    const r = await handleSnapshotRequest(
      req('PUT', `/warm/${gen}/repo/multipart/1`, 'abc', { 'content-length': '3', [ID]: id }), scope, store,
      { fixedLength: (body, n) => { lengths.push(n); return body; } },
    );
    expect(r.status).toBe(201);
    expect(lengths).toEqual([3]);
  });

  test('only the lock holder; a part needs the upload id and a content-length within the part limit', async () => {
    const gen = await begin();
    const id = await create(gen);
    expect((await call('POST', `/warm/0000000000000009/repo/multipart`, '{}')).status).toBe(409);
    expect((await call('PUT', `/warm/${gen}/repo/multipart/1`, 'x')).status).toBe(400);
    const noLen = await handleSnapshotRequest(
      req('PUT', `/warm/${gen}/repo/multipart/1`, new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), { [ID]: id }),
      scope, store);
    expect(noLen.status).toBe(411);
    expect((await call('PUT', `/warm/${gen}/repo/multipart/1`, 'x', scope, { [ID]: id, 'content-length': String(MAX_PART_BYTES + 1) })).status).toBe(413);
    expect((await putPart(gen, 1, 'x', 'mp-not-mine')).status).toBe(400);
  });

  test('a completed part over the cap is refused and deleted, so it can never be committed', async () => {
    const gen = await begin();
    const id = await create(gen);
    const p1 = await (await putPart(gen, 1, 'aaaa', id)).json();
    const p2 = await (await putPart(gen, 2, 'aaaa', id)).json();
    const r = await handleSnapshotRequest(
      req('POST', `/warm/${gen}/repo/multipart/complete`, JSON.stringify({ parts: [p1, p2] }), { [ID]: id }), scope, store,
      { maxPartBytes: 5 },
    );
    expect(r.status).toBe(413);
    expect(bucket.objects.has(warmKey(WS, gen, 'repo'))).toBe(false);
    expect((await call('POST', `/warm/${gen}/commit`, JSON.stringify({ defaultBranch: 'dev' }))).status).toBe(409);
  });

  test('a single PUT over the cap is refused up front', async () => {
    const gen = await begin();
    const r = await handleSnapshotRequest(req('PUT', `/warm/${gen}/repo`, 'abcdef', { 'content-length': '6' }), scope, store, { maxPartBytes: 5 });
    expect(r.status).toBe(413);
  });

  test('abort drops the upload', async () => {
    const gen = await begin();
    const id = await create(gen);
    await putPart(gen, 1, 'aaaa', id);
    expect((await call('DELETE', `/warm/${gen}/repo/multipart`, undefined, scope, { [ID]: id })).status).toBe(200);
    expect(bucket.aborted).toEqual([id]);
    expect(bucket.uploads.size).toBe(0);
  });

  test('a malformed parts list is a 400, not a bucket call', async () => {
    const gen = await begin();
    const id = await create(gen);
    for (const body of ['nope', '{}', JSON.stringify({ parts: [{ partNumber: 'x', etag: 1 }] }), JSON.stringify({ parts: [] })]) {
      expect((await call('POST', `/warm/${gen}/repo/multipart/complete`, body, scope, { [ID]: id })).status).toBe(400);
    }
  });
});

describe('park bundles', () => {
  const parkScope: SnapshotScope = { workspaceId: WS, workerId: 'worker-1' };

  test('PUT / GET / DELETE /park use park/<workspace>/<worker>, from the scope only', async () => {
    const put = await call('PUT', '/park', 'park-bytes', parkScope);
    expect(put.status).toBe(201);
    expect(bucket.objects.has(parkKey(WS, 'worker-1'))).toBe(true);
    expect(parkKey(WS, 'worker-1')).toBe(`park/${WS}/worker-1/bundle.tar`);
    const got = await call('GET', '/park', undefined, parkScope);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('park-bytes');
    expect((await call('DELETE', '/park', undefined, parkScope)).status).toBe(200);
    expect(bucket.objects.has(parkKey(WS, 'worker-1'))).toBe(false);
    expect((await call('GET', '/park', undefined, parkScope)).status).toBe(404);
  });

  test("a different worker's scope cannot read another worker's bundle, even in the same workspace", async () => {
    await call('PUT', '/park', 'mine', parkScope);
    const other = await call('GET', '/park?worker=worker-1', undefined, { workspaceId: WS, workerId: 'worker-2' });
    expect(other.status).toBe(404);
  });

  test('no worker in the scope (claim not seen yet): 503', async () => {
    expect((await call('PUT', '/park', 'x', { workspaceId: WS })).status).toBe(503);
  });

  test('a path cannot name a worker', () => {
    expect(parseSnapshotRoute('GET', '/park/worker-2')).toBeNull();
    expect(parseSnapshotRoute('PUT', '/park')).toEqual({ op: 'park_put' });
    expect(parseSnapshotRoute('POST', '/park')).toBeNull();
  });

  test('each family can be switched off on its own', async () => {
    const warmOnly = { enabled: { warm: true, park: false } };
    expect((await handleSnapshotRequest(req('GET', '/park'), parkScope, store, warmOnly)).status).toBe(404);
    const parkOnly = { enabled: { warm: false, park: true } };
    expect((await handleSnapshotRequest(req('GET', '/warm'), parkScope, store, parkOnly)).status).toBe(404);
  });

  test('size guard applies to park uploads too', async () => {
    expect((await call('PUT', '/park', 'x', parkScope, { 'content-length': String(MAX_SNAPSHOT_BYTES + 1) })).status).toBe(413);
  });
});
