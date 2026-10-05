/**
 * Warm repos for the cloud runner (docs/design/cloudflare-sandbox-runner.md,
 * Phase 2 "Warm repos"). A per-workspace snapshot, held in R2 by the
 * dispatcher Worker, is restored before `git clone`:
 *
 *   - a `git bundle` of the clone's remote-tracking refs (objects and refs
 *     only: no config, no hooks, no local branches, no working tree), and
 *   - a tarball of the bun install cache (and the pnpm store nested in it),
 *     so worktree installs link from it. zstd-compressed when the image has
 *     zstd, streamed both ways (tar | zstd into the upload, the download into
 *     zstd -d | tar): neither direction keeps a copy of it on disk. A plain
 *     tarball from an older snapshot still restores (zstd -f passes it through).
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
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, relative } from 'path';
import {
  emitCacheSkipped,
  emitMetric,
  emitPhase,
  emitRepoSource,
  emitWarmUploadSkipped,
  emitWarmRefresh,
  type RepoFallbackReason,
  type RunMetric,
  type WarmRefreshReason,
} from './phase-lines';
import { fetchOriginWithRetry } from './git-clone';

export const WARM_ENV_FLAG = 'BUILDD_WARM_REPO';
/**
 * Set on every warm restore, before the fetch: the default branch's tip as
 * the snapshot had it. A park bundle (park.ts) is built against this rather
 * than the freshly fetched origin, so a resume restored onto the same (or a
 * newer) snapshot has every prerequisite without reaching origin. Local to the
 * clone: refresh bundles `--remotes` only, so it never enters a snapshot.
 */
export const WARM_BASE_REF = 'refs/buildd/warm-base';
export const SNAPSHOT_URL_ENV = 'BUILDD_SNAPSHOT_URL';

/** Refresh a warm snapshot older than this after a successful task. */
export const WARM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** ...or whose post-restore fetch brought in more than this. */
export const WARM_FETCH_REFRESH_BYTES = 64 * 1024 * 1024;
/** Skip the warm path when the snapshot is larger than this fraction of free disk. */
export const WARM_DISK_FRACTION = 0.25;
/**
 * The most any one part (bundle or cache tarball) may stream, whatever the
 * cap says. Uploads are multipart, so R2's single-PUT limit does not apply;
 * this mirrors the upper bound buildd puts on a workspace's
 * gitConfig.warmSnapshot.maxBytes (apps/web/src/lib/warm-snapshot-cap.ts).
 */
export const WARM_MAX_UPLOAD_BYTES = 8 * 1024 ** 3;
/**
 * Before tarring, the pnpm store is left out only when the cache on disk is
 * more than this many times the cap: zstd does about 4:1 on a real
 * package store, so anything above this cannot fit. Below it the store is
 * tried; if it still compresses past the cap the cache is sent again without
 * it (refreshOrThrow).
 */
export const WARM_CACHE_COMPRESSION_HEADROOM = 6;
/**
 * The largest warm bundle (or cache tarball) this container uploads, unless
 * the Worker sets BUILDD_WARM_MAX_BUNDLE_BYTES. Measured before anything is
 * bundled, and enforced again on the bytes as they stream. A repo past it is
 * cloned every time instead: on a small instance, bundling gigabytes costs
 * more (minutes of CPU, memory the agent needs) than the clone it saves.
 */
export const WARM_DEFAULT_MAX_BUNDLE_BYTES = 1024 ** 3;
export const WARM_MAX_BUNDLE_ENV = 'BUILDD_WARM_MAX_BUNDLE_BYTES';
/**
 * One multipart part. Every part but the last is exactly this size (R2
 * requires equal non-final parts, of at least 5 MiB); it is also the most of
 * an upload this process holds in memory at once.
 */
export const WARM_PART_BYTES = 32 * 1024 * 1024;
/** The header that names a multipart upload to the snapshot route. */
export const UPLOAD_ID_HEADER = 'x-buildd-upload-id';

/** The cap from the Worker's env, or the default for a value that is not a positive integer. */
export function warmMaxBundleBytes(env: Record<string, string | undefined>): number {
  const raw = env[WARM_MAX_BUNDLE_ENV]?.trim() ?? '';
  const n = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : WARM_DEFAULT_MAX_BUNDLE_BYTES;
}

/**
 * The cap for this run: what the Worker answers on `GET /warm/limits` (the
 * workspace's gitConfig.warmSnapshot.maxBytes, bounded by buildd, else the
 * Worker's own default), or `fallback` when it gives no usable number.
 */
export function resolveWarmCap(res: { status: number; body: unknown }, fallback: number): number {
  const n = (res.body as { maxBytes?: unknown } | null)?.maxBytes;
  return res.status === 200 && typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

let zstdProbe: boolean | undefined;
/** Whether `zstd` runs in this image (apps/runner/Dockerfile.once installs it). */
export function zstdAvailable(): boolean {
  if (zstdProbe === undefined) {
    const r = spawnSync('zstd', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    zstdProbe = r.status === 0;
  }
  return zstdProbe;
}

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSFER_TIMEOUT_S = 30 * 60;
const CONTROL_TIMEOUT_S = 30;
const PART_TIMEOUT_S = 5 * 60;

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

/**
 * pnpm's content-addressable store lives here, nested inside whatever
 * directory the cache tarball above already tars/restores (`cacheDir`), so no
 * second artifact, metric or Worker object key is needed: it rides along as
 * more files under the existing `cache` part and shows up in the same
 * `cache_bytes` metric (repo.bytes.cache in the run report).
 */
export const PNPM_STORE_DIRNAME = 'pnpm-store';

export function pnpmStoreDir(cacheDir: string): string {
  return join(cacheDir, PNPM_STORE_DIRNAME);
}

/**
 * The `npm_config_store_dir` to default pnpm onto (pnpm, like npm, reads any
 * config key from `npm_config_<key>`): inside the bun cache dir, unless the
 * operator already set one. Pure — callers (run-once.ts) apply it to the
 * process env that both the provision gate's `pnpm install` and the agent's
 * own subprocess (agent-env.ts's passthrough) inherit from.
 */
export function defaultPnpmStoreDirEnv(env: Record<string, string | undefined>): string {
  return env.npm_config_store_dir || pnpmStoreDir(bunCacheDir(env));
}

/** Bytes of every regular file under `dir`, recursively. 0 for a missing dir; never throws. */
export function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() || e.isSymbolicLink()) {
        try { total += statSync(abs).size; } catch { /* removed mid-walk */ }
      }
    }
  };
  walk(dir);
  return total;
}

// ── Transport ─────────────────────────────────────────────────────────────────

/** `status: 0` means the store could not be reached at all. */
export interface SnapshotTransport {
  getJson(path: string): { status: number; body: unknown };
  download(path: string, file: string): { status: number; bytes: number };
  upload(path: string, file: string): { status: number; body: unknown };
  /** PUT bytes held in memory (one multipart part), with a known length. */
  putBytes(path: string, data: Uint8Array, headers?: Record<string, string>): { status: number; body: unknown };
  post(path: string, body?: unknown, headers?: Record<string, string>): { status: number; body: unknown };
  /** DELETE (park bundles, an aborted multipart upload). */
  remove?(path: string, headers?: Record<string, string>): { status: number };
  /**
   * GET `path` straight into `command`'s stdin: nothing lands on disk but
   * what the command writes. `ok`: the command exited 0. `detail`: its
   * stderr, for the log.
   */
  pipeTo(path: string, command: string, args: string[]): { status: number; bytes: number; ok: boolean; detail: string };
}

function headerArgs(headers?: Record<string, string>): string[] {
  return Object.entries(headers ?? {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
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
  const curl = (args: string[], input?: string | Uint8Array) => {
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
    putBytes(path, data, headers) {
      // `--data-binary @-` reads stdin to the end first, so the request
      // carries a Content-Length (the Worker needs one to stream it to R2).
      const { status, text } = splitStatus(curl([
        '--max-time', String(PART_TIMEOUT_S), '-X', 'PUT', '--data-binary', '@-',
        '-H', 'content-type: application/octet-stream', '-H', 'Expect:', ...headerArgs(headers),
        '-w', '\n%{http_code}', `${base}${path}`,
      ], data));
      return { status, body: parseJson(text) };
    },
    pipeTo(path, command, args) {
      // POSIX sh: a pipeline's status is its last command's. curl's own
      // status line goes to stderr (`%{stderr}`), so stdout is the body only.
      const script = 'curl -s --max-time "$1" -o - -w "%{stderr}\\nBUILDD_HTTP %{http_code} %{size_download}\\n" "$2" | { shift 2; exec "$@"; }';
      const r = spawnSync('sh', ['-c', script, 'sh', String(TRANSFER_TIMEOUT_S), `${base}${path}`, command, ...args], {
        encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: TRANSFER_TIMEOUT_S * 1000,
      });
      const err = r.stderr ?? '';
      const m = /BUILDD_HTTP (\d+) (\d+)/.exec(err);
      const status = m ? Number(m[1]) : 0;
      const detail = err.replace(/\n?BUILDD_HTTP \d+ \d+\n?/, '\n').trim().slice(-2000);
      return { status, bytes: status === 200 && m ? Number(m[2]) : 0, ok: r.status === 0, detail };
    },
    remove(path, headers) {
      const { status } = splitStatus(curl(['--max-time', String(CONTROL_TIMEOUT_S), '-X', 'DELETE', ...headerArgs(headers), '-w', '\n%{http_code}', `${base}${path}`]));
      return { status };
    },
    post(path, body, headers) {
      const { status, text } = splitStatus(curl([
        '--max-time', String(CONTROL_TIMEOUT_S), '-X', 'POST', '-H', 'content-type: application/json', ...headerArgs(headers),
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
/**
 * The cache's file list for `tar -T`, written to `listPath`; null when there
 * is nothing to tar. `skipTopLevelNames` drops whole top-level entries (by
 * name, e.g. the pnpm store) before walking into them — used to leave a
 * single oversized artifact out of the tarball while keeping the rest of the
 * cache.
 */
export function writeCacheFileList(cacheDir: string, listPath: string, skipTopLevelNames?: ReadonlySet<string>): string | null {
  if (!existsSync(cacheDir)) return null;
  const files: string[] = [];
  const walk = (dir: string, top: boolean) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (CACHE_EXCLUDED_NAMES.test(e.name) || e.name.includes('\n')) continue;
      if (top && skipTopLevelNames?.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, false);
      else if (e.isFile() || e.isSymbolicLink()) files.push(relative(cacheDir, abs));
    }
  };
  walk(cacheDir, true);
  if (files.length === 0) return null;
  mkdirSync(dirname(listPath), { recursive: true });
  writeFileSync(listPath, `${files.join('\n')}\n`);
  return listPath;
}

export function createCacheTarball(cacheDir: string, outFile: string): boolean {
  const list = writeCacheFileList(cacheDir, `${outFile}.list`);
  if (!list) return false;
  try {
    const r = spawnSync('tar', ['-cf', outFile, '-C', cacheDir, '-T', list], { stdio: ['ignore', 'ignore', 'pipe'], timeout: GIT_TIMEOUT_MS });
    return r.status === 0;
  } finally {
    rmSync(list, { force: true });
  }
}

// ── Refresh rules ─────────────────────────────────────────────────────────────

export type WarmResult =
  /**
   * `restoredCacheBytes`: the cache on disk right after the restore (not the
   * tarball, which is compressed). `restoredPnpmStore`: whether that restore
   * brought a pnpm store back; one that was left out for size is not counted
   * as growth when the run rebuilds it (refreshOrThrow).
   */
  | { source: 'warm'; ageMs: number; fetchBytes: number; restoredCacheBytes: number; restoredPnpmStore?: boolean }
  | { source: 'clone'; reason: RepoFallbackReason };

export type RunEnd = 'completed' | 'failed' | 'wait_timeout' | 'parked';

/**
 * - seed: the workspace had no usable snapshot (none, or a corrupt one).
 *   Uploaded whatever the outcome: the bundle holds origin's refs only, so it
 *   does not depend on how the task went, and a workspace whose first tasks
 *   fail still gets warm.
 * - refresh: a warm restore that is old, or whose fetch was large, or whose
 *   cache grew materially, after a task that completed.
 * - none: everything else, including a store that was unreachable or a disk
 *   too small, where an upload would fail the same way.
 */
export interface DecideWarmRefreshInput {
  result: WarmResult;
  end: RunEnd;
  currentCacheBytes?: number;
}

export type WarmRefreshDecision = { decision: 'seed' | 'refresh' | 'none'; reason?: WarmRefreshReason };

/** Threshold for cache growth trigger: 64 MiB or 25%, whichever is smaller. */
export const WARM_CACHE_GROWTH_BYTES = 64 * 1024 * 1024;
export const WARM_CACHE_GROWTH_PERCENT = 0.25;

export function decideWarmRefresh(input: DecideWarmRefreshInput): WarmRefreshDecision {
  const { result, end, currentCacheBytes } = input;
  if (result.source === 'clone') {
    return { decision: result.reason === 'no_snapshot' || result.reason === 'restore_failed' ? 'seed' : 'none' };
  }
  if (end !== 'completed') return { decision: 'none' };

  if (result.ageMs > WARM_MAX_AGE_MS) return { decision: 'refresh', reason: 'age' };
  if (result.fetchBytes > WARM_FETCH_REFRESH_BYTES) return { decision: 'refresh', reason: 'fetch' };

  if (currentCacheBytes !== undefined && currentCacheBytes > result.restoredCacheBytes) {
    const growthBytes = currentCacheBytes - result.restoredCacheBytes;
    const growthPercent = result.restoredCacheBytes > 0 ? growthBytes / result.restoredCacheBytes : 1;
    const threshold = Math.min(WARM_CACHE_GROWTH_BYTES, result.restoredCacheBytes * WARM_CACHE_GROWTH_PERCENT);
    if (growthBytes > threshold) return { decision: 'refresh', reason: 'cache_growth' };
  }

  return { decision: 'none' };
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
  /** The post-restore fetch's retry wait (git-clone.ts fetchOriginWithRetry); real sleep when absent. */
  sleep?(ms: number): void;
  /** Retry-After for origin after a 429; probed through the egress when absent. */
  retryAfter?(remoteUrl: string): number | null;
  /** Where phase / metric / source lines go (phase-lines.ts). */
  lineOpts?: { env?: Record<string, string | undefined>; log?: (line: string) => void };
  /** Largest bundle (and cache tarball) uploaded; WARM_DEFAULT_MAX_BUNDLE_BYTES when absent. */
  maxBundleBytes?: number;
  /** Multipart part size; WARM_PART_BYTES when absent. */
  partBytes?: number;
  /** The clone's size as the cap sees it before bundling; objectBytes when absent. */
  measureRepoBytes?(clonePath: string): number;
  /** Compress the cache tarball with zstd (and expect it on restore); probed when absent. */
  zstd?: boolean;
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

/**
 * git's own reason for a failure: its `fatal:` / `error:` lines (the last line
 * is often advice, and some commands print nothing with -q), else the last
 * line, else how the process ended. Never empty.
 */
export function gitFailureText(r: { status: number | null; stderr?: string | null; error?: Error; signal?: NodeJS.Signals | null }): string {
  const lines = (r.stderr ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const causes = lines.filter(l => /^(fatal|error):/i.test(l));
  if (causes.length) return causes.slice(0, 4).join('; ').slice(0, 500);
  if (lines.length) return lines.at(-1)!.slice(0, 500);
  if (r.error) return r.error.message;
  return r.signal ? `killed by ${r.signal}` : `exit ${r.status ?? 'unknown'}`;
}

function run(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${gitFailureText(r)}`);
}

// ── Shallow snapshots ─────────────────────────────────────────────────────────

/**
 * A cloud container's clone is shallow (git-clone.ts). A bundle of a shallow
 * clone holds the boundary commits but not their parents, and still claims a
 * complete history, so fetching it into an empty repo fails on the first
 * missing parent. The boundary travels in the bundle as one ref per boundary
 * commit under this prefix: read back from the header with `git bundle
 * list-heads` (no objects needed) and written to `.git/shallow` before the
 * fetch. The refs exist in the clone only while its bundle is built, and the
 * restore never fetches them. A full clone's bundle has none, as before.
 */
export const SHALLOW_REF_PREFIX = 'refs/buildd/shallow/';
const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

function shallowPath(clonePath: string): string {
  const p = gitOut(clonePath, ['rev-parse', '--git-path', 'shallow']) || join('.git', 'shallow');
  return p.startsWith('/') ? p : join(clonePath, p);
}

function gitStdin(cwd: string, args: string[], input: string): void {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${gitFailureText(r)}`);
}

/**
 * Write the clone's shallow boundary as SHALLOW_REF_PREFIX refs (none for a
 * full clone). Returns the extra `git bundle create` arguments that carry them
 * and a cleanup that deletes them again; call it in a `finally`.
 */
export function stageShallowBoundary(clonePath: string): { args: string[]; cleanup(): void } {
  const shallow = gitOut(clonePath, ['rev-parse', '--is-shallow-repository']) === 'true';
  const boundary = shallow && existsSync(shallowPath(clonePath))
    ? readFileSync(shallowPath(clonePath), 'utf-8').split('\n').map(l => l.trim()).filter(l => OID_RE.test(l))
    : [];
  if (boundary.length === 0) return { args: [], cleanup: () => {} };
  const refs = boundary.map(id => `${SHALLOW_REF_PREFIX}${id}`);
  const cleanup = () => {
    spawnSync('git', ['update-ref', '--stdin'], { cwd: clonePath, input: refs.map(r => `delete ${r}\n`).join(''), stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000 });
  };
  try {
    gitStdin(clonePath, ['update-ref', '--stdin'], boundary.map((id, i) => `create ${refs[i]} ${id}\n`).join(''));
  } catch (err) {
    cleanup();
    throw err;
  }
  return { args: [`--glob=${SHALLOW_REF_PREFIX}*`], cleanup };
}

/**
 * Config for the `git bundle` pack: one delta thread, bounded window memory.
 * git sizes its thread pool from the host's CPUs, which in a container can be
 * many more than the instance's share; each thread holds its own delta window.
 */
const BUNDLE_PACK_CONFIG = ['-c', 'pack.threads=1', '-c', 'pack.windowMemory=128m', '-c', 'pack.deltaCacheSize=64m'];

/** The `git` argv that writes the warm bundle (remote refs + shallow boundary) to stdout. */
export function bundleToStdoutArgs(boundaryArgs: string[]): string[] {
  return [...BUNDLE_PACK_CONFIG, 'bundle', 'create', '-q', '-', '--remotes', ...boundaryArgs];
}

/** `git bundle create --remotes` to a file, plus the shallow boundary when the clone is shallow. */
export function bundleRemotes(clonePath: string, bundle: string): void {
  const staged = stageShallowBoundary(clonePath);
  try {
    run(clonePath, [...BUNDLE_PACK_CONFIG, 'bundle', 'create', '-q', bundle, '--remotes', ...staged.args]);
  } finally {
    staged.cleanup();
  }
}

// ── Streamed multipart upload ─────────────────────────────────────────────────

export type StreamUploadResult =
  /** `bytes`: what was uploaded; `inputBytes`: what the producer wrote (the same without a filter). */
  | { ok: true; bytes: number; inputBytes: number }
  | { ok: false; reason: 'too_large' | 'failed'; detail: string };

/**
 * Run `command` and upload its stdout to `<path>` as a multipart upload
 * (snapshots.ts in apps/cloud-runner): `POST <path>/multipart` → uploadId,
 * `PUT <path>/multipart/<n>` per part, `POST <path>/multipart/complete`.
 * Every part but the last is exactly `partBytes`, and no more than one part
 * is held in memory: the producer waits on its pipe while a part uploads.
 * Past `maxBytes` the producer is killed and the upload aborted, as on any
 * failure. With `filter`, the producer's stdout is piped through it (e.g.
 * `zstd -c`) and the filter's output is what is uploaded and capped; either
 * process failing fails the upload. Never throws.
 */
export async function streamToMultipart(o: {
  command: string;
  args: string[];
  cwd?: string;
  transport: Pick<SnapshotTransport, 'post' | 'putBytes' | 'remove'>;
  path: string;
  partBytes: number;
  maxBytes: number;
  timeoutMs?: number;
  filter?: { command: string; args: string[] };
}): Promise<StreamUploadResult> {
  const created = o.transport.post(`${o.path}/multipart`, {});
  const uploadId = (created.body as { uploadId?: unknown } | null)?.uploadId;
  if (created.status !== 201 || typeof uploadId !== 'string' || !uploadId) {
    return { ok: false, reason: 'failed', detail: `multipart create answered ${created.status || 'nothing'}` };
  }
  const headers = { [UPLOAD_ID_HEADER]: uploadId };
  const abort = () => { try { o.transport.remove?.(`${o.path}/multipart`, headers); } catch { /* the bucket's lifecycle rule expires it */ } };

  type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
  const child = spawn(o.command, o.args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const filter = o.filter ? spawn(o.filter.command, o.filter.args, { stdio: ['pipe', 'pipe', 'pipe'] }) : null;
  let stderr = '';
  const onErr = (d: Buffer) => { stderr = (stderr + d.toString('utf-8')).slice(-8000); };
  child.stderr!.on('data', onErr);
  filter?.stderr!.on('data', onErr);
  const exitOf = (p: typeof child) => new Promise<Exit>((resolve) => {
    p.on('error', (error) => resolve({ code: null, signal: null, error }));
    p.on('close', (code, signal) => resolve({ code, signal }));
  });
  const exited = exitOf(child);
  const filterExited = filter ? exitOf(filter) : null;
  let inputBytes = 0;
  if (filter) {
    child.stdout!.on('data', (c: Buffer) => { inputBytes += c.length; });
    child.stdout!.pipe(filter.stdin!);
    // A filter that dies first closes its stdin; its own exit is the error.
    filter.stdin!.on('error', () => {});
  }
  const output = (filter ? filter.stdout! : child.stdout!) as AsyncIterable<Buffer>;
  const killAll = () => { child.kill('SIGKILL'); filter?.kill('SIGKILL'); };
  const timer = setTimeout(killAll, o.timeoutMs ?? TRANSFER_TIMEOUT_S * 1000);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let total = 0;
  const fail = (reason: 'too_large' | 'failed', detail: string): StreamUploadResult => {
    killAll();
    abort();
    return { ok: false, reason, detail };
  };
  const sendPart = (data: Buffer): string | null => {
    const n = parts.length + 1;
    const r = o.transport.putBytes(`${o.path}/multipart/${n}`, data, headers);
    const etag = (r.body as { etag?: unknown } | null)?.etag;
    if (r.status !== 201 || typeof etag !== 'string') return `part ${n} answered ${r.status || 'nothing'}`;
    parts.push({ partNumber: n, etag });
    return null;
  };
  try {
    for await (const chunk of output) {
      total += chunk.length;
      if (total > o.maxBytes) return fail('too_large', `over ${o.maxBytes} bytes`);
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= o.partBytes) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        const err = sendPart(all.subarray(0, o.partBytes));
        if (err) return fail('failed', err);
        const rest = all.subarray(o.partBytes);
        pending = rest.length > 0 ? [Buffer.from(rest)] : [];
        pendingBytes = rest.length;
      }
    }
    const ends: Array<[string, Exit]> = [[o.command, await exited]];
    if (filter && filterExited) ends.push([o.filter!.command, await filterExited]);
    for (const [name, end] of ends) {
      if (end.error || end.code !== 0) {
        const why = stderr.split('\n').map(l => l.trim()).filter(Boolean).slice(-4).join('; ') || end.error?.message || (end.signal ? `killed by ${end.signal}` : `exit ${end.code}`);
        return fail('failed', `${name} failed: ${why.slice(0, 500)}`);
      }
    }
    if (total === 0) return fail('failed', `${o.command} wrote nothing`);
    if (pendingBytes > 0) {
      const err = sendPart(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes));
      if (err) return fail('failed', err);
    }
    const done = o.transport.post(`${o.path}/multipart/complete`, { parts }, headers);
    if (done.status !== 201) return fail('failed', `multipart complete answered ${done.status || 'nothing'}`);
    return { ok: true, bytes: total, inputBytes: filter ? inputBytes : total };
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Before fetching a warm bundle: make the new repo shallow at the boundary the bundle names, if any. */
export function writeShallowBoundary(clonePath: string, bundle: string): void {
  const ids = gitOut(clonePath, ['bundle', 'list-heads', bundle])
    .split('\n')
    .map(l => l.trim().split(/\s+/))
    .filter(([id, ref]) => !!ref && ref.startsWith(SHALLOW_REF_PREFIX) && OID_RE.test(id ?? ''))
    .map(([id]) => id!);
  if (ids.length > 0) writeFileSync(shallowPath(clonePath), `${[...new Set(ids)].join('\n')}\n`);
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
      // No -q: with it, a bundle missing its prerequisites fails silently.
      run(clonePath, ['bundle', 'verify', bundle]);
      // A snapshot of a shallow clone (cloud, git-clone.ts) names its
      // boundary commits; without them in .git/shallow the fetch below fails
      // its connectivity check on the first missing parent.
      writeShallowBoundary(clonePath, bundle);
      run(clonePath, ['fetch', '-q', '--no-tags', bundle, '+refs/remotes/origin/*:refs/remotes/origin/*']);
      // `-t`: as narrow as the cloud clone (git-clone.ts). With the default
      // wildcard refspec, the fetch below would bring every branch on origin,
      // each down to its root in a shallow repo; other branches come in on
      // demand (ensureRemoteBranch).
      run(clonePath, ['remote', 'add', '-t', manifest.defaultBranch, 'origin', cloneUrl]);
      const head = `refs/remotes/origin/${manifest.defaultBranch}`;
      run(clonePath, ['rev-parse', '--verify', '-q', head]);
      run(clonePath, ['symbolic-ref', 'refs/remotes/origin/HEAD', head]);
      run(clonePath, ['checkout', '-q', '-B', manifest.defaultBranch, '--track', `origin/${manifest.defaultBranch}`]);
      run(clonePath, ['update-ref', WARM_BASE_REF, head]);
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
    const restoredCacheBytes = dirSizeBytes(this.d.cacheDir);
    const restoredPnpmStore = existsSync(pnpmStoreDir(this.d.cacheDir));

    emitPhase('fetch_start', this.d.lineOpts);
    const before = objectBytes(clonePath);
    let fetchBytes = 0;
    try {
      const fetchError = fetchOriginWithRetry(clonePath, { sleep: this.d.sleep, retryAfter: this.d.retryAfter, log: this.d.log });
      if (fetchError) throw new Error(`git fetch failed: ${fetchError}`);
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
    this.result = { source: 'warm', ageMs, fetchBytes, restoredCacheBytes, restoredPnpmStore };
    emitRepoSource('warm', undefined, this.d.lineOpts);
    this.d.log(`[warm] restored generation ${manifest.generation} (${ageMs} ms old, fetched ${fetchBytes} bytes)`);
    return true;
  }

  private useZstd(): boolean {
    return this.d.zstd ?? zstdAvailable();
  }

  /**
   * Streamed: the download goes straight into `zstd -d | tar -x` (or plain
   * `tar -x` without zstd), so restoring a multi-gigabyte cache never needs
   * a second copy of it on disk. `zstd -f` passes an uncompressed tarball
   * from an older snapshot through unchanged.
   */
  private restoreCache(manifest: WarmManifest): void {
    if (manifest.cacheBytes === 0) return;
    emitPhase('restore_cache_start', this.d.lineOpts);
    try {
      mkdirSync(this.d.cacheDir, { recursive: true });
      const [command, args] = this.useZstd()
        ? ['sh', ['-c', 'zstd -d -c -f -q | tar -xf - -C "$1" --no-same-owner', 'sh', this.d.cacheDir]] as const
        : ['tar', ['-xf', '-', '-C', this.d.cacheDir, '--no-same-owner']] as const;
      const r = this.d.transport.pipeTo(`/warm/${manifest.generation}/cache`, command, [...args]);
      if (r.status !== 200) throw new Error(`cache download answered ${r.status || 'nothing'}`);
      if (!r.ok) throw new Error(`cache extract failed${r.detail ? `: ${r.detail.slice(0, 300)}` : ''}`);
      this.metric('cache_bytes', r.bytes);
    } catch (err) {
      this.d.log(`[warm] bun cache not restored: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      emitPhase('restore_cache_end', this.d.lineOpts);
    }
  }

  /** Best effort; never throws. Call once, after the run's outcome is known. */
  async refresh(end: RunEnd): Promise<void> {
    try {
      await this.refreshOrThrow(end);
    } catch (err) {
      this.d.log(`[warm] snapshot upload skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private skipTooLarge(why: string): void {
    emitWarmUploadSkipped('too_large', this.d.lineOpts);
    this.d.log(`[warm] snapshot upload skipped: ${why}; this workspace clones instead`);
  }

  /**
   * Stream the cache tarball (zstd-compressed when available) to the cache
   * part; returns the bytes uploaded. The cap applies to what is uploaded,
   * i.e. the compressed size. The pnpm store (nested in cacheDir, see
   * pnpmStoreDir) can alone be bigger than the cap: it is left out before
   * tarring when the cache could not fit even compressed
   * (WARM_CACHE_COMPRESSION_HEADROOM), and the cache is sent again without
   * it when it compresses past the cap anyway, so the rest of the cache is
   * kept. Any part left out is reported (BUILDD_CACHE_SKIPPED) and logged.
   */
  private async uploadCache(generation: string, cap: number, cacheBytes: number, partBytes: number, maxBytes: number): Promise<number> {
    const compress = this.useZstd();
    const pnpmDir = pnpmStoreDir(this.d.cacheDir);
    const storeBytes = existsSync(pnpmDir) ? dirSizeBytes(pnpmDir) : 0;
    const fitsRaw = compress ? cap * WARM_CACHE_COMPRESSION_HEADROOM : cap;
    const skipStore = (why: string) => {
      emitCacheSkipped('pnpm-store', storeBytes, cap, this.d.lineOpts);
      this.d.log(`[warm] pnpm store (${storeBytes} bytes) left out of the cache upload: ${why}, over the ${cap}-byte warm snapshot cap`);
    };
    let withoutStore = storeBytes > 0 && cacheBytes > fitsRaw;
    if (withoutStore) skipStore(`the cache is ${cacheBytes} bytes on disk`);

    const attempt = async (skip: boolean): Promise<StreamUploadResult | null> => {
      const list = writeCacheFileList(this.d.cacheDir, join(this.d.tmpDir, `upload-${generation}.list`), skip ? new Set([PNPM_STORE_DIRNAME]) : undefined);
      if (!list) return null;
      try {
        return await streamToMultipart({
          command: 'tar', args: ['-cf', '-', '-C', this.d.cacheDir, '-T', list], transport: this.d.transport,
          path: `/warm/${generation}/cache`, partBytes, maxBytes,
          ...(compress ? { filter: { command: 'zstd', args: ['-q', '-c', '-T0'] } } : {}),
        });
      } finally {
        rmSync(list, { force: true });
      }
    };

    let cache = await attempt(withoutStore);
    if (cache && !cache.ok && cache.reason === 'too_large' && !withoutStore && storeBytes > 0) {
      withoutStore = true;
      skipStore(`the cache tarball grew past ${maxBytes} bytes${compress ? ' compressed' : ''} while streaming`);
      cache = await attempt(true);
    }
    if (!cache) return 0;
    if (!cache.ok) {
      if (cache.reason === 'too_large') {
        const rest = withoutStore ? Math.max(0, cacheBytes - storeBytes) : cacheBytes;
        emitCacheSkipped('cache', rest, cap, this.d.lineOpts);
        this.d.log(`[warm] bun cache (${rest} bytes) not uploaded: over the ${cap}-byte warm snapshot cap${compress ? ' compressed' : ''}`);
      } else {
        this.d.log(`[warm] bun cache not uploaded: ${cache.detail}`);
      }
      return 0;
    }
    this.metric('cache_raw_bytes', cache.inputBytes);
    if (compress) this.d.log(`[warm] cache tarball ${cache.inputBytes} bytes, ${cache.bytes} compressed`);
    return cache.bytes;
  }

  private async refreshOrThrow(end: RunEnd): Promise<void> {
    const clonePath = this.clonePath;
    if (!this.result || !clonePath || !existsSync(join(clonePath, '.git'))) return;
    const currentCacheBytes = dirSizeBytes(this.d.cacheDir);
    // A pnpm store the restore did not bring back was (most likely) left
    // out for size; the install rebuilt it. Counting it as growth would
    // re-upload, and leave it out again, after every run. A store that is
    // genuinely new is picked up by the age refresh.
    const grownBytes = this.result.source === 'warm' && this.result.restoredPnpmStore === false
      ? currentCacheBytes - dirSizeBytes(pnpmStoreDir(this.d.cacheDir))
      : currentCacheBytes;
    const { decision, reason } = decideWarmRefresh({ result: this.result, end, currentCacheBytes: grownBytes });
    if (decision === 'none') return;
    if (reason) emitWarmRefresh(reason, this.d.lineOpts);
    assertSnapshotSafe(clonePath);

    const defaultBranch = gitOut(clonePath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
      || gitOut(clonePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!BRANCH_RE.test(defaultBranch) || defaultBranch === 'HEAD') throw new Error('no default branch to record');

    // Measure before bundling: on a repo of gigabytes the bundle itself is
    // minutes of CPU and a large pack-objects working set on a small
    // instance. The clone's object store is what a `--remotes` bundle of it
    // holds (or a little more), so it stands in for the bundle's size.
    const cap = resolveWarmCap(this.d.transport.getJson('/warm/limits'), this.d.maxBundleBytes ?? WARM_DEFAULT_MAX_BUNDLE_BYTES);
    const measured = (this.d.measureRepoBytes ?? objectBytes)(clonePath);
    this.metric('warm_repo_bytes', measured);
    if (measured > cap) {
      this.skipTooLarge(`the repo is ${measured} bytes, over the ${cap}-byte warm snapshot cap`);
      return;
    }

    const begin = this.d.transport.post('/warm/begin');
    if (begin.status === 409) { this.d.log('[warm] another refresh of this workspace is in flight'); return; }
    const generation = (begin.body as { generation?: unknown } | null)?.generation;
    if (begin.status !== 201 || typeof generation !== 'string' || !GENERATION_RE.test(generation)) {
      throw new Error(`begin answered ${begin.status || 'nothing'}`);
    }

    const maxBytes = Math.min(cap, WARM_MAX_UPLOAD_BYTES);
    const partBytes = this.d.partBytes ?? WARM_PART_BYTES;
    mkdirSync(this.d.tmpDir, { recursive: true });
    emitPhase('warm_upload_start', this.d.lineOpts);
    let uploaded = 0;
    try {
      // Remote-tracking refs only: local task branches may hold unpushed work.
      // A shallow clone also names its boundary (SHALLOW_REF_PREFIX). Streamed
      // from `git bundle create -` into the upload: no second copy of the
      // object store on disk, and at most one part in memory.
      const staged = stageShallowBoundary(clonePath);
      let repo: StreamUploadResult;
      try {
        repo = await streamToMultipart({
          command: 'git', args: bundleToStdoutArgs(staged.args), cwd: clonePath,
          transport: this.d.transport, path: `/warm/${generation}/repo`, partBytes, maxBytes,
        });
      } finally {
        staged.cleanup();
      }
      if (!repo.ok) {
        if (repo.reason === 'too_large') { this.skipTooLarge(`the bundle grew past ${maxBytes} bytes while streaming`); return; }
        throw new Error(`bundle upload failed: ${repo.detail}`);
      }
      uploaded += repo.bytes;
      uploaded += await this.uploadCache(generation, cap, currentCacheBytes, partBytes, maxBytes);
      const commit = this.d.transport.post(`/warm/${generation}/commit`, { defaultBranch });
      if (commit.status !== 201) throw new Error(`commit answered ${commit.status || 'nothing'}`);
      this.d.log(`[warm] ${decision === 'seed' ? 'seeded' : 'refreshed'} generation ${generation} (${uploaded} bytes)`);
    } finally {
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
    maxBundleBytes: warmMaxBundleBytes(env),
    now: Date.now,
    log: (m) => console.log(m),
  });
  session.disabled = !warmRepoEnabled(env);
  return session;
}

