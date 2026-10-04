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
 *
 *   A part of unknown length (the runner streams `git bundle create -` and
 *   `tar -c` straight up, never staging a file or holding the whole thing)
 *   goes up as an R2 multipart upload, lock holder only, the upload id in the
 *   x-buildd-upload-id header:
 *
 *   POST   /warm/<gen>/repo|cache/multipart           start; 201 {uploadId}
 *   PUT    /warm/<gen>/repo|cache/multipart/<n>       one part (content-length required); 201 {partNumber, etag}
 *   POST   /warm/<gen>/repo|cache/multipart/complete  {parts}; 201 {bytes}, or 413 (deleted) over the cap
 *   DELETE /warm/<gen>/repo|cache/multipart           abort
 *
 *   Every body is piped to R2 through a FixedLengthStream; nothing is read
 *   into Worker memory. The cap (WARM_MAX_BUNDLE_BYTES, default 1 GiB) is
 *   enforced on a single PUT's length and on a completed multipart object.
 *
 * Park bundles (resumable runs; `park/` at 2 days as the lifecycle backstop):
 *
 *   park/<workspaceId>/<workerId>/bundle.tar       branch, uncommitted work, transcript, worker record
 *
 *   PUT    /park                   upload this run's park bundle
 *   GET    /park                   fetch it (a resumed run)
 *   DELETE /park                   drop it once the resume took
 *
 * The worker is the one the agent is supervising (from the runner's
 * BUILDD_WORKER_ID line, or the task.resume dispatch), never the request's.
 */

export const SNAPSHOT_HOST = 'buildd-snapshots.invalid';

export const WARM_GENERATIONS_KEPT = 2;
/** A lock older than this belongs to a container that died mid-upload. */
export const WARM_LOCK_TTL_MS = 30 * 60 * 1000;
/** Single-part R2 put limit is about 5 GiB. */
export const MAX_SNAPSHOT_BYTES = 5 * 1000 ** 3;
/** One multipart part (R2: 5 MiB to 5 GiB; the runner sends 32 MiB). */
export const MAX_PART_BYTES = 512 * 1024 ** 2;
/** R2's part-number range. */
export const MAX_PART_NUMBER = 10_000;
/** The header naming a multipart upload (warm-repo.ts UPLOAD_ID_HEADER). */
export const UPLOAD_ID_HEADER = 'x-buildd-upload-id';
const UPLOAD_ID_RE = /^[\x21-\x7e]{1,1024}$/;

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
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUploadLike;
}

export interface UploadedPartLike {
  partNumber: number;
  etag: string;
}

export interface MultipartUploadLike {
  uploadPart(partNumber: number, value: ReadableStream | string): Promise<UploadedPartLike>;
  complete(parts: UploadedPartLike[]): Promise<BucketObjectLike>;
  abort(): Promise<void>;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/** What the Worker knows about the run, from buildd; never from the container. */
export interface SnapshotScope {
  workspaceId: string;
  /** The worker the agent is running; park bundles need it. */
  workerId?: string;
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

export function parkKey(workspaceId: string, workerId: string): string {
  return `park/${checkId(workspaceId)}/${checkId(workerId)}/bundle.tar`;
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
  | { op: 'warm_commit'; generation: string }
  | { op: 'warm_mp_create'; generation: string; part: WarmPart }
  | { op: 'warm_mp_part'; generation: string; part: WarmPart; partNumber: number }
  | { op: 'warm_mp_complete'; generation: string; part: WarmPart }
  | { op: 'warm_mp_abort'; generation: string; part: WarmPart }
  | { op: 'park_put' }
  | { op: 'park_get' }
  | { op: 'park_delete' };

/** Exact paths only. The query string is ignored and nothing in the path is ever a key. */
export function parseSnapshotRoute(method: string, pathname: string): SnapshotRoute | null {
  const m = method.toUpperCase();
  if (pathname === '/park') {
    if (m === 'PUT') return { op: 'park_put' };
    if (m === 'GET') return { op: 'park_get' };
    if (m === 'DELETE') return { op: 'park_delete' };
    return null;
  }
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
  const mp = /^\/warm\/(\d{16})\/(repo|cache)\/multipart(?:\/(complete|[1-9]\d{0,4}))?$/.exec(pathname);
  if (mp) {
    const generation = mp[1]!;
    const p = mp[2] as WarmPart;
    const tail = mp[3];
    if (tail === undefined) {
      if (m === 'POST') return { op: 'warm_mp_create', generation, part: p };
      if (m === 'DELETE') return { op: 'warm_mp_abort', generation, part: p };
      return null;
    }
    if (tail === 'complete') return m === 'POST' ? { op: 'warm_mp_complete', generation, part: p } : null;
    const partNumber = Number(tail);
    return m === 'PUT' && partNumber <= MAX_PART_NUMBER ? { op: 'warm_mp_part', generation, part: p, partNumber } : null;
  }
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

  // Multipart: a part streamed from `git bundle create -` (or `tar -c`) has no
  // length until it ends, and an R2 put needs one. Each multipart part does
  // have one. The key is still the scope's; the upload id only names which
  // upload of that key, and R2 refuses one that is not.

  async createPartUpload(workspaceId: string, generation: string, part: WarmPart): Promise<string> {
    const r = await this.bucket.createMultipartUpload(warmKey(workspaceId, generation, part), { httpMetadata: { contentType: 'application/octet-stream' } });
    return r.uploadId;
  }

  async uploadPartChunk(workspaceId: string, generation: string, part: WarmPart, uploadId: string, partNumber: number, body: ReadableStream): Promise<UploadedPartLike> {
    return this.bucket.resumeMultipartUpload(warmKey(workspaceId, generation, part), uploadId).uploadPart(partNumber, body);
  }

  async completePartUpload(workspaceId: string, generation: string, part: WarmPart, uploadId: string, parts: UploadedPartLike[]): Promise<BucketObjectLike> {
    return this.bucket.resumeMultipartUpload(warmKey(workspaceId, generation, part), uploadId).complete(parts);
  }

  async abortPartUpload(workspaceId: string, generation: string, part: WarmPart, uploadId: string): Promise<void> {
    await this.bucket.resumeMultipartUpload(warmKey(workspaceId, generation, part), uploadId).abort();
  }

  async deletePart(workspaceId: string, generation: string, part: WarmPart): Promise<void> {
    await this.bucket.delete(warmKey(workspaceId, generation, part));
  }

  async putPark(workspaceId: string, workerId: string, body: ReadableStream): Promise<number | null> {
    const put = await this.bucket.put(parkKey(workspaceId, workerId), body, { httpMetadata: { contentType: 'application/octet-stream' } });
    return put ? put.size : null;
  }

  async getPark(workspaceId: string, workerId: string): Promise<BucketBodyLike | null> {
    return this.bucket.get(parkKey(workspaceId, workerId));
  }

  async deletePark(workspaceId: string, workerId: string): Promise<void> {
    await this.bucket.delete(parkKey(workspaceId, workerId));
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
  /** Which families this Worker serves (WARM_REPOS, RESUMABLE_RUNS). Both on when absent. */
  enabled?: { warm: boolean; park: boolean };
  /**
   * Wrap an upload body so the bucket sees a known length (Workers:
   * `body.pipeThrough(new FixedLengthStream(n))`). Identity when absent.
   */
  fixedLength?(body: ReadableStream, length: number): ReadableStream;
  /**
   * Largest warm part (repo bundle or cache tarball) accepted, whole: a single
   * PUT past it is refused, a multipart one is deleted on completion. The
   * runner skips the upload before this (WARM_MAX_BUNDLE_BYTES); this is the
   * Worker's own word on it. MAX_SNAPSHOT_BYTES when absent.
   */
  maxPartBytes?: number;
}

/** `[{ partNumber, etag }]` from a complete request, or null when malformed. */
function parseParts(v: unknown): UploadedPartLike[] | null {
  const parts = (v as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PART_NUMBER) return null;
  const out: UploadedPartLike[] = [];
  for (const p of parts) {
    const { partNumber, etag } = (p ?? {}) as { partNumber?: unknown; etag?: unknown };
    if (typeof partNumber !== 'number' || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) return null;
    if (typeof etag !== 'string' || etag.length === 0 || etag.length > 1024) return null;
    out.push({ partNumber, etag });
  }
  return out;
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
  const isPark = route.op.startsWith('park_');
  const enabled = opts.enabled ?? { warm: true, park: true };
  if (isPark ? !enabled.park : !enabled.warm) return json({ error: 'not_found' }, 404);
  if (!scope || !SCOPE_ID_RE.test(scope.workspaceId)) return json({ error: 'unavailable' }, 503);
  const ws = scope.workspaceId;
  if (isPark && (!scope.workerId || !SCOPE_ID_RE.test(scope.workerId))) return json({ error: 'unavailable' }, 503);
  const maxPart = opts.maxPartBytes ?? MAX_SNAPSHOT_BYTES;

  switch (route.op) {
    case 'park_put': {
      const len = Number(request.headers.get('content-length'));
      if (!request.headers.has('content-length') || !Number.isSafeInteger(len) || len < 0) return json({ error: 'length_required' }, 411);
      if (len > MAX_SNAPSHOT_BYTES) return json({ error: 'too_large' }, 413);
      if (!request.body) return json({ error: 'empty' }, 400);
      const body = opts.fixedLength ? opts.fixedLength(request.body, len) : request.body;
      const size = await store.putPark(ws, scope.workerId!, body);
      return size === null ? json({ error: 'put_failed' }, 500) : json({ bytes: size }, 201);
    }
    case 'park_get': {
      const obj = await store.getPark(ws, scope.workerId!);
      if (!obj) return json({ error: 'not_found' }, 404);
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
    }
    case 'park_delete': {
      await store.deletePark(ws, scope.workerId!);
      return json({ ok: true });
    }
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
    case 'warm_mp_create': {
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      return json({ uploadId: await store.createPartUpload(ws, route.generation, route.part) }, 201);
    }
    case 'warm_mp_part': {
      const uploadId = request.headers.get(UPLOAD_ID_HEADER) ?? '';
      if (!UPLOAD_ID_RE.test(uploadId)) return json({ error: 'upload_id_required' }, 400);
      const len = Number(request.headers.get('content-length'));
      if (!request.headers.has('content-length') || !Number.isSafeInteger(len) || len < 0) return json({ error: 'length_required' }, 411);
      if (len > MAX_PART_BYTES || len > maxPart) return json({ error: 'too_large' }, 413);
      if (!request.body) return json({ error: 'empty' }, 400);
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      const body = opts.fixedLength ? opts.fixedLength(request.body, len) : request.body;
      try {
        return json(await store.uploadPartChunk(ws, route.generation, route.part, uploadId, route.partNumber, body), 201);
      } catch {
        // R2 refuses an upload id that is not this key's (or no longer open).
        return json({ error: 'upload_failed' }, 400);
      }
    }
    case 'warm_mp_complete': {
      const uploadId = request.headers.get(UPLOAD_ID_HEADER) ?? '';
      if (!UPLOAD_ID_RE.test(uploadId)) return json({ error: 'upload_id_required' }, 400);
      let parts: UploadedPartLike[] | null;
      try {
        parts = parseParts(await request.json());
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }
      if (!parts) return json({ error: 'invalid_parts' }, 400);
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      let obj: BucketObjectLike;
      try {
        obj = await store.completePartUpload(ws, route.generation, route.part, uploadId, parts);
      } catch {
        return json({ error: 'complete_failed' }, 400);
      }
      if (obj.size > maxPart) {
        await store.deletePart(ws, route.generation, route.part);
        return json({ error: 'too_large' }, 413);
      }
      return json({ bytes: obj.size }, 201);
    }
    case 'warm_mp_abort': {
      const uploadId = request.headers.get(UPLOAD_ID_HEADER) ?? '';
      if (!UPLOAD_ID_RE.test(uploadId)) return json({ error: 'upload_id_required' }, 400);
      if (!(await store.holdsLock(ws, route.generation))) return json({ error: 'not_lock_holder' }, 409);
      try {
        await store.abortPartUpload(ws, route.generation, route.part, uploadId);
      } catch {
        // Already gone; the bucket's lifecycle rule is the backstop either way.
      }
      return json({ ok: true });
    }
    case 'warm_put': {
      const len = Number(request.headers.get('content-length'));
      if (!request.headers.has('content-length') || !Number.isSafeInteger(len) || len < 0) return json({ error: 'length_required' }, 411);
      if (len > MAX_SNAPSHOT_BYTES || len > maxPart) return json({ error: 'too_large' }, 413);
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
