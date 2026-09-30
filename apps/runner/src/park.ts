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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';

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
    throw new ParkRestoreError(`git ${args[0]} failed: ${(r.stderr ?? '').trim().split('\n').at(-1) ?? r.status}`);
  }
  return (r.stdout ?? '').trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The base clone a setupWorktree worktree belongs to: `<clone>/.buildd-worktrees/<name>`. */
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

export function buildParkBundle(opts: {
  worker: { id: string; taskId: string; workspaceId: string; worktreePath: string; sessionId?: string | null };
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

  // The branch only when it has commits origin's default branch lacks; the
  // restored clone already has everything reachable from origin.
  const base = tryGit(clonePath, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${defaultBranch}`]);
  const ahead = base ? Number(tryGit(clonePath, ['rev-list', '--count', `${base}..${headSha}`]) ?? '1') : 1;
  const bundleRefs = [...(ahead > 0 ? [`refs/heads/${branch}`] : []), ...(wipSha ? [wipRef] : [])];
  if (bundleRefs.length > 0) {
    git(clonePath, ['bundle', 'create', '-q', join(stage, 'repo.bundle'), ...bundleRefs, ...(base ? ['--not', base] : [])]);
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

/**
 * Recreate the branch and the worktree at the same path in `clonePath` (a
 * warm restore or a clone of the same workspace), then lay the uncommitted
 * work back down, unstaged, as it was.
 */
export function applyParkRepo(opened: OpenedPark, clonePath: string): void {
  const m = opened.manifest;
  if (resolve(clonePath) !== m.clonePath) throw new ParkRestoreError('the clone is not where the parked worktree lived');
  if (!existsSync(join(clonePath, '.git'))) throw new ParkRestoreError('no clone to restore into');
  tryGit(clonePath, ['fetch', '-q', 'origin']);
  if (m.hasBundle) {
    const bundle = join(opened.stageDir, 'repo.bundle');
    git(clonePath, ['bundle', 'verify', '-q', bundle]);
    git(clonePath, ['fetch', '-q', '--no-tags', bundle, ...m.bundleRefs.map(r => `+${r}:${r}`)]);
  }
  if (!m.bundleRefs.includes(`refs/heads/${m.branch}`)) git(clonePath, ['branch', '-f', m.branch, m.headSha]);
  if (git(clonePath, ['rev-parse', `refs/heads/${m.branch}`]) !== m.headSha) throw new ParkRestoreError('restored branch tip does not match');

  const exclude = join(clonePath, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
  if (!ex.includes('.buildd-worktrees')) writeFileSync(exclude, `${ex}\n.buildd-worktrees\n`);
  mkdirSync(dirname(m.worktreePath), { recursive: true });
  if (existsSync(m.worktreePath)) throw new ParkRestoreError('the worktree path is already taken');
  git(clonePath, ['worktree', 'add', '-q', m.worktreePath, m.branch]);
  if (m.wipSha) {
    git(m.worktreePath, ['read-tree', '-m', '-u', 'HEAD', m.wipSha]);
    git(m.worktreePath, ['reset', '-q']);
  }
}
