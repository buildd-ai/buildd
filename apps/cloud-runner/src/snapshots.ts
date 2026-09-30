/**
 * The Worker-mediated snapshot store (docs/design/cloudflare-sandbox-runner.md,
 * Phase 2 "The crux" and "Warm repos"). The container reaches it at the
 * pseudo-host SNAPSHOT_HOST, whose traffic the egress handler intercepts
 * (egress.ts) and hands to `handleSnapshotRequest`. The container never
 * holds an R2 credential or a presigned URL, and it never names a key: the
 * path names an operation, and the key is built from the scope the Worker
 * supplies (the workspace ID buildd returned with the task's GitHub grant).
 *
 * Runtime-free: the bucket is a port (R2Bucket satisfies it), so Bun tests
 * drive it with an in-memory fake.
 *
 * Layout (the kind comes first so an R2 lifecycle rule, which matches by
 * prefix only, can expire each kind: `warm/` at 14 days):
 *
 *   warm/<workspaceId>/<generation>/repo.bundle     git bundle, remote refs only
 *   warm/<workspaceId>/<generation>/bun-cache.tar   bun install cache (optional)
 *   warm/<workspaceId>/<generation>/manifest.json   written last: the commit
 *   warm/<workspaceId>/lock                         one refresh in flight
 *
 * Operations (paths on SNAPSHOT_HOST; anything else is 404):
 *
 *   GET  /warm                     latest committed manifest, or 404
 *   GET  /warm/<gen>/repo|cache    one part of a generation
 *   POST /warm/begin               take the refresh lock; 201 {generation} or 409
 *   PUT  /warm/<gen>/repo|cache    upload a part (lock holder only, content-length required)
 *   POST /warm/<gen>/commit        {defaultBranch}; publish, prune to two generations, unlock
 */

export const SNAPSHOT_HOST = 'buildd-snapshots.invalid';

export const WARM_GENERATIONS_KEPT = 2;
/** A lock older than this belongs to a container that died mid-upload. */
export const WARM_LOCK_TTL_MS = 30 * 60 * 1000;
/** Single-part R2 put limit is about 5 GiB. */
export const MAX_SNAPSHOT_BYTES = 5 * 1000 ** 3;

// ── Bucket port (the slice of R2Bucket used here) ─────────────────────────────

export interface BucketObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
}

export interface BucketBodyLike extends BucketObjectLike {
  body: ReadableStream;
  text(): Promise<string>;
}

export interface BucketPutOptions {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  httpMetadata?: { contentType?: string };
}

export interface BucketPort {
  head(key: string): Promise<BucketObjectLike | null>;
  get(key: string): Promise<BucketBodyLike | null>;
  /** Null when `onlyIf` did not hold. */
  put(key: string, value: ReadableStream | string, options?: BucketPutOptions): Promise<BucketObjectLike | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: BucketObjectLike[]; truncated: boolean; cursor?: string }>;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/** What the Worker knows about the run, from buildd; never from the container. */
export interface SnapshotScope {
  workspaceId: string;
}

export type WarmPart = 'repo' | 'cache';

const SCOPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GENERATION_RE = /^\d{16}$/;
const BRANCH_RE = /^(?!.*\.\.)(?![-/])[A-Za-z0-9._/-]{1,200}$/;
const PART_FILE: Record<WarmPart, string> = { repo: 'repo.bundle', cache: 'bun-cache.tar' };

function checkId(v: string): string {
  if (!SCOPE_ID_RE.test(v)) throw new Error('invalid scope id');
  return v;
}
function checkGeneration(v: string): string {
  if (!GENERATION_RE.test(v)) throw new Error('invalid generation');
  return v;
}

export function warmPrefix(workspaceId: string): string {
  return `warm/${checkId(workspaceId)}/`;
}
export function warmKey(workspaceId: string, generation: string, part: WarmPart | 'manifest'): string {
  const file = part === 'manifest' ? 'manifest.json' : PART_FILE[part];
  return `${warmPrefix(workspaceId)}${checkGeneration(generation)}/${file}`;
}
export function warmLockKey(workspaceId: string): string {
  return `${warmPrefix(workspaceId)}lock`;
}

export function formatGeneration(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(16, '0');
}

// ── Routes ────────────────────────────────────────────────────────────────────

export type SnapshotRoute =
  | { op: 'warm_latest' }
  | { op: 'warm_begin' }
  | { op: 'warm_get'; generation: string; part: WarmPart }
  | { op: 'warm_put'; generation: string; part: WarmPart }
  | { op: 'warm_commit'; generation: string };

/** Exact paths only. The query string is ignored and nothing in the path is ever a key. */
export function parseSnapshotRoute(method: string, pathname: string): SnapshotRoute | null {
  const m = method.toUpperCase();
  if (pathname === '/warm') return m === 'GET' ? { op: 'warm_latest' } : null;
  if (pathname === '/warm/begin') return m === 'POST' ? { op: 'warm_begin' } : null;
  const part = /^\/warm\/(\d{16})\/(repo|cache)$/.exec(pathname);
  if (part) {
    const generation = part[1]!;
    const p = part[2] as WarmPart;
    if (m === 'GET') return { op: 'warm_get', generation, part: p };
    if (m === 'PUT') return { op: 'warm_put', generation, part: p };
    return null;
  }
  const commit = /^\/warm\/(\d{16})\/commit$/.exec(pathname);
  if (commit && m === 'POST') return { op: 'warm_commit', generation: commit[1]! };
  return null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export interface WarmManifest {
  generation: string;
  createdAt: number;
  repoBytes: number;
  cacheBytes: number;
  defaultBranch: string;
}

interface WarmLock {
  generation: string;
  at: number;
}

function parseLock(text: string): WarmLock | null {
  try {
    const v = JSON.parse(text) as Partial<WarmLock>;
    return typeof v.generation === 'string' && GENERATION_RE.test(v.generation) && typeof v.at === 'number' ? { generation: v.generation, at: v.at } : null;
  } catch {
    return null;
  }
}

export type BeginResult = { ok: true; generation: string } | { ok: false; reason: 'busy' };

export class SnapshotStore {
  constructor(private readonly bucket: BucketPort, private readonly now: () => number = Date.now) {}

  private async listAll(prefix: string): Promise<BucketObjectLike[]> {
    const out: BucketObjectLike[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const r = await this.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      out.push(...r.objects);
      if (!r.truncated || !r.cursor) break;
      cursor = r.cursor;
    }
    return out;
  }

  /** Generations under the workspace, newest first, with whether each is committed. */
  private async generations(workspaceId: string): Promise<Array<{ generation: string; committed: boolean; keys: string[] }>> {
    const prefix = warmPrefix(workspaceId);
    const byGen = new Map<string, { committed: boolean; keys: string[] }>();
    for (const o of await this.listAll(prefix)) {
      const [gen, file] = o.key.slice(prefix.length).split('/');
      if (!gen || !file || !GENERATION_RE.test(gen)) continue;
      const g = byGen.get(gen) ?? { committed: false, keys: [] };
      g.keys.push(o.key);
      if (file === 'manifest.json') g.committed = true;
      byGen.set(gen, g);
    }
    return [...byGen.entries()].map(([generation, g]) => ({ generation, ...g })).sort((a, b) => (a.generation < b.generation ? 1 : -1));
  }

  async latest(workspaceId: string): Promise<WarmManifest | null> {
    const gen = (await this.generations(workspaceId)).find(g => g.committed);
    if (!gen) return null;
    const obj = await this.bucket.get(warmKey(workspaceId, gen.generation, 'manifest'));
    if (!obj) return null;
    try {
      return JSON.parse(await obj.text()) as WarmManifest;
    } catch {
      return null;
    }
  }

  async getPart(workspaceId: string, generation: string, part: WarmPart): Promise<BucketBodyLike | null> {
    return this.bucket.get(warmKey(workspaceId, generation, part));
  }

  private async currentLock(workspaceId: string): Promise<{ lock: WarmLock | null; etag: string | null }> {
    const obj = await this.bucket.get(warmLockKey(workspaceId));
    if (!obj) return { lock: null, etag: null };
    return { lock: parseLock(await obj.text()), etag: obj.etag };
  }

  private fresh(lock: WarmLock | null): lock is WarmLock {
    return !!lock && this.now() - lock.at < WARM_LOCK_TTL_MS;
  }

  /**
   * Take the per-workspace refresh lock with a conditional put: create-only
   * when there is none, or replace-if-unchanged when the one there is stale.
   * Two containers racing both see the same state and exactly one put holds.
   */
  async begin(workspaceId: string): Promise<BeginResult> {
    const { lock, etag } = await this.currentLock(workspaceId);
    if (this.fresh(lock)) return { ok: false, reason: 'busy' };
    const newest = (await this.generations(workspaceId))[0]?.generation;
    let n = this.now();
    if (newest && Number(newest) >= n) n = Number(newest) + 1;
    const generation = formatGeneration(n);
    const onlyIf = etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' };
    const put = await this.bucket.put(warmLockKey(workspaceId), JSON.stringify({ generation, at: this.now() } satisfies WarmLock), { onlyIf });
    return put ? { ok: true, generation } : { ok: false, reason: 'busy' };
  }

  async holdsLock(workspaceId: string, generation: string): Promise<boolean> {
    const { lock } = await this.currentLock(workspaceId);
    return this.fresh(lock) && lock.generation === generation;
  }

  async putPart(workspaceId: string, generation: string, part: WarmPart, body: ReadableStream): Promise<number | null> {
    const put = await this.bucket.put(warmKey(workspaceId, generation, part), body, { httpMetadata: { contentType: 'application/octet-stream' } });
    return put ? put.size : null;
  }

  /** Publish the generation, then prune, then unlock. Null when the repo part is missing. */
  async commit(workspaceId: string, generation: string, defaultBranch: string): Promise<WarmManifest | null> {
    const repo = await this.bucket.head(warmKey(workspaceId, generation, 'repo'));
    if (!repo) return null;
    const cache = await this.bucket.head(warmKey(workspaceId, generation, 'cache'));
    const manifest: WarmManifest = { generation, createdAt: this.now(), repoBytes: repo.size, cacheBytes: cache?.size ?? 0, defaultBranch };
    await this.bucket.put(warmKey(workspaceId, generation, 'manifest'), JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
    await this.prune(workspaceId);
    await this.bucket.delete(warmLockKey(workspaceId));
    return manifest;
  }

  /**
   * Keep the newest WARM_GENERATIONS_KEPT committed generations. Everything
   * older than the oldest kept one goes, including uploads that never
   * committed. Newer uncommitted generations (a refresh in flight) stay.
   */
  async prune(workspaceId: string): Promise<void> {
    const gens = await this.generations(workspaceId);
    const committed = gens.filter(g => g.committed);
    if (committed.length <= WARM_GENERATIONS_KEPT) return;
    const floor = committed[WARM_GENERATIONS_KEPT - 1]!.generation;
    const doomed = gens.filter(g => g.generation < floor).flatMap(g => g.keys);
    for (let i = 0; i < doomed.length; i += 1000) await this.bucket.delete(doomed.slice(i, i + 1000));
  }
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface SnapshotHandlerOptions {
  /**
   * Wrap an upload body so the bucket sees a known length (Workers:
   * `body.pipeThrough(new FixedLengthStream(n))`). Identity when absent.
   */
  fixedLength?(body: ReadableStream, length: number): ReadableStream;
}

/**
 * Serve one intercepted request to SNAPSHOT_HOST. `scope` null means the
 * store is not available for this run (warm repos off, the run is not live,
 * or buildd gave no workspace ID); the runner then clones as usual.
 */
export async function handleSnapshotRequest(
  request: Request,
  scope: SnapshotScope | null,
  store: SnapshotStore,
  opts: SnapshotHandlerOptions = {},
): Promise<Response> {
  const route = parseSnapshotRoute(request.method, new URL(request.url).pathname);
  if (!route) return json({ error: 'not_found' }, 404);
  if (!scope || !SCOPE_ID_RE.test(scope.workspaceId)) return json({ error: 'unavailable' }, 503);
  const ws = scope.workspaceId;

  switch (route.op) {
    case 'warm_latest': {
      const m = await store.latest(ws);
      return m ? json(m) : json({ error: 'no_snapshot' }, 404);
    }
    case 'warm_get': {
      const obj = await store.getPart(ws, route.generation, route.part);
      if (!obj) return json({ error: 'not_found' }, 404);
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
    }
    case 'warm_begin': {
      const r = await store.begin(ws);
      return r.ok ? json({ generation: r.generation }, 201) : json({ error: 'busy' }, 409);
    }
    case 'warm_put': {
      const len = Number(request.headers.get('content-length'));
      if (!request.headers.has('content-length') || !Number.isSafeInteger(len) || len < 0) return json({ error: 'length_required' }, 411);
      if (len > MAX_SNAPSHOT_BYTES) return json({ error: 'too_large' }, 413);
      if (!request.body) return json({ error: 'empty' }, 400);
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      const body = opts.fixedLength ? opts.fixedLength(request.body, len) : request.body;
      const size = await store.putPart(ws, route.generation, route.part, body);
      return size === null ? json({ error: 'put_failed' }, 500) : json({ bytes: size }, 201);
    }
    case 'warm_commit': {
      let defaultBranch: unknown;
      try {
        defaultBranch = ((await request.json()) as { defaultBranch?: unknown } | null)?.defaultBranch;
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }
      if (typeof defaultBranch !== 'string' || !BRANCH_RE.test(defaultBranch)) return json({ error: 'invalid_default_branch' }, 400);
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      const m = await store.commit(ws, route.generation, defaultBranch);
      return m ? json(m, 201) : json({ error: 'repo_missing' }, 409);
    }
  }
}
