/**
 * Park bundles for resumable cloud runs (docs/design/cloudflare-sandbox-
 * runner.md, Phase 2 "Resumable runs"). When a --once worker waits for an
 * answer with no live session, the runner packs what a new container needs to
 * continue the SAME worker, uploads it through the snapshot pseudo-host, marks
 * the worker parked, and exits 4. `buildd-once --resume-worker <id>` puts it
 * back at the same absolute paths (the transcript is keyed by cwd, the worker
 * record stores worktreePath) and re-attaches.
 *
 * A bundle holds, and only holds:
 *  - the task branch as a `git bundle` (commits not on origin's default
 *    branch), plus uncommitted work as a commit under a private ref
 *    (`refs/buildd/park/<workerId>`). It is built with a temporary index, so
 *    untracked files are included and the working tree is never touched;
 *  - the Claude Code transcript for the worker's session (the session's jsonl
 *    and its subagent directory);
 *  - the worker record `<BUILDD_HOME>/workers/<id>.json` and the task's outbox.
 * Not node_modules, not the rest of BUILDD_HOME, nothing else under the Claude
 * config dir. The warm snapshot (warm-repo.ts) or a clone supplies the rest.
 *
 * Synchronous, like warm-repo.ts: git and tar via spawnSync.
 */
import { spawnSync } from 'child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { WARM_BASE_REF, gitFailureText } from './warm-repo';
import { branchOfRemoteRef, ensureRemoteBranch, gitRetryDelayMs, parseRetryAfter, probeRetryAfter, sleepSync } from './git-clone';

export const PARK_ENV_FLAG = 'BUILDD_ONCE_PARK';
/** At most this many parks per worker; the next wait holds the container as before. */
export const MAX_PARKS = 3;
const MANIFEST_VERSION = 1;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `<BUILDD_HOME>/parks/<workerId>.json`: how many times this worker has parked. Travels in the bundle. */
export function parkCountPath(builddHome: string, workerId: string): string {
  return join(builddHome, 'parks', `${workerId}.json`);
}

export function readParkCount(builddHome: string, workerId: string): number {
  try {
    const n = Number((JSON.parse(readFileSync(parkCountPath(builddHome, workerId), 'utf-8')) as { parks?: unknown }).parks);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function parkingEnabled(env: Record<string, string | undefined>): boolean {
  return env[PARK_ENV_FLAG] === '1' && !!env.BUILDD_SNAPSHOT_URL;
}

export class ParkRestoreError extends Error {}

export interface ParkPaths {
  builddHome: string;
  /** Where Claude Code keeps transcripts: CLAUDE_CONFIG_DIR and ~/.claude. */
  claudeConfigDirs: string[];
  tmpDir: string;
}

export type ParkKind = 'waiting' | 'orphan';

export interface ParkManifest {
  version: typeof MANIFEST_VERSION;
  /** waiting: parked on a question. orphan: parked by the agent after its own restart, mid-run. */
  kind: ParkKind;
  workerId: string;
  taskId: string;
  workspaceId: string;
  branch: string;
  defaultBranch: string;
  clonePath: string;
  worktreePath: string;
  headSha: string;
  wipSha: string | null;
  /** Refs carried in repo.bundle (empty: no bundle, the branch tip is on origin). */
  bundleRefs: string[];
  hasBundle: boolean;
  sessionId: string | null;
  /** Parks of this worker so far, this one included. */
  parks: number;
  parkedAt: number;
  /** Absolute paths restored to the same place. */
  files: string[];
  /**
   * The `origin/<branch>` refs the worker measures against (the base its
   * worktree was cut from, its PR base). A narrow (cloud) clone holds the
   * default branch only, so the resume fetches these by name. Absent in a
   * bundle from an older runner.
   */
  baseRefs?: string[];
}

export interface OpenedPark {
  manifest: ParkManifest;
  stageDir: string;
}

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (r.status !== 0) {
    throw new ParkRestoreError(`git ${args.slice(0, 2).join(' ')} failed: ${gitFailureText(r)}`);
  }
  return (r.stdout ?? '').trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The base clone of a linked worktree, or the session clone itself in cloud mode. */
export function clonePathOf(worktreePath: string): string {
  const parent = dirname(worktreePath);
  if (basename(parent) === '.buildd-worktrees') return dirname(parent);
  const common = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return dirname(common);
}

/** The session's transcript: `<config>/projects/<cwd key>/<sessionId>.jsonl` and `<sessionId>/**`. */
export function findTranscriptFiles(configDirs: string[], sessionId: string): string[] {
  if (!ID_RE.test(sessionId)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  for (const cfg of configDirs) {
    const projects = join(cfg, 'projects');
    if (!existsSync(projects)) continue;
    for (const p of readdirSync(projects, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const base = join(projects, p.name);
      if (existsSync(join(base, `${sessionId}.jsonl`))) out.push(join(base, `${sessionId}.jsonl`));
      if (existsSync(join(base, sessionId)) && statSync(join(base, sessionId)).isDirectory()) walk(join(base, sessionId));
    }
  }
  return out;
}

/**
 * Uncommitted work (tracked edits, deletions and untracked files, minus
 * ignored ones) as a commit on top of HEAD, built with a throwaway index so
 * neither the real index nor the working tree changes. Null when clean.
 */
export function captureWip(worktree: string, ref: string, tmpDir: string): string | null {
  mkdirSync(tmpDir, { recursive: true });
  const index = join(tmpDir, `park-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(worktree, ['read-tree', 'HEAD'], env);
    git(worktree, ['add', '-A'], env);
    const tree = git(worktree, ['write-tree'], env);
    if (tree === git(worktree, ['rev-parse', 'HEAD^{tree}'])) return null;
    const sha = git(worktree, ['commit-tree', tree, '-p', 'HEAD', '-m', 'buildd: parked work in progress'], {
      ...env,
      GIT_AUTHOR_NAME: 'buildd', GIT_AUTHOR_EMAIL: 'park@buildd.invalid',
      GIT_COMMITTER_NAME: 'buildd', GIT_COMMITTER_EMAIL: 'park@buildd.invalid',
    });
    git(worktree, ['update-ref', ref, sha]);
    return sha;
  } finally {
    rmSync(index, { force: true });
  }
}

/** The commits a shallow clone's history stops at (`.git/shallow`); none for a full clone. */
function shallowBoundary(clonePath: string): string[] {
  if (tryGit(clonePath, ['rev-parse', '--is-shallow-repository']) !== 'true') return [];
  const rel = tryGit(clonePath, ['rev-parse', '--git-path', 'shallow']);
  if (!rel) return [];
  const file = rel.startsWith('/') ? rel : join(clonePath, rel);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(l => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(l));
}

export function buildParkBundle(opts: {
  worker: { id: string; taskId: string; workspaceId: string; worktreePath: string; sessionId?: string | null; baseRefs?: Array<string | null | undefined> };
  paths: ParkPaths;
  kind: ParkKind;
  /** Parks before this one. */
  parks: number;
  now: number;
}): { tarPath: string; manifest: ParkManifest; bytes: number } {
  const { worker, paths } = opts;
  if (!ID_RE.test(worker.id) || !ID_RE.test(worker.taskId)) throw new Error('unexpected worker or task id');
  const wt = worker.worktreePath;
  if (!existsSync(join(wt, '.git'))) throw new Error('worktree is missing');
  const clonePath = clonePathOf(wt);
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('worktree is on a detached HEAD');
  const headSha = git(wt, ['rev-parse', 'HEAD']);
  const defaultBranch = (tryGit(clonePath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? 'origin/main').replace(/^origin\//, '');
  const wipRef = `refs/buildd/park/${worker.id}`;
  const wipSha = captureWip(wt, wipRef, paths.tmpDir);

  const stage = join(paths.tmpDir, `park-${worker.id}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'files'), { recursive: true });

  // Built against what the resuming clone is sure to have. After a warm
  // restore that is the snapshot's tip (WARM_BASE_REF), not the origin this
  // container fetched since: a task branched from (or merged) the newer
  // origin would otherwise need commits the snapshot lacks, and the resume
  // could only get them by fetching, which is exactly what may be failing
  // (rate limited, unreachable). Without a warm restore, origin's default
  // branch, as before. The branch only goes in when it has commits the base
  // lacks.
  const base = tryGit(clonePath, ['rev-parse', '--verify', '-q', `${WARM_BASE_REF}^{commit}`])
    ?? tryGit(clonePath, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${defaultBranch}`]);
  const ahead = base ? Number(tryGit(clonePath, ['rev-list', '--count', `${base}..${headSha}`]) ?? '1') : 1;
  const bundleRefs = [...(ahead > 0 ? [`refs/heads/${branch}`] : []), ...(wipSha ? [wipRef] : [])];
  // A shallow (cloud) clone's boundary commits are excluded too, so each one
  // the branch reaches becomes a prerequisite the resume fetches by id. In
  // the bundle they would arrive without their parents, which the resuming
  // clone does not have either: a task cut from a branch fetched on demand
  // (git-clone.ts ensureRemoteBranch) shares no commit with the depth-1
  // default branch the base is.
  const exclude = [...(base ? [base] : []), ...shallowBoundary(clonePath)];
  if (bundleRefs.length > 0) {
    git(clonePath, ['bundle', 'create', '-q', join(stage, 'repo.bundle'), ...bundleRefs, ...(exclude.length > 0 ? ['--not', ...exclude] : [])]);
  }

  // The park count goes with the worker, so every later park (including an
  // orphan park by a separate process) sees the same bound.
  mkdirSync(dirname(parkCountPath(paths.builddHome, worker.id)), { recursive: true });
  writeFileSync(parkCountPath(paths.builddHome, worker.id), JSON.stringify({ parks: opts.parks + 1 }));

  const files: string[] = [];
  const add = (abs: string) => {
    if (!existsSync(abs)) return;
    cpSync(abs, join(stage, 'files', abs.slice(1)), { recursive: false });
    files.push(abs);
  };
  add(join(paths.builddHome, 'workers', `${worker.id}.json`));
  add(join(paths.builddHome, `outbox-once-${worker.taskId}.json`));
  mkdirSync(join(stage, 'files', dirname(parkCountPath(paths.builddHome, worker.id)).slice(1)), { recursive: true });
  add(parkCountPath(paths.builddHome, worker.id));
  if (worker.sessionId) for (const f of findTranscriptFiles(paths.claudeConfigDirs, worker.sessionId)) {
    mkdirSync(dirname(join(stage, 'files', f.slice(1))), { recursive: true });
    add(f);
  }

  const manifest: ParkManifest = {
    version: MANIFEST_VERSION,
    kind: opts.kind,
    workerId: worker.id,
    taskId: worker.taskId,
    workspaceId: worker.workspaceId,
    branch,
    defaultBranch,
    clonePath,
    worktreePath: wt,
    headSha,
    wipSha,
    bundleRefs,
    hasBundle: bundleRefs.length > 0,
    sessionId: worker.sessionId ?? null,
    parks: opts.parks + 1,
    parkedAt: opts.now,
    files,
    baseRefs: [...new Set((worker.baseRefs ?? []).filter((r): r is string => !!branchOfRemoteRef(r)))],
  };
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const tarPath = join(paths.tmpDir, `park-${worker.id}.tar`);
  const r = spawnSync('tar', ['-cf', tarPath, '-C', stage, '.'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: GIT_TIMEOUT_MS });
  rmSync(stage, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('park tarball could not be written');
  return { tarPath, manifest, bytes: statSync(tarPath).size };
}

function parseManifest(text: string): ParkManifest {
  let m: ParkManifest;
  try { m = JSON.parse(text) as ParkManifest; } catch { throw new ParkRestoreError('park manifest is not JSON'); }
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (m?.version !== MANIFEST_VERSION || !ID_RE.test(m.workerId) || !ID_RE.test(m.taskId)
    || !str(m.branch) || !str(m.defaultBranch) || !str(m.clonePath) || !str(m.worktreePath) || !str(m.headSha)
    || !Array.isArray(m.files) || !Array.isArray(m.bundleRefs) || (m.kind !== 'waiting' && m.kind !== 'orphan')) {
    throw new ParkRestoreError('park manifest is malformed');
  }
  return m;
}

/** List (refusing absolute or `..` members), extract into `stageDir`, read the manifest. */
/** What parkWorkerNow needs from the runner: injected so tests need no network. */
export interface ParkNowDeps {
  paths: ParkPaths;
  /** The snapshot pseudo-host (warm-repo.ts curlTransport). */
  uploader: { upload(path: string, file: string): { status: number } };
  client: { parkWorker(workerId: string): Promise<{ parkedUntil: string } | null> };
  emitPhase(name: 'park_start' | 'park_end'): void;
  emitMetric(name: 'park_bytes', value: number): void;
  log(message: string): void;
}

/**
 * Park one worker: enforce MAX_PARKS, build the bundle, upload it to `/park`,
 * then mark the worker parked on the server (a `waiting` park; an `orphan`
 * park's agent marks it). False (never a throw) when any
 * step fails or the bound is reached; the caller then holds the container as
 * before. The bundle only counts once the server has accepted the park.
 */
export async function parkWorkerNow(
  worker: { id: string; taskId: string; workspaceId: string; worktreePath?: string; sessionId?: string | null; baseRefs?: Array<string | null | undefined> },
  kind: ParkKind,
  d: ParkNowDeps,
): Promise<boolean> {
  const parks = readParkCount(d.paths.builddHome, worker.id);
  if (parks >= MAX_PARKS) {
    d.log(`[once] worker ${worker.id} has parked ${parks} times already (max ${MAX_PARKS}); holding the container`);
    return false;
  }
  if (!worker.worktreePath) return false;
  d.emitPhase('park_start');
  let tarPath: string | null = null;
  try {
    const built = buildParkBundle({
      worker: { id: worker.id, taskId: worker.taskId, workspaceId: worker.workspaceId, worktreePath: worker.worktreePath, sessionId: worker.sessionId ?? null, baseRefs: worker.baseRefs },
      paths: d.paths, kind, parks, now: Date.now(),
    });
    tarPath = built.tarPath;
    const up = d.uploader.upload('/park', built.tarPath);
    if (up.status !== 201) { d.log(`[once] park upload answered ${up.status || 'nothing'}`); return false; }
    // An orphan park leaves the mark to the agent that exec'd it: this
    // container outlived its agent, and its route to buildd may not have
    // survived with it (under wrangler dev it does not).
    let until = 'the agent marks it';
    if (kind !== 'orphan') {
      const marked = await d.client.parkWorker(worker.id);
      if (!marked) { d.log('[once] the server did not accept the park'); return false; }
      until = `until ${marked.parkedUntil}`;
    }
    d.emitMetric('park_bytes', built.bytes);
    d.log(`[once] worker ${worker.id} parked, ${until} (${built.bytes} bytes, park ${built.manifest.parks} of ${MAX_PARKS})`);
    return true;
  } catch (err) {
    d.log(`[once] park failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (tarPath) rmSync(tarPath, { force: true });
    d.emitPhase('park_end');
  }
}

export function readParkBundle(tarPath: string, stageDir: string): OpenedPark {
  const list = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (list.status !== 0) throw new ParkRestoreError('park bundle is not a tarball');
  for (const raw of (list.stdout ?? '').split('\n').filter(Boolean)) {
    const name = raw.replace(/^\.\//, '');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new ParkRestoreError(`park bundle has an unsafe member: ${raw}`);
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const x = spawnSync('tar', ['-xf', tarPath, '-C', stageDir, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (x.status !== 0 || !existsSync(join(stageDir, 'manifest.json'))) throw new ParkRestoreError('park bundle could not be extracted');
  return { manifest: parseManifest(readFileSync(join(stageDir, 'manifest.json'), 'utf-8')), stageDir };
}

/** Whether `abs` is one of the files a park bundle may put back. */
function allowedRestorePath(abs: string, m: ParkManifest, paths: ParkPaths): boolean {
  if (resolve(abs) !== abs) return false;
  if (abs === join(paths.builddHome, 'workers', `${m.workerId}.json`)) return true;
  if (abs === join(paths.builddHome, `outbox-once-${m.taskId}.json`)) return true;
  if (abs === parkCountPath(paths.builddHome, m.workerId)) return true;
  if (!m.sessionId || !ID_RE.test(m.sessionId)) return false;
  return paths.claudeConfigDirs.some(cfg => {
    const projects = join(cfg, 'projects') + sep;
    if (!abs.startsWith(projects)) return false;
    const [, ...rest] = abs.slice(projects.length).split(sep);
    return (rest.length === 1 && rest[0] === `${m.sessionId}.jsonl`) || (rest.length >= 2 && rest[0] === m.sessionId);
  });
}

/** Put the transcript, worker record and outbox back. All paths are checked before any is written. */
export function restoreParkFiles(opened: OpenedPark, paths: ParkPaths): void {
  const m = opened.manifest;
  for (const f of m.files) {
    if (typeof f !== 'string' || !allowedRestorePath(f, m, paths)) throw new ParkRestoreError(`park bundle names a file it may not restore: ${f}`);
    if (!existsSync(join(opened.stageDir, 'files', f.slice(1)))) throw new ParkRestoreError(`park bundle is missing ${f}`);
  }
  for (const f of m.files) {
    mkdirSync(dirname(f), { recursive: true });
    cpSync(join(opened.stageDir, 'files', f.slice(1)), f);
  }
}

/** Total time a resume may wait for origin to answer before giving up on missing prerequisites. */
export const PARK_FETCH_RETRY_BUDGET_MS = 30_000;

export { parseRetryAfter, probeRetryAfter };

/**
 * How long to wait before fetching origin again, or null to stop: the policy
 * the clone shares (git-clone.ts gitRetryDelayMs). A 429 waits for
 * Retry-After; other transient failures back off exponentially; an answer that
 * will not change (a 403 that is not a rate limit, repository not found, bad
 * credentials) is not retried. Never past PARK_FETCH_RETRY_BUDGET_MS in total;
 * a Retry-After longer than what is left waits out the budget, then one try.
 */
export function fetchRetryDelayMs(o: { attempt: number; stderr: string; retryAfterS: number | null; waitedMs: number }): number | null {
  return gitRetryDelayMs({ ...o, budgetMs: PARK_FETCH_RETRY_BUDGET_MS, beyondBudget: 'remaining' });
}

export interface ApplyParkRepoOptions {
  sleep?(ms: number): void;
  /** Retry-After (seconds) for origin after a 429, or null. */
  retryAfter?(remoteUrl: string): number | null;
}

/** `git fetch origin`: git's reason on failure, null on success. */
function fetchOrigin(clonePath: string): string | null {
  const r = spawnSync('git', ['fetch', '-q', 'origin'], { cwd: clonePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? null : gitFailureText(r);
}

/**
 * The prerequisite commits named in a bundle's header (`-<oid> <subject>`
 * lines, before the blank line that ends it). Only the head of the file is
 * read: the header is text, the pack after it is not.
 */
export function bundlePrerequisites(bundle: string): string[] {
  let head = '';
  try {
    const fd = openSync(bundle, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('latin1');
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const end = head.indexOf('\n\n');
  const lines = (end >= 0 ? head.slice(0, end) : head).split('\n');
  if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) return [];
  return lines.map(l => /^-([0-9a-f]{40}|[0-9a-f]{64})(?: |$)/.exec(l)?.[1]).filter((id): id is string => !!id);
}

/**
 * Fetch the commits in `ids` this clone lacks, each by id at depth 1 (GitHub
 * serves any commit reachable from its refs by id). Other refs and their
 * history are untouched. git's reason on failure, null on success or when
 * nothing was missing.
 */
function fetchMissingCommits(clonePath: string, ids: string[]): string | null {
  const missing = ids.filter(id => tryGit(clonePath, ['cat-file', '-e', `${id}^{commit}`]) === null);
  if (missing.length === 0) return null;
  const r = spawnSync('git', ['fetch', '-q', '--no-tags', '--depth=1', 'origin', ...missing], { cwd: clonePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? null : gitFailureText(r);
}

/** `git bundle verify`, without -q (with it, missing prerequisites fail silently): the reason on failure. */
function verifyBundle(clonePath: string, bundle: string): string | null {
  const r = spawnSync('git', ['bundle', 'verify', bundle], { cwd: clonePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS });
  return r.status === 0 ? null : gitFailureText(r);
}

/**
 * Recreate the branch and the worktree at the same path in `clonePath` (a
 * warm restore or a clone of the same workspace), then lay the uncommitted
 * work back down, unstaged, as it was.
 *
 * Origin is fetched first, best effort. The bundle normally carries what it
 * needs on top of the snapshot (buildParkBundle), so a failed fetch changes
 * nothing; when it does lack prerequisites and the fetch failed, the fetch is
 * retried (fetchRetryDelayMs) before giving up.
 */
export function applyParkRepo(opened: OpenedPark, clonePath: string, opts: ApplyParkRepoOptions = {}): void {
  const m = opened.manifest;
  const sleep = opts.sleep ?? sleepSync;
  const retryAfter = opts.retryAfter ?? probeRetryAfter;
  if (resolve(clonePath) !== m.clonePath) throw new ParkRestoreError('the clone is not where the parked worktree lived');
  if (!existsSync(join(clonePath, '.git'))) throw new ParkRestoreError('no clone to restore into');
  let fetchError = fetchOrigin(clonePath);
  const fetchNote = () => (fetchError ? ` (fetching origin failed: ${fetchError})` : '');
  if (m.hasBundle) {
    const bundle = join(opened.stageDir, 'repo.bundle');
    // A shallow clone (a cloud container, git-clone.ts) may not reach the
    // commit the bundle was built on: a plain fetch never deepens it. Fetch
    // just those commits, by id.
    const shallow = tryGit(clonePath, ['rev-parse', '--is-shallow-repository']) === 'true';
    const fetchBase = () => (shallow ? fetchMissingCommits(clonePath, bundlePrerequisites(bundle)) : null);
    if (!fetchError) fetchError = fetchBase();
    let invalid = verifyBundle(clonePath, bundle);
    let waited = 0;
    for (let attempt = 0; invalid && fetchError && /prerequisite/i.test(invalid); attempt++) {
      const remote = /\b429\b/.test(fetchError) ? tryGit(clonePath, ['remote', 'get-url', 'origin']) : null;
      const delay = fetchRetryDelayMs({ attempt, stderr: fetchError, retryAfterS: remote ? retryAfter(remote) : null, waitedMs: waited });
      if (delay === null) break;
      sleep(delay);
      waited += delay;
      fetchError = fetchOrigin(clonePath) ?? fetchBase();
      invalid = verifyBundle(clonePath, bundle);
    }
    if (invalid) throw new ParkRestoreError(`park bundle does not apply: ${invalid}${fetchNote()}`);
    git(clonePath, ['fetch', '-q', '--no-tags', bundle, ...m.bundleRefs.map(r => `+${r}:${r}`)]);
  }
  if (!m.bundleRefs.includes(`refs/heads/${m.branch}`)) {
    if (tryGit(clonePath, ['cat-file', '-e', `${m.headSha}^{commit}`]) === null) {
      throw new ParkRestoreError(`the parked branch tip is not in this clone${fetchNote()}`);
    }
    git(clonePath, ['branch', '-f', m.branch, m.headSha]);
  }
  if (git(clonePath, ['rev-parse', `refs/heads/${m.branch}`]) !== m.headSha) throw new ParkRestoreError('restored branch tip does not match');

  // The manifest records the session shape: cloud sessions own their clone,
  // while host sessions still restore a separate linked worktree.
  if (resolve(m.worktreePath) === resolve(clonePath)) {
    git(clonePath, ['checkout', '-q', m.branch]);
  } else {
    const exclude = join(clonePath, '.git', 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    const ex = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
    if (!ex.includes('.buildd-worktrees')) writeFileSync(exclude, `${ex}\n.buildd-worktrees\n`);
    mkdirSync(dirname(m.worktreePath), { recursive: true });
    if (existsSync(m.worktreePath)) throw new ParkRestoreError('the worktree path is already taken');
    git(clonePath, ['worktree', 'add', '-q', m.worktreePath, m.branch]);
  }
  if (m.wipSha) {
    git(m.worktreePath, ['read-tree', '-m', '-u', 'HEAD', m.wipSha]);
    git(m.worktreePath, ['reset', '-q']);
  }
  // The bases the worker measures against (its PR stats, the path-claim
  // sweep). A narrow (cloud) clone has the default branch only; a full clone
  // already has them. Best effort: the worker runs without them, as it would
  // after a failed fetch.
  for (const ref of Array.isArray(m.baseRefs) ? m.baseRefs : []) {
    const branch = typeof ref === 'string' ? branchOfRemoteRef(ref) : null;
    if (branch) ensureRemoteBranch(clonePath, branch, { sleep, retryAfter });
  }
}
