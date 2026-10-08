/**
 * Container reuse (apps/cloud-runner container-lease.ts): the reset between
 * two tasks that share one warm cloud container, and the seed the next task's
 * clone grows from.
 *
 * The next task is often a check on the previous one (a reviewer after a
 * builder), so nothing the previous task wrote may reach it except two
 * content-addressed stores:
 *
 *   - git pack files. Only `objects/pack/pack-*.pack`: no loose objects, no
 *     .idx/.rev/.bitmap/multi-pack-index/commit-graph, no alternates, no refs,
 *     no config, no hooks. The seed re-indexes every pack with
 *     `git index-pack`, which re-hashes every object (an .idx the previous
 *     task wrote could map an object id to other content; one computed here
 *     cannot), then fetches the real refs from origin and runs
 *     `git fsck --connectivity-only`. That is the same work a warm restore
 *     does on its bundle, without the download.
 *   - the bun install cache (with the pnpm store nested in it), scrubbed of
 *     every registry-config / env file name and of symlinks that leave it. This
 *     is the same trust the warm snapshot already gives that cache: its
 *     tarball is uploaded from a previous task's container too (warm-repo.ts).
 *
 * Everything else goes: every process but the container's own init and main
 * process, all of HOME (agent settings, git config and global hooks, shell
 * rc files and history, the buildd home with its worktrees, worker records
 * and outbox), and the shared scratch dirs (/tmp, /var/tmp, /dev/shm). The
 * reset never runs git against the previous task's clone: a planted
 * `core.fsmonitor` or hook would run. Ref hints are read as plain files and
 * only accepted as hex object names.
 *
 * The reset either verifies the result clean or fails; the cloud agent then
 * destroys the container and starts a fresh one. It never runs dirty.
 *
 * Runs as `buildd-once --reset-container` (container-reset-cli.ts), exec'd by
 * the agent with the NEXT task's env, after the previous run exited.
 */
import { spawnSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { pidsToStop, type ProcInfo } from './run-once';
import { resolveBuilddHome } from './buildd-home';
import { emitMetric, emitPhase, emitRepoSource } from './phase-lines';

/** Printed on success, last line: the agent reads it next to exit code 0. */
export const RESET_OK_LINE = 'BUILDD_RESET=ok';
export const RESET_FAILED_LINE_PREFIX = 'BUILDD_RESET=failed ';
/** The keep dir's name inside HOME. The only entry of HOME a reset leaves. */
export const KEEP_DIRNAME = '.buildd-reuse-keep';

/** Same names the warm cache tarball leaves out (warm-repo.ts CACHE_EXCLUDED_NAMES). */
const CACHE_SCRUBBED_NAMES = /^(\.npmrc|\.yarnrc(\.yml)?|\.netrc|bunfig\.toml|\.env(\..*)?)$/;
const HEX_OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PACK_RE = /^pack-[0-9a-f]{40,64}\.pack$/;

export interface ResetPaths {
  /** The container user's HOME. Wiped, except KEEP_DIRNAME. */
  home: string;
  /** Where --once clones each workspace (BUILDD_HOME/once-workspaces). */
  isolationRoot: string;
  /** The bun install cache (warm-repo.ts bunCacheDir). Kept, scrubbed. */
  cacheDir: string;
  /** Recreated empty after the wipe (BUILDD_HOME, the image WORKDIR). */
  skeletonDirs: string[];
  /** Shared scratch dirs whose entries are wiped (not the dirs themselves). */
  scratchDirs: string[];
}

export interface ResetDeps {
  /** Every process the reset may see. In a container: /proc. */
  listProcs(): ProcInfo[];
  kill(pid: number): void;
  selfPid: number;
  uid: number;
  sleep(ms: number): void;
  log(message: string): void;
}

export interface ResetResult {
  ok: boolean;
  /** Why not, for the log and the agent. */
  error?: string;
  killed: number;
  keptPacks: number;
  keptCache: boolean;
}

export function keepDirOf(home: string): string {
  return join(home, KEEP_DIRNAME);
}

/**
 * This run starts in a container a reset handed over (cloud only): the keep
 * dir exists only after a reset, which recreates it, and a fresh container
 * never has one. Its dependency cache is already on disk.
 */
export function isReusedContainer(env: Record<string, string | undefined>): boolean {
  return env.BUILDD_EXECUTOR === 'cloud' && !!env.HOME && existsSync(keepDirOf(env.HOME));
}

/** The paths of this container, from the env the agent exec'd the reset with. */
export function containerResetPaths(env: Record<string, string | undefined>, cacheDir: string): ResetPaths {
  const home = env.HOME || '/home/bun';
  const builddHome = resolveBuilddHome({ env, home });
  return {
    home,
    isolationRoot: env.BUILDD_WORKSPACE_ISOLATION_ROOT || join(builddHome, 'once-workspaces'),
    cacheDir,
    skeletonDirs: [builddHome, join(home, 'work')],
    scratchDirs: ['/tmp', '/var/tmp', '/dev/shm'],
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readSmall(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** The tip of origin's default branch, read as plain files (never git: the clone's config is the previous task's). */
export function readTipHint(gitDir: string): { branch: string; oid: string } | null {
  const head = readSmall(join(gitDir, 'refs', 'remotes', 'origin', 'HEAD'))?.trim();
  const m = head ? /^ref: refs\/remotes\/origin\/(.+)$/.exec(head) : null;
  const branch = m?.[1];
  if (!branch || !BRANCH_RE.test(branch) || branch.includes('..')) return null;
  const loose = readSmall(join(gitDir, 'refs', 'remotes', 'origin', branch))?.trim();
  if (loose && HEX_OID_RE.test(loose)) return { branch, oid: loose };
  const packed = readSmall(join(gitDir, 'packed-refs')) ?? '';
  for (const line of packed.split('\n')) {
    const [oid, ref] = line.trim().split(' ');
    if (ref === `refs/remotes/origin/${branch}` && oid && HEX_OID_RE.test(oid)) return { branch, oid };
  }
  return null;
}

/** Move one clone's pack files (and shallow boundary, and tip hint) into `dest`. Returns how many packs. */
function keepClone(clonePath: string, dest: string): number {
  const gitDir = join(clonePath, '.git');
  const packDir = join(gitDir, 'objects', 'pack');
  let packs = 0;
  let entries: string[] = [];
  try { entries = readdirSync(packDir); } catch { return 0; }
  mkdirSync(join(dest, 'pack'), { recursive: true });
  for (const name of entries) {
    if (!PACK_RE.test(name)) continue;
    const src = join(packDir, name);
    try {
      if (!lstatSync(src).isFile()) continue;
      renameSync(src, join(dest, 'pack', name));
      packs++;
    } catch { /* not kept */ }
  }
  const shallow = (readSmall(join(gitDir, 'shallow')) ?? '').split('\n').map(l => l.trim()).filter(l => HEX_OID_RE.test(l));
  if (shallow.length) writeFileSync(join(dest, 'shallow'), `${shallow.join('\n')}\n`);
  const tip = readTipHint(gitDir);
  if (tip) writeFileSync(join(dest, 'tip'), `${tip.branch} ${tip.oid}\n`);
  return packs;
}

/** Drop config-bearing names and symlinks that leave the cache, at any depth. */
function scrubCache(dir: string, root: string): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (CACHE_SCRUBBED_NAMES.test(e.name)) { rmSync(abs, { recursive: true, force: true }); continue; }
    if (e.isSymbolicLink()) {
      let target = '';
      try { target = readlinkSync(abs); } catch { /* unreadable */ }
      if (!target || isAbsolute(target) || !isInside(resolve(dirname(abs), target), root)) rmSync(abs, { force: true });
      continue;
    }
    if (e.isDirectory()) scrubCache(abs, root);
    else if (!e.isFile()) rmSync(abs, { force: true });
  }
}

/** SIGKILL everything pidsToStop picks until nothing is left (a fork between list and kill gets the next round). */
function killAll(d: ResetDeps): { killed: number; left: number[] } {
  let killed = 0;
  for (let round = 0; round < 20; round++) {
    const pids = pidsToStop(d.listProcs(), d.selfPid, d.uid);
    if (pids.length === 0) return { killed, left: [] };
    for (const pid of pids) {
      try { d.kill(pid); killed++; } catch { /* gone already */ }
    }
    d.sleep(100);
  }
  return { killed, left: pidsToStop(d.listProcs(), d.selfPid, d.uid) };
}

function wipeEntries(dir: string, keep: (abs: string) => boolean, uid?: number): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const abs = join(dir, name);
    if (keep(abs)) continue;
    try {
      if (uid !== undefined && lstatSync(abs).uid !== uid) continue;
      rmSync(abs, { recursive: true, force: true });
    } catch { /* checked by verify */ }
  }
}

/** Everything under `dir` that is not inside an allowed path (or a parent of one). */
function strays(dir: string, allowed: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const abs = join(d, name);
      if (allowed.some(a => isInside(abs, a))) continue;
      if (allowed.some(a => isInside(a, abs))) {
        let st;
        try { st = lstatSync(abs); } catch { continue; }
        if (st.isDirectory()) { walk(abs); continue; }
      }
      out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/**
 * Reset the container for the next task. Order: kill (so nothing writes
 * while the rest runs), keep the stores, wipe, put the cache back, verify.
 */
export function resetContainer(paths: ResetPaths, d: ResetDeps): ResetResult {
  const result: ResetResult = { ok: false, killed: 0, keptPacks: 0, keptCache: false };
  const fail = (error: string): ResetResult => ({ ...result, ok: false, error });
  try {
    const first = killAll(d);
    result.killed = first.killed;
    if (first.left.length) return fail(`processes still running after kill: ${first.left.join(',')}`);

    const keep = keepDirOf(paths.home);
    // A keep dir from an earlier reset that was never consumed is not trusted further.
    rmSync(keep, { recursive: true, force: true });
    mkdirSync(join(keep, 'git'), { recursive: true });

    for (const name of (() => { try { return readdirSync(paths.isolationRoot); } catch { return []; } })()) {
      const clone = join(paths.isolationRoot, name);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      try { if (!lstatSync(join(clone, '.git')).isDirectory()) continue; } catch { continue; }
      result.keptPacks += keepClone(clone, join(keep, 'git', name));
    }

    const keptCache = join(keep, 'cache');
    if (isInside(paths.cacheDir, paths.home) && existsSync(paths.cacheDir) && lstatSync(paths.cacheDir).isDirectory()) {
      renameSync(paths.cacheDir, keptCache);
      scrubCache(keptCache, keptCache);
      result.keptCache = true;
    }

    wipeEntries(paths.home, abs => abs === keep);
    for (const dir of paths.scratchDirs) wipeEntries(dir, () => false, d.uid);

    if (result.keptCache) {
      mkdirSync(dirname(paths.cacheDir), { recursive: true });
      renameSync(keptCache, paths.cacheDir);
    }
    for (const dir of paths.skeletonDirs) mkdirSync(dir, { recursive: true });

    // Verify, rather than trust each step above.
    const allowed = [keep, ...(result.keptCache ? [paths.cacheDir] : []), ...paths.skeletonDirs];
    const left = strays(paths.home, allowed);
    for (const dir of paths.skeletonDirs) {
      try { if (readdirSync(dir).length) left.push(`${dir}/*`); } catch { left.push(dir); }
    }
    for (const dir of paths.scratchDirs) {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        try { if (lstatSync(join(dir, name)).uid === d.uid) left.push(join(dir, name)); } catch { /* gone */ }
      }
    }
    if (left.length) return fail(`left behind: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ` (+${left.length - 5})` : ''}`);
    const again = pidsToStop(d.listProcs(), d.selfPid, d.uid);
    if (again.length) return fail(`processes reappeared: ${again.join(',')}`);
    return { ...result, ok: true };
  } catch (err) {
    return fail(describe(err));
  }
}

// ── Seed (the next task's clone) ──────────────────────────────────────────────

export interface SeedOptions {
  defaultBranch?: string | null;
  /** `git fetch origin` in the seeded clone; null on success, else git's reason. */
  fetchOrigin(clonePath: string): string | null;
  log(message: string): void;
  /** Where phase / source lines go (phase-lines.ts); the process env and stdout when absent. */
  lineOpts?: Parameters<typeof emitPhase>[1];
}

function git(cwd: string, args: string[], o: { timeoutMs?: number; input?: string } = {}): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf-8', stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: o.timeoutMs ?? 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    ...(o.input === undefined ? {} : { input: o.input }),
  });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim().slice(-300) };
}

/** Where the seed's temporary negotiation refs live; none is left after the seed. */
const HAVE_REF_PREFIX = 'refs/buildd/reuse-have/';
/** At most this many kept commits are offered to origin as haves. */
const MAX_HAVES = 32;

/** Bytes git keeps for objects (loose + packed), as warm-repo.ts objectBytes counts them. */
function objectBytesOf(repo: string): number {
  let kib = 0;
  for (const line of git(repo, ['count-objects', '-v']).out.split('\n')) {
    const m = /^(size|size-pack): (\d+)$/.exec(line.trim());
    if (m) kib += Number(m[2]);
  }
  return kib * 1024;
}

/**
 * The kept commits worth offering origin as haves: those no other kept
 * commit names as a parent (the tips the previous clone had, whatever its
 * refs said), the hinted tip first, each one complete. A commit whose
 * history or trees lean on objects the reset did not keep (they were loose)
 * is never offered: origin would then leave out objects the seed does not
 * have. Checked cumulatively, so the shared history is walked once.
 */
function completeHeads(clonePath: string, hint: string | null): string[] {
  const listed = git(clonePath, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname)']);
  const commits = listed.out.split('\n').filter(l => l.startsWith('commit ')).map(l => l.slice('commit '.length));
  if (!listed.ok || commits.length === 0) return [];
  // Newest first; a shallow commit's missing parents are not named.
  const walked = git(clonePath, ['rev-list', '--no-walk', '--parents', '--stdin'], { input: `${commits.join('\n')}\n` });
  if (!walked.ok) return [];
  const rows = walked.out.split('\n').map(l => l.split(' ')).filter(r => r[0]);
  const parents = new Set(rows.flatMap(r => r.slice(1)));
  const heads = rows.map(r => r[0]!).filter(c => !parents.has(c));
  const ordered = hint && heads.includes(hint) ? [hint, ...heads.filter(h => h !== hint)] : heads;
  const ok: string[] = [];
  for (const head of ordered) {
    if (ok.length >= MAX_HAVES) break;
    if (git(clonePath, ['rev-list', '--objects', '--quiet', head, ...(ok.length ? ['--not', ...ok] : [])]).ok) ok.push(head);
  }
  return ok;
}

function setRefs(clonePath: string, lines: string[]): void {
  if (lines.length) git(clonePath, ['update-ref', '--stdin'], { input: `${lines.join('\n')}\n` });
}

/**
 * Grow `clonePath` from the packs a reset kept for it, instead of a warm
 * restore or a clone. False (and nothing left at `clonePath`) when there is
 * nothing kept or any check fails; the caller then restores or clones as usual.
 * The kept dir is consumed either way.
 *
 * The result is shaped like a fresh cloud clone (git-clone.ts): the default
 * branch only, checked out and tracking origin's, origin/HEAD set, shallow
 * when the kept clone was. Not like a warm restore: there is no snapshot tip
 * (WARM_BASE_REF), so a park bundle is built against origin, as after a clone.
 *
 * Origin is asked for what it added only: the fetch negotiates with the kept
 * commits (temporary refs under HAVE_REF_PREFIX, deleted after), and does not
 * run at all when `git ls-remote` shows origin's tip is already kept.
 *
 * BUILDD_PHASE=restore_reuse_start/_end around it, BUILDD_REPO_SOURCE=reuse on
 * success, and the metrics restore_reuse_bytes (what the fetch brought) and
 * reuse_fetch_skipped, for the run report.
 */
export function seedCloneFromKept(clonePath: string, cloneUrl: string, keptDir: string, o: SeedOptions): boolean {
  if (!existsSync(join(keptDir, 'pack'))) return false;
  emitPhase('restore_reuse_start', o.lineOpts);
  try {
    const ok = seed(clonePath, cloneUrl, keptDir, o);
    if (ok) emitRepoSource('reuse', undefined, o.lineOpts);
    return ok;
  } finally {
    emitPhase('restore_reuse_end', o.lineOpts);
  }
}

function seed(clonePath: string, cloneUrl: string, keptDir: string, o: SeedOptions): boolean {
  const tipLine = (readSmall(join(keptDir, 'tip')) ?? '').trim().split(' ');
  const hintBranch = tipLine[0] && BRANCH_RE.test(tipLine[0]) && !tipLine[0].includes('..') ? tipLine[0] : null;
  const branch = o.defaultBranch && BRANCH_RE.test(o.defaultBranch) ? o.defaultBranch : hintBranch;
  const tip = hintBranch === branch && tipLine[1] && HEX_OID_RE.test(tipLine[1]) ? tipLine[1] : null;
  const failWith = (why: string): false => {
    o.log(`[reuse] not seeding from the kept store: ${why}`);
    rmSync(clonePath, { recursive: true, force: true });
    rmSync(keptDir, { recursive: true, force: true });
    return false;
  };
  if (!branch) return failWith('no default branch');
  try {
    rmSync(clonePath, { recursive: true, force: true });
    mkdirSync(clonePath, { recursive: true });
    if (!git(clonePath, ['init', '-q', '-b', branch]).ok) return failWith('git init failed');
    const packDir = join(clonePath, '.git', 'objects', 'pack');
    mkdirSync(packDir, { recursive: true });
    // The shallow boundary first: a cloud clone's pack names parents it does
    // not hold, which git only accepts once their children are known shallow.
    const shallow = readSmall(join(keptDir, 'shallow'));
    if (shallow) writeFileSync(join(clonePath, '.git', 'shallow'), shallow);
    let packs = 0;
    for (const name of readdirSync(join(keptDir, 'pack'))) {
      if (!PACK_RE.test(name)) continue;
      const dest = join(packDir, name);
      renameSync(join(keptDir, 'pack', name), dest);
      // Re-hashes every object and writes a fresh .idx; a corrupted pack
      // fails here. Not --strict: that also fsck's every object, which a
      // clone does not either, and connectivity is checked once below.
      const ix = git(clonePath, ['index-pack', dest]);
      if (!ix.ok) return failWith(`index-pack refused ${name}: ${ix.err}`);
      packs++;
    }
    if (packs === 0) return failWith('no packs kept');
    if (!git(clonePath, ['remote', 'add', '-t', branch, 'origin', cloneUrl]).ok) return failWith('remote add failed');
    const head = `refs/remotes/origin/${branch}`;
    // What the fetch negotiates with. The seed has no refs, and without
    // haves origin sends the whole tree again. The hint is not enough on its
    // own: the tip it names is often a loose object (a small fetch during the
    // previous task) the reset did not keep. Only complete commits are
    // offered, and fsck below checks whatever origin answers anyway.
    const haves = completeHeads(clonePath, tip);
    // Origin's tip already here, complete: nothing to fetch.
    const remote = git(clonePath, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`], { timeoutMs: 60_000 });
    const remoteTip = remote.ok ? remote.out.split(/\s+/)[0] ?? '' : '';
    const skipFetch = HEX_OID_RE.test(remoteTip)
      && (haves.includes(remoteTip) || git(clonePath, ['rev-list', '--objects', '--quiet', remoteTip]).ok);
    const before = objectBytesOf(clonePath);
    if (skipFetch) {
      if (!git(clonePath, ['update-ref', head, remoteTip]).ok) return failWith('update-ref failed');
    } else {
      setRefs(clonePath, haves.map((oid, i) => `create ${HAVE_REF_PREFIX}${i} ${oid}`));
      const fetchError = o.fetchOrigin(clonePath);
      setRefs(clonePath, haves.map((_, i) => `delete ${HAVE_REF_PREFIX}${i}`));
      if (fetchError) return failWith(`fetch failed: ${fetchError}`);
    }
    emitMetric('reuse_fetch_skipped', skipFetch ? 1 : 0, o.lineOpts);
    emitMetric('restore_reuse_bytes', Math.max(0, objectBytesOf(clonePath) - before), o.lineOpts);
    if (!git(clonePath, ['rev-parse', '--verify', '-q', head]).ok) return failWith(`origin has no ${branch}`);
    const fsck = git(clonePath, ['fsck', '--connectivity-only', '--no-dangling']);
    if (!fsck.ok) return failWith(`fsck --connectivity-only failed: ${fsck.err}`);
    git(clonePath, ['symbolic-ref', 'refs/remotes/origin/HEAD', head]);
    if (!git(clonePath, ['checkout', '-q', '-B', branch, '--track', `origin/${branch}`]).ok) return failWith('checkout failed');
    rmSync(keptDir, { recursive: true, force: true });
    o.log(`[reuse] seeded ${clonePath} from ${packs} kept pack(s); refs fetched from origin`);
    return true;
  } catch (err) {
    return failWith(describe(err));
  }
}

/** The kept dir for a clone path, when a reset left one (cloud containers only). */
export function keptDirForClone(env: Record<string, string | undefined>, clonePath: string): string | null {
  if (env.BUILDD_EXECUTOR !== 'cloud') return null;
  const home = env.HOME;
  if (!home) return null;
  const name = clonePath.split('/').filter(Boolean).pop() ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const dir = join(keepDirOf(home), 'git', name);
  return existsSync(dir) ? dir : null;
}

/** /proc, as stopOtherProcesses reads it. Empty where there is no /proc. */
export function listProcsFromProc(): ProcInfo[] {
  if (!existsSync('/proc/self/stat')) return [];
  const procs: ProcInfo[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // A zombie runs nothing; tini reaps it.
      if (rest[0] === 'Z') continue;
      const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf-8'));
      if (!m) continue;
      procs.push({ pid, ppid: Number(rest[1]), uid: Number(m[1]), startTime: Number(rest[19]) });
    } catch { /* gone already */ }
  }
  return procs;
}
