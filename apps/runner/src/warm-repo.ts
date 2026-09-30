/**
 * Warm repos for the cloud runner (docs/design/cloudflare-sandbox-runner.md,
 * Phase 2 "Warm repos"). A per-workspace snapshot, held in R2 by the
 * dispatcher Worker, is restored before `git clone`:
 *
 *   - a `git bundle` of the clone's remote-tracking refs (objects and refs
 *     only: no config, no hooks, no local branches, no working tree), and
 *   - a tarball of the bun install cache, so worktree installs link from it.
 *
 * The container reaches the store only through a reserved pseudo-host that
 * the Worker's egress handler serves (apps/cloud-runner/src/snapshots.ts).
 * The Worker picks every object key from its own identity for the run; the
 * paths here name an operation, never a key.
 *
 * The snapshot is a cache and is never required: any failure falls back to
 * the normal clone. Off unless the Worker sets BUILDD_WARM_REPO=1 and
 * BUILDD_SNAPSHOT_URL; nothing here runs on a host runner.
 *
 * Synchronous on purpose: the workspace resolver that clones is synchronous.
 * HTTP goes through `curl` (the image has it, and it trusts the egress CA via
 * CURL_CA_BUNDLE, set by buildd-once).
 */
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative } from 'path';
import {
  emitMetric,
  emitPhase,
  emitRepoSource,
  type RepoFallbackReason,
  type RunMetric,
} from './phase-lines';

export const WARM_ENV_FLAG = 'BUILDD_WARM_REPO';
export const SNAPSHOT_URL_ENV = 'BUILDD_SNAPSHOT_URL';

/** Refresh a warm snapshot older than this after a successful task. */
export const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** ...or whose post-restore fetch brought in more than this. */
export const WARM_FETCH_REFRESH_BYTES = 64 * 1024 * 1024;
/** Skip the warm path when the snapshot is larger than this fraction of free disk. */
export const WARM_DISK_FRACTION = 0.25;
/** Single-part R2 uploads top out near 5 GiB; stay under it. */
export const WARM_MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSFER_TIMEOUT_S = 30 * 60;
const CONTROL_TIMEOUT_S = 30;

/** Never copied into the cache tarball, at any depth. */
const CACHE_EXCLUDED_NAMES = /^(\.npmrc|\.yarnrc(\.yml)?|\.netrc|bunfig\.toml|\.env(\..*)?)$/;

export function warmRepoEnabled(env: Record<string, string | undefined>): boolean {
  return env[WARM_ENV_FLAG] === '1' && !!env[SNAPSHOT_URL_ENV];
}

/** Where bun keeps its global install cache in this process's environment. */
export function bunCacheDir(env: Record<string, string | undefined>): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  return join(env.BUN_INSTALL || join(env.HOME || homedir(), '.bun'), 'install', 'cache');
}

// ── Transport ─────────────────────────────────────────────────────────────────

/** `status: 0` means the store could not be reached at all. */
export interface SnapshotTransport {
  getJson(path: string): { status: number; body: unknown };
  download(path: string, file: string): { status: number; bytes: number };
  upload(path: string, file: string): { status: number; body: unknown };
  post(path: string, body?: unknown): { status: number; body: unknown };
  /** DELETE (park bundles). */
  remove?(path: string): { status: number };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** Splits curl output written with `-w '\n%{http_code}'`. */
function splitStatus(out: string): { status: number; text: string } {
  const nl = out.lastIndexOf('\n');
  const code = Number(out.slice(nl + 1).trim());
  return { status: Number.isFinite(code) ? code : 0, text: nl >= 0 ? out.slice(0, nl) : '' };
}

export function curlTransport(baseUrl: string): SnapshotTransport {
  const base = baseUrl.replace(/\/+$/, '');
  const curl = (args: string[], input?: string) => {
    const r = spawnSync('curl', ['-s', ...args], { encoding: 'utf-8', input, maxBuffer: 16 * 1024 * 1024 });
    return r.status === null ? '' : r.stdout ?? '';
  };
  return {
    getJson(path) {
      const { status, text } = splitStatus(curl(['--max-time', String(CONTROL_TIMEOUT_S), '-w', '\n%{http_code}', `${base}${path}`]));
      return { status, body: status === 200 ? parseJson(text) : null };
    },
    download(path, file) {
      const out = curl(['--max-time', String(TRANSFER_TIMEOUT_S), '-o', file, '-w', '%{http_code} %{size_download}', `${base}${path}`]);
      const [code, size] = out.trim().split(' ');
      const status = Number(code) || 0;
      if (status !== 200) rmSync(file, { force: true });
      return { status, bytes: status === 200 ? Number(size) || 0 : 0 };
    },
    upload(path, file) {
      const { status, text } = splitStatus(curl([
        '--max-time', String(TRANSFER_TIMEOUT_S), '-T', file,
        '-H', 'content-type: application/octet-stream', '-H', 'Expect:',
        '-w', '\n%{http_code}', `${base}${path}`,
      ]));
      return { status, body: parseJson(text) };
    },
    remove(path) {
      const { status } = splitStatus(curl(['--max-time', String(CONTROL_TIMEOUT_S), '-X', 'DELETE', '-w', '\n%{http_code}', `${base}${path}`]));
      return { status };
    },
    post(path, body) {
      const { status, text } = splitStatus(curl([
        '--max-time', String(CONTROL_TIMEOUT_S), '-X', 'POST', '-H', 'content-type: application/json',
        '--data-binary', '@-', '-w', '\n%{http_code}', `${base}${path}`,
      ], JSON.stringify(body ?? {})));
      return { status, body: parseJson(text) };
    },
  };
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface WarmManifest {
  generation: string;
  createdAt: number;
  repoBytes: number;
  cacheBytes: number;
  defaultBranch: string;
}

const GENERATION_RE = /^\d{16}$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;

export function parseWarmManifest(body: unknown): WarmManifest | null {
  const b = body as Partial<WarmManifest> | null;
  if (!b || typeof b.generation !== 'string' || !GENERATION_RE.test(b.generation)) return null;
  if (typeof b.defaultBranch !== 'string' || !BRANCH_RE.test(b.defaultBranch)) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const createdAt = n(b.createdAt), repoBytes = n(b.repoBytes), cacheBytes = n(b.cacheBytes);
  if (createdAt === null || repoBytes === null || cacheBytes === null || repoBytes === 0) return null;
  return { generation: b.generation, createdAt, repoBytes, cacheBytes, defaultBranch: b.defaultBranch };
}

// ── Credential guard ──────────────────────────────────────────────────────────

function gitOut(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/**
 * Throws if the clone's own config could carry a credential into a snapshot
 * or back out of one: any `credential.*` key, any `http.*.extraheader`, or a
 * remote URL with userinfo over http(s). A bundle holds no config at all, so
 * this is belt and braces: the container holds no credential by design
 * (credentials are added at egress), and this keeps it that way.
 */
export function assertSnapshotSafe(clonePath: string): void {
  const local = gitOut(clonePath, ['config', '--local', '--list']);
  for (const line of local.split('\n')) {
    const key = line.split('=')[0]!.toLowerCase();
    if (key.startsWith('credential.')) throw new Error('clone config has a credential.* setting');
    if (key.startsWith('http.') && key.endsWith('.extraheader')) throw new Error('clone config has an http extraheader');
    if (key.startsWith('remote.') && key.endsWith('.url')) {
      const url = line.slice(line.indexOf('=') + 1);
      if (/^https?:\/\/[^/]*@/i.test(url)) throw new Error('a remote URL carries userinfo');
    }
  }
}

// ── Cache tarball ─────────────────────────────────────────────────────────────

/**
 * Tar the bun cache without following symlinks and without any registry
 * config or env file (by name, at any depth). The file list is built here
 * rather than with tar's --exclude, whose matching differs between GNU tar
 * and bsdtar.
 */
export function createCacheTarball(cacheDir: string, outFile: string): boolean {
  if (!existsSync(cacheDir)) return false;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (CACHE_EXCLUDED_NAMES.test(e.name) || e.name.includes('\n')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() || e.isSymbolicLink()) files.push(relative(cacheDir, abs));
    }
  };
  walk(cacheDir);
  if (files.length === 0) return false;
  const list = `${outFile}.list`;
  writeFileSync(list, `${files.join('\n')}\n`);
  try {
    const r = spawnSync('tar', ['-cf', outFile, '-C', cacheDir, '-T', list], { stdio: ['ignore', 'ignore', 'pipe'], timeout: GIT_TIMEOUT_MS });
    return r.status === 0;
  } finally {
    rmSync(list, { force: true });
  }
}

// ── Refresh rules ─────────────────────────────────────────────────────────────

export type WarmResult =
  | { source: 'warm'; ageMs: number; fetchBytes: number }
  | { source: 'clone'; reason: RepoFallbackReason };

export type RunEnd = 'completed' | 'failed' | 'wait_timeout' | 'parked';

/**
 * - seed: the workspace had no usable snapshot (none, or a corrupt one).
 *   Uploaded whatever the outcome: the bundle holds origin's refs only, so it
 *   does not depend on how the task went, and a workspace whose first tasks
 *   fail still gets warm.
 * - refresh: a warm restore that is old, or whose fetch was large, after a
 *   task that completed.
 * - none: everything else, including a store that was unreachable or a disk
 *   too small, where an upload would fail the same way.
 */
export function decideWarmRefresh(result: WarmResult, end: RunEnd): 'seed' | 'refresh' | 'none' {
  if (result.source === 'clone') {
    return result.reason === 'no_snapshot' || result.reason === 'restore_failed' ? 'seed' : 'none';
  }
  if (end !== 'completed') return 'none';
  return result.ageMs > WARM_MAX_AGE_MS || result.fetchBytes > WARM_FETCH_REFRESH_BYTES ? 'refresh' : 'none';
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface WarmRepoDeps {
  transport: SnapshotTransport;
  cacheDir: string;
  tmpDir: string;
  /** Free bytes on the filesystem holding `path`, or null if unknown. */
  freeBytes(path: string): number | null;
  now(): number;
  log(message: string): void;
  /** Where phase / metric / source lines go (phase-lines.ts). */
  lineOpts?: { env?: Record<string, string | undefined>; log?: (line: string) => void };
}

export interface CloneHooks {
  /** Try the warm path into `clonePath`. True: restored, skip the clone. */
  restore(clonePath: string, cloneUrl: string): boolean;
  /** After a normal clone succeeded. */
  afterClone(clonePath: string): void;
}

export function freeBytesOf(path: string): number | null {
  try {
    let p = path;
    while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Bytes git keeps for objects in `repo` (loose + packed). */
export function objectBytes(repo: string): number {
  const out = gitOut(repo, ['count-objects', '-v']);
  let kib = 0;
  for (const line of out.split('\n')) {
    const m = /^(size|size-pack): (\d+)$/.exec(line.trim());
    if (m) kib += Number(m[2]);
  }
  return kib * 1024;
}

function run(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? '').trim().split('\n').at(-1) ?? r.status}`);
}

/**
 * One run's warm-repo state: how its clone got onto the disk (restore) and,
 * at the end, whether to upload a new generation (refresh). The clone path
 * and fetch size from the restore feed the refresh decision.
 */
export class WarmRepoSession {
  /** Set when the flag is off: the hooks still report `clone disabled`. */
  disabled = false;
  result: WarmResult | null = null;
  private clonePath: string | null = null;

  constructor(readonly d: WarmRepoDeps) {}

  cloneHooks(): CloneHooks {
    return {
      restore: (clonePath, cloneUrl) => this.restore(clonePath, cloneUrl),
      afterClone: (clonePath) => {
        this.clonePath = clonePath;
        emitMetric('clone_bytes', objectBytes(clonePath), this.d.lineOpts);
      },
    };
  }

  private metric(name: RunMetric, value: number): void {
    emitMetric(name, value, this.d.lineOpts);
  }

  private fallback(reason: RepoFallbackReason, why?: string): false {
    this.result = { source: 'clone', reason };
    emitRepoSource('clone', reason, this.d.lineOpts);
    if (why) this.d.log(`[warm] ${why}; cloning instead`);
    return false;
  }

  restore(clonePath: string, cloneUrl: string): boolean {
    this.clonePath = clonePath;
    if (this.disabled) return this.fallback('disabled');
    const got = this.d.transport.getJson('/warm');
    if (got.status === 404) return this.fallback('no_snapshot', 'no warm snapshot for this workspace yet');
    const manifest = got.status === 200 ? parseWarmManifest(got.body) : null;
    if (!manifest) return this.fallback('unavailable', `snapshot store answered ${got.status || 'nothing'}`);

    const free = this.d.freeBytes(dirname(clonePath));
    const needed = manifest.repoBytes + manifest.cacheBytes;
    if (free !== null && needed > free * WARM_DISK_FRACTION) {
      return this.fallback('disk', `snapshot is ${needed} bytes, more than ${WARM_DISK_FRACTION} of ${free} free`);
    }

    mkdirSync(this.d.tmpDir, { recursive: true });
    const bundle = join(this.d.tmpDir, `warm-${manifest.generation}.bundle`);
    emitPhase('restore_warm_start', this.d.lineOpts);
    let restored = false;
    try {
      const dl = this.d.transport.download(`/warm/${manifest.generation}/repo`, bundle);
      if (dl.status !== 200) throw new Error(`bundle download answered ${dl.status || 'nothing'}`);
      mkdirSync(clonePath, { recursive: true });
      run(clonePath, ['init', '-q', '-b', manifest.defaultBranch]);
      run(clonePath, ['bundle', 'verify', '-q', bundle]);
      run(clonePath, ['fetch', '-q', '--no-tags', bundle, '+refs/remotes/origin/*:refs/remotes/origin/*']);
      run(clonePath, ['remote', 'add', 'origin', cloneUrl]);
      const head = `refs/remotes/origin/${manifest.defaultBranch}`;
      run(clonePath, ['rev-parse', '--verify', '-q', head]);
      run(clonePath, ['symbolic-ref', 'refs/remotes/origin/HEAD', head]);
      run(clonePath, ['checkout', '-q', '-B', manifest.defaultBranch, '--track', `origin/${manifest.defaultBranch}`]);
      this.metric('restore_bytes', dl.bytes);
      restored = true;
    } catch (err) {
      this.d.log(`[warm] restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rmSync(bundle, { force: true });
      emitPhase('restore_warm_end', this.d.lineOpts);
    }
    if (!restored) {
      rmSync(clonePath, { recursive: true, force: true });
      return this.fallback('restore_failed');
    }

    this.restoreCache(manifest);

    emitPhase('fetch_start', this.d.lineOpts);
    const before = objectBytes(clonePath);
    let fetchBytes = 0;
    try {
      run(clonePath, ['fetch', '-q', 'origin']);
      fetchBytes = Math.max(0, objectBytes(clonePath) - before);
      run(clonePath, ['merge', '-q', '--ff-only', `origin/${manifest.defaultBranch}`]);
    } catch (err) {
      // Stale but usable; setupWorktree fetches again and tolerates a failure.
      this.d.log(`[warm] fetch after restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitPhase('fetch_end', this.d.lineOpts);
    }
    this.metric('fetch_bytes', fetchBytes);
    const ageMs = Math.max(0, this.d.now() - manifest.createdAt);
    this.metric('snapshot_age_ms', ageMs);
    this.result = { source: 'warm', ageMs, fetchBytes };
    emitRepoSource('warm', undefined, this.d.lineOpts);
    this.d.log(`[warm] restored generation ${manifest.generation} (${ageMs} ms old, fetched ${fetchBytes} bytes)`);
    return true;
  }

  private restoreCache(manifest: WarmManifest): void {
    if (manifest.cacheBytes === 0) return;
    const tarball = join(this.d.tmpDir, `warm-${manifest.generation}.tar`);
    try {
      const dl = this.d.transport.download(`/warm/${manifest.generation}/cache`, tarball);
      if (dl.status !== 200) throw new Error(`cache download answered ${dl.status || 'nothing'}`);
      mkdirSync(this.d.cacheDir, { recursive: true });
      const r = spawnSync('tar', ['-xf', tarball, '-C', this.d.cacheDir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: GIT_TIMEOUT_MS });
      if (r.status !== 0) throw new Error('cache extract failed');
      this.metric('cache_bytes', dl.bytes);
    } catch (err) {
      this.d.log(`[warm] bun cache not restored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rmSync(tarball, { force: true });
    }
  }

  /** Best effort; never throws. Call once, after the run's outcome is known. */
  refresh(end: RunEnd): void {
    try {
      this.refreshOrThrow(end);
    } catch (err) {
      this.d.log(`[warm] snapshot upload skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private refreshOrThrow(end: RunEnd): void {
    const clonePath = this.clonePath;
    if (!this.result || !clonePath || !existsSync(join(clonePath, '.git'))) return;
    const decision = decideWarmRefresh(this.result, end);
    if (decision === 'none') return;
    assertSnapshotSafe(clonePath);

    const defaultBranch = gitOut(clonePath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
      || gitOut(clonePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!BRANCH_RE.test(defaultBranch) || defaultBranch === 'HEAD') throw new Error('no default branch to record');

    const begin = this.d.transport.post('/warm/begin');
    if (begin.status === 409) { this.d.log('[warm] another refresh of this workspace is in flight'); return; }
    const generation = (begin.body as { generation?: unknown } | null)?.generation;
    if (begin.status !== 201 || typeof generation !== 'string' || !GENERATION_RE.test(generation)) {
      throw new Error(`begin answered ${begin.status || 'nothing'}`);
    }

    mkdirSync(this.d.tmpDir, { recursive: true });
    const bundle = join(this.d.tmpDir, `upload-${generation}.bundle`);
    const tarball = join(this.d.tmpDir, `upload-${generation}.tar`);
    emitPhase('warm_upload_start', this.d.lineOpts);
    let uploaded = 0;
    try {
      // Remote-tracking refs only: local task branches may hold unpushed work.
      run(clonePath, ['bundle', 'create', '-q', bundle, '--remotes']);
      const repoSize = statSync(bundle).size;
      if (repoSize > WARM_MAX_UPLOAD_BYTES) throw new Error(`bundle is ${repoSize} bytes, over the upload limit`);
      const up = this.d.transport.upload(`/warm/${generation}/repo`, bundle);
      if (up.status !== 201) throw new Error(`bundle upload answered ${up.status || 'nothing'}`);
      uploaded += repoSize;
      if (createCacheTarball(this.d.cacheDir, tarball)) {
        const size = statSync(tarball).size;
        if (size <= WARM_MAX_UPLOAD_BYTES && this.d.transport.upload(`/warm/${generation}/cache`, tarball).status === 201) {
          uploaded += size;
        }
      }
      const commit = this.d.transport.post(`/warm/${generation}/commit`, { defaultBranch });
      if (commit.status !== 201) throw new Error(`commit answered ${commit.status || 'nothing'}`);
      this.d.log(`[warm] ${decision === 'seed' ? 'seeded' : 'refreshed'} generation ${generation} (${uploaded} bytes)`);
    } finally {
      rmSync(bundle, { force: true });
      rmSync(tarball, { force: true });
      emitPhase('warm_upload_end', this.d.lineOpts);
      this.metric('warm_upload_bytes', uploaded);
    }
  }
}

/** The session the --once CLI wiring uses. */
export function createWarmRepoSession(env: Record<string, string | undefined>, tmpDir: string): WarmRepoSession {
  const session = new WarmRepoSession({
    transport: curlTransport(env[SNAPSHOT_URL_ENV] ?? ''),
    cacheDir: bunCacheDir(env),
    tmpDir,
    freeBytes: freeBytesOf,
    now: Date.now,
    log: (m) => console.log(m),
  });
  session.disabled = !warmRepoEnabled(env);
  return session;
}

