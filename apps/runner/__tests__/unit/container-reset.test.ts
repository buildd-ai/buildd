/**
 * The reset between two tasks in one reused cloud container
 * (container-reset.ts), and the seed the next task's clone grows from.
 *
 * Real filesystem, real git, real processes. The previous task plants
 * everything it could leave for the next one (files in HOME, a global git
 * hooksPath, a repo hook, a core.fsmonitor, an env var in rc files and in a
 * background process, its task token on disk and in a process env, registry
 * config in the dependency cache) and none of it may survive.
 *
 * The process list is injected: on a workstation the real /proc walk would
 * kill the developer's own session. It is built from `ps` over the pids this
 * test spawned, so the kills are real.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  KEEP_DIRNAME,
  keptDirForClone,
  readTipHint,
  resetContainer,
  seedCloneFromKept,
  type ResetDeps,
  type ResetPaths,
} from '../../src/container-reset';
import { captureDependencyManifest } from '../../src/dependency-manifest';
import type { ProcInfo } from '../../src/run-once';

const OLD_TOKEN = 'bldt_previous-task-token-PLANTED';
const PLANTED_ENV = 'PLANTED_BY_PREVIOUS_TASK';

let root: string;
let spawned: number[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

/** Running, and not a zombie waiting to be reaped. */
function alive(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout?.trim() ?? '';
  return stat !== '' && !stat.startsWith('Z');
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

function filesContaining(dir: string, needle: string): string[] {
  return walkFiles(dir).filter(f => {
    try { return lstatSync(f).isFile() && readFileSync(f).includes(needle); } catch { return false; }
  });
}

interface World {
  paths: ResetPaths;
  origin: string;
  clone: string;
  marker: string;
  /** The image's main process stand-in: must survive. */
  mainPid: number;
  /** The previous task's processes: must not. */
  taskPids: number[];
  procs(): ProcInfo[];
}

function makeWorld(): World {
  const home = join(root, 'home');
  const builddHome = join(home, '.buildd');
  const isolationRoot = join(builddHome, 'once-workspaces');
  const cacheDir = join(home, '.bun', 'install', 'cache');
  const scratch = join(root, 'tmp');
  const marker = join(root, 'hook-ran');
  mkdirSync(scratch, { recursive: true });

  // origin with two commits, cloned the way --once does (a pack, origin refs).
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.txt'), 'one\n');
  git(origin, 'add', '.');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'one');
  writeFileSync(join(origin, 'b.txt'), 'two\n');
  git(origin, 'add', '.');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'two');
  const clone = join(isolationRoot, 'ws_a');
  mkdirSync(isolationRoot, { recursive: true });
  git(root, 'clone', '-q', '--no-local', `file://${origin}`, clone);

  // ── What the previous task plants ──
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: `touch ${marker}` }] } }));
  writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${join(home, 'evil-hooks')}\n`);
  mkdirSync(join(home, 'evil-hooks'));
  writeFileSync(join(home, 'evil-hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(home, 'evil-hooks', 'post-checkout'), 0o755);
  writeFileSync(join(home, '.bashrc'), `export ${PLANTED_ENV}=1\n`);
  writeFileSync(join(home, '.profile'), `export ${PLANTED_ENV}=1\n`);
  writeFileSync(join(home, '.bash_history'), `curl -H "Authorization: Bearer ${OLD_TOKEN}"\n`);
  writeFileSync(join(builddHome, 'worker.json'), JSON.stringify({ token: OLD_TOKEN }));
  mkdirSync(join(home, 'work', 'scratch'), { recursive: true });
  writeFileSync(join(home, 'work', 'scratch', 'notes.md'), 'previous task scratch');
  // Repo-level: a hook and an fsmonitor that would run on any git command.
  writeFileSync(join(clone, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(clone, '.git', 'hooks', 'post-checkout'), 0o755);
  writeFileSync(join(root, 'fsmonitor.sh'), `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(join(root, 'fsmonitor.sh'), 0o755);
  execFileSync('git', ['config', '--local', 'core.fsmonitor', join(root, 'fsmonitor.sh')], { cwd: clone });
  writeFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), `${join(root, 'elsewhere')}\n`);
  writeFileSync(join(clone, 'uncommitted.txt'), 'builder work in progress');
  // Dependency cache: one package (kept), registry config with the token (not).
  mkdirSync(join(cacheDir, 'left-pad@1.3.0'), { recursive: true });
  writeFileSync(join(cacheDir, 'left-pad@1.3.0', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(cacheDir, '.npmrc'), `//registry.npmjs.org/:_authToken=${OLD_TOKEN}\n`);
  writeFileSync(join(cacheDir, 'left-pad@1.3.0', '.env'), `TOKEN=${OLD_TOKEN}\n`);
  symlinkSync('/etc/hosts', join(cacheDir, 'escape'));
  writeFileSync(join(scratch, 'buildd-ca-bundle.pem'), 'old');
  writeFileSync(join(scratch, 'leak.txt'), OLD_TOKEN);

  // Processes: the image's main process, then the previous task's runner
  // (with its token in env) and a daemon it left reparented to init.
  const env = { ...process.env, BUILDD_API_KEY: OLD_TOKEN, [PLANTED_ENV]: '1' };
  const main = spawn('sleep', ['300'], { stdio: 'ignore' });
  const runner = spawn('sleep', ['300'], { stdio: 'ignore', env });
  const daemonPid = Number(execFileSync('sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf-8', env }).trim());
  spawned.push(main.pid!, runner.pid!, daemonPid);

  const order = [main.pid!, runner.pid!, daemonPid];
  const procs = (): ProcInfo[] => {
    const live = order.filter(alive);
    if (!live.length) return [];
    const r = spawnSync('ps', ['-o', 'pid=,ppid=,uid=,stat=', '-p', live.join(',')], { encoding: 'utf-8' });
    // A killed child of this process stays a zombie until it is reaped (in a container, tini reaps).
    return (r.stdout ?? '').split('\n').map(l => l.trim()).filter(l => l && !/\sZ\S*$/.test(l)).map(l => {
      const [pid, ppid, uid] = l.split(/\s+/).map(Number) as [number, number, number];
      // The main process is init's first child in a container; the daemon a later one.
      return pid === main.pid ? { pid, ppid: 1, uid, startTime: 0 } : { pid, ppid: pid === daemonPid ? 1 : ppid, uid, startTime: order.indexOf(pid) + 1 };
    });
  };

  return {
    paths: { home, warmHandover: 'repo', isolationRoot, cacheDir, skeletonDirs: [builddHome, join(home, 'work')], scratchDirs: [scratch] },
    origin, clone, marker,
    mainPid: main.pid!,
    taskPids: [runner.pid!, daemonPid],
    procs,
  };
}

function deps(w: World, over: Partial<ResetDeps> = {}): ResetDeps {
  return {
    listProcs: w.procs,
    kill: (pid) => process.kill(pid, 'SIGKILL'),
    selfPid: process.pid,
    uid: process.getuid!(),
    sleep: (ms) => Bun.sleepSync(ms),
    log: () => {},
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'container-reset-'));
  spawned = [];
});

afterEach(() => {
  for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true });
});

describe('resetContainer', () => {
  test('nothing the previous task left is reachable: files, hooks, env, processes, token', () => {
    const w = makeWorld();
    const r = resetContainer(w.paths, deps(w));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.keptPacks).toBeGreaterThan(0);
    expect(r.keptCache).toBe(true);

    // Processes: the previous task's are dead, the container's main process is not.
    Bun.sleepSync(50);
    for (const pid of w.taskPids) expect(alive(pid)).toBe(false);
    expect(alive(w.mainPid)).toBe(true);

    // HOME holds only the keep dir, the dependency cache and empty skeleton dirs.
    const home = w.paths.home;
    expect(readdirSync(home).sort()).toEqual(['.bun', '.buildd', KEEP_DIRNAME, 'work'].sort());
    expect(readdirSync(join(home, '.buildd'))).toEqual([]);
    expect(readdirSync(join(home, 'work'))).toEqual([]);
    for (const gone of ['.claude', '.gitconfig', 'evil-hooks', '.bashrc', '.profile', '.bash_history']) {
      expect(existsSync(join(home, gone))).toBe(false);
    }
    expect(existsSync(w.clone)).toBe(false);
    expect(readdirSync(w.paths.scratchDirs[0]!)).toEqual([]);

    // No file anywhere it could read carries the old token or the planted env var.
    expect(filesContaining(home, OLD_TOKEN)).toEqual([]);
    expect(filesContaining(home, PLANTED_ENV)).toEqual([]);
    expect(filesContaining(w.paths.scratchDirs[0]!, OLD_TOKEN)).toEqual([]);

    // The cache keeps packages and drops config and escaping symlinks.
    expect(readFileSync(join(w.paths.cacheDir, 'left-pad@1.3.0', 'index.js'), 'utf-8')).toContain('module.exports');
    expect(existsSync(join(w.paths.cacheDir, '.npmrc'))).toBe(false);
    expect(existsSync(join(w.paths.cacheDir, 'left-pad@1.3.0', '.env'))).toBe(false);
    expect(existsSync(join(w.paths.cacheDir, 'escape'))).toBe(false);

    // The keep dir holds packs and plain hints only: no config, hooks, refs, alternates, loose objects, index files.
    const kept = join(home, KEEP_DIRNAME, 'git', 'ws_a');
    const keptFiles = walkFiles(kept).map(f => f.slice(kept.length + 1));
    expect(keptFiles.every(f => /^pack\/pack-[0-9a-f]+\.pack$/.test(f) || f === 'tip' || f === 'shallow')).toBe(true);
    expect(readFileSync(join(kept, 'tip'), 'utf-8')).toMatch(/^main [0-9a-f]{40}\n$/);

    // Reset ran no git in the previous clone: neither the hook nor the fsmonitor fired.
    expect(existsSync(w.marker)).toBe(false);
  });

  test('a process that will not die fails the reset (the agent then replaces the container)', () => {
    const w = makeWorld();
    const r = resetContainer(w.paths, deps(w, { kill: () => {}, sleep: () => {} }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('processes still running');
  });

  test('anything left where the reset expects nothing fails it', () => {
    const w = makeWorld();
    // A dir the reset must leave empty that still holds files after the wipe.
    const r = resetContainer({ ...w.paths, skeletonDirs: [...w.paths.skeletonDirs, w.paths.cacheDir] }, deps(w));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('left behind');
  });

  test('a keep dir from an earlier reset is discarded, not carried forward', () => {
    const w = makeWorld();
    const stale = join(w.paths.home, KEEP_DIRNAME, 'git', 'ws_old', 'pack');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'planted'), OLD_TOKEN);
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    expect(existsSync(join(w.paths.home, KEEP_DIRNAME, 'git', 'ws_old'))).toBe(false);
  });
});

describe('seedCloneFromKept', () => {
  function fetchOrigin(p: string): string | null {
    const r = spawnSync('git', ['fetch', '-q', 'origin'], { cwd: p, encoding: 'utf-8' });
    return r.status === 0 ? null : r.stderr;
  }

  test('the next task starts from origin\'s refs with re-verified objects and no hook, config or file of the previous task', () => {
    const w = makeWorld();
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    // origin moved on after the previous task.
    writeFileSync(join(w.origin, 'c.txt'), 'three\n');
    git(w.origin, 'add', '.');
    git(w.origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'three');
    const originTip = git(w.origin, 'rev-parse', 'HEAD');

    const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone);
    expect(kept).not.toBeNull();
    const ok = seedCloneFromKept(w.clone, `file://${w.origin}`, kept!, { defaultBranch: 'main', fetchOrigin, log: () => {} });
    expect(ok).toBe(true);
    expect(git(w.clone, 'rev-parse', 'HEAD')).toBe(originTip);
    expect(existsSync(join(w.clone, 'c.txt'))).toBe(true);
    expect(existsSync(join(w.clone, 'uncommitted.txt'))).toBe(false);
    const hooks = readdirSync(join(w.clone, '.git', 'hooks')).filter(h => !h.endsWith('.sample'));
    expect(hooks).toEqual([]);
    const config = readFileSync(join(w.clone, '.git', 'config'), 'utf-8');
    expect(config).not.toContain('fsmonitor');
    expect(config).not.toContain('hooksPath');
    expect(existsSync(join(w.clone, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    // Git in the new clone runs nothing the previous task planted.
    git(w.clone, 'checkout', '-q', '-b', 'review');
    git(w.clone, 'status');
    expect(existsSync(w.marker)).toBe(false);
    // Consumed.
    expect(existsSync(kept!)).toBe(false);
  });

  test('reset after an in-clone task seeds only the remote default with no task state', () => {
    const w = makeWorld();
    // Disable the planted executable settings before simulating task commits.
    git(w.clone, 'config', '--unset', 'core.fsmonitor');
    rmSync(join(w.clone, '.git', 'hooks', 'post-checkout'));
    rmSync(join(w.clone, '.git', 'objects', 'info', 'alternates'));
    git(w.clone, 'checkout', '-q', '-B', 'buildd/task-example', 'origin/main');
    writeFileSync(join(w.clone, 'task-only.txt'), 'task work\n');
    git(w.clone, 'add', 'task-only.txt');
    git(w.clone, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'task work');
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone)!;
    expect(seedCloneFromKept(w.clone, `file://${w.origin}`, kept, { defaultBranch: 'main', fetchOrigin, log: () => {} })).toBe(true);
    expect(git(w.clone, 'branch', '--show-current')).toBe('main');
    expect(git(w.clone, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(w.clone, 'rev-parse', 'HEAD')).toBe(git(w.origin, 'rev-parse', 'HEAD'));
    expect(git(w.clone, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(w.clone, 'task-only.txt'))).toBe(false);
    expect(existsSync(join(w.clone, 'uncommitted.txt'))).toBe(false);
    expect(existsSync(join(w.clone, '.buildd-worktrees'))).toBe(false);
  });

  test('a tampered pack is refused: nothing is left and the caller clones instead', () => {
    const w = makeWorld();
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone)!;
    const pack = readdirSync(join(kept, 'pack'))[0]!;
    const bytes = readFileSync(join(kept, 'pack', pack));
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    chmodSync(join(kept, 'pack', pack), 0o644);
    writeFileSync(join(kept, 'pack', pack), bytes);
    const ok = seedCloneFromKept(w.clone, `file://${w.origin}`, kept, { defaultBranch: 'main', fetchOrigin, log: () => {} });
    expect(ok).toBe(false);
    expect(existsSync(w.clone)).toBe(false);
    expect(existsSync(kept)).toBe(false);
  });

  test('a failed fetch is refused too', () => {
    const w = makeWorld();
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone)!;
    // Origin unreachable: ls-remote cannot show its tip is kept, so the fetch runs, and fails.
    expect(seedCloneFromKept(w.clone, `file://${w.origin}-gone`, kept, { defaultBranch: 'main', fetchOrigin: () => 'offline', log: () => {} })).toBe(false);
    expect(existsSync(w.clone)).toBe(false);
  });

  test('outside a cloud container there is never a kept dir', () => {
    const w = makeWorld();
    expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
    expect(keptDirForClone({ HOME: w.paths.home }, w.clone)).toBeNull();
  });
});

describe('readTipHint', () => {
  test('only a hex object name on a plain branch name is accepted', () => {
    const g = join(mkdtempSync(join(tmpdir(), 'tip-')), '.git');
    mkdirSync(join(g, 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(g, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
    writeFileSync(join(g, 'refs', 'remotes', 'origin', 'main'), '$(touch /tmp/x)\n');
    expect(readTipHint(g)).toBeNull();
    writeFileSync(join(g, 'refs', 'remotes', 'origin', 'main'), `${'a'.repeat(40)}\n`);
    expect(readTipHint(g)).toEqual({ branch: 'main', oid: 'a'.repeat(40) });
    writeFileSync(join(g, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/../../x\n');
    expect(readTipHint(g)).toBeNull();
  });
});

 describe('verified dependency handover', () => {
  test('keeps verified dependency entries through reset and seed', () => {
    const w = makeWorld();
    const packageDir = join(w.clone, 'node_modules', 'tiny');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = 1;');
    const manifest = captureDependencyManifest(w.clone);
    writeFileSync(join(w.clone, '.buildd-deps-manifest.json'), JSON.stringify(manifest));
    w.paths.warmHandover = 'deps';
    w.paths.expectedDigest = manifest.digest;
    const reset = resetContainer(w.paths, deps(w));
    expect(reset.ok).toBe(true);
    expect(reset.handover?.fellBack).toBe(false);
    const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone)!;
    expect(seedCloneFromKept(w.clone, `file://${w.origin}`, kept, { defaultBranch: 'main', fetchOrigin: () => null, log: () => {} })).toBe(true);
    expect(readFileSync(join(packageDir, 'index.js'), 'utf8')).toBe('module.exports = 1;');
  });

  test('a digest planted on disk never replaces the expected digest from the supervisor', () => {
    const w = makeWorld();
    mkdirSync(join(w.clone, 'node_modules'), { recursive: true });
    writeFileSync(join(w.clone, 'node_modules', 'planted.js'), 'evil');
    const manifest = captureDependencyManifest(w.clone);
    writeFileSync(join(w.clone, '.buildd-deps-manifest.json'), JSON.stringify(manifest));
    w.paths.warmHandover = 'deps';
    w.paths.expectedDigest = '0'.repeat(64);
    const reset = resetContainer(w.paths, deps(w));
    expect(reset.ok).toBe(true);
    expect(reset.handover?.fellBack).toBe(true);
    expect(existsSync(join(w.paths.home, KEEP_DIRNAME, 'git', 'ws_a', 'deps'))).toBe(false);
  });
});

 test('off keeps neither repository packs nor dependency cache', () => {
  const w = makeWorld();
  w.paths.warmHandover = 'off';
  const reset = resetContainer(w.paths, deps(w));
  expect(reset.ok).toBe(true);
  expect(reset.keptPacks).toBe(0);
  expect(reset.keptCache).toBe(false);
  expect(existsSync(w.paths.cacheDir)).toBe(false);
 });

 test('origin tracked fixtures named node_modules survive reset and seed', () => {
  const w = makeWorld();
  const fixturePath = 'fixtures/node_modules/tiny/index.js';
  mkdirSync(join(w.origin, 'fixtures/node_modules/tiny'), { recursive: true });
  writeFileSync(join(w.origin, fixturePath), 'tracked fixture');
  git(w.origin, 'add', fixturePath);
  git(w.origin, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'fixture');
  git(w.clone, '-c', 'core.fsmonitor=false', 'fetch', 'origin');
  git(w.clone, '-c', 'core.fsmonitor=false', 'reset', '--hard', 'origin/main');
  const manifest = captureDependencyManifest(w.clone);
  writeFileSync(join(w.clone, '.buildd-deps-manifest.json'), JSON.stringify(manifest));
  w.paths.warmHandover = 'deps';
  w.paths.expectedDigest = manifest.digest;
  expect(resetContainer(w.paths, deps(w)).ok).toBe(true);
  const kept = keptDirForClone({ BUILDD_EXECUTOR: 'cloud', HOME: w.paths.home }, w.clone)!;
  expect(seedCloneFromKept(w.clone, `file://${w.origin}`, kept, { defaultBranch: 'main', fetchOrigin: path => { git(path, 'fetch', 'origin'); return null; }, log: () => {} })).toBe(true);
  expect(readFileSync(join(w.clone, fixturePath), 'utf8')).toBe('tracked fixture');
 });
