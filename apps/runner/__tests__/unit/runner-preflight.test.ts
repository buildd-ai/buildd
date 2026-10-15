/**
 * Boot preflight: dangling packages are repaired once, bounded, or reported in
 * one plain line, never a raw ENOENT crash loop (task c08b35ae).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';

const nodeFs = require('fs') as typeof import('fs');
const HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'preflight-'));
const { runPreflight, fixLine, PREFLIGHT_INSTALL_TIMEOUT_MS, PREFLIGHT_RETRY_COOLDOWN_MS } = await import('../../src/preflight');
const { findMissingPackages, INSTALL_LOCK_FILE, INSTALL_LOCK_MAX_AGE_MS } = await import('../../src/package-tree');
const { busyLine } = await import('../../src/preflight');

const RUNNER = join(HOME, 'apps', 'runner');

afterAll(() => nodeFs.rmSync(HOME, { recursive: true, force: true }));

function seed(opts: { dangling: boolean }): void {
  nodeFs.rmSync(HOME, { recursive: true, force: true });
  nodeFs.mkdirSync(join(RUNNER, 'node_modules'), { recursive: true });
  nodeFs.writeFileSync(join(RUNNER, 'package.json'), JSON.stringify({ dependencies: { 'pusher-js': '^8', zod: '^4' } }));
  const store = join(HOME, 'node_modules', '.bun', 'x', 'node_modules');
  for (const dep of ['pusher-js', 'zod']) {
    nodeFs.mkdirSync(join(store, dep), { recursive: true });
    nodeFs.writeFileSync(join(store, dep, 'package.json'), '{}');
    nodeFs.symlinkSync(`../../../node_modules/.bun/x/node_modules/${dep}`, join(RUNNER, 'node_modules', dep));
  }
  // the incident: the root node_modules is gone, every link dangles
  if (opts.dangling) nodeFs.rmSync(join(HOME, 'node_modules'), { recursive: true, force: true });
}

const heal = () => {
  const store = join(HOME, 'node_modules', '.bun', 'x', 'node_modules');
  for (const dep of ['pusher-js', 'zod']) {
    nodeFs.mkdirSync(join(store, dep), { recursive: true });
    nodeFs.writeFileSync(join(store, dep, 'package.json'), '{}');
  }
};

let logs: string[] = [];
const log = (l: string) => logs.push(l);
beforeEach(() => { logs = []; });

describe('findMissingPackages', () => {
  test('a dangling symlink counts as missing', () => {
    seed({ dangling: true });
    expect(findMissingPackages(HOME)).toEqual(['pusher-js', 'zod']);
  });
  test('a healthy tree has nothing missing', () => {
    seed({ dangling: false });
    expect(findMissingPackages(HOME)).toEqual([]);
  });
});

describe('runPreflight', () => {
  test('a healthy tree costs nothing: no install', () => {
    seed({ dangling: false });
    let installs = 0;
    const r = runPreflight(HOME, { log, install: () => { installs++; return { status: 0 }; } });
    expect(r.ok).toBe(true);
    expect(installs).toBe(0);
  });

  test('dangling packages are repaired with one bounded install, then boot continues', () => {
    seed({ dangling: true });
    const calls: Array<[string, number]> = [];
    const r = runPreflight(HOME, { log, install: (cwd, t) => { calls.push([cwd, t]); heal(); return { status: 0 }; } });
    expect(r.ok).toBe(true);
    expect(r.healed).toBe(true);
    expect(calls).toEqual([[HOME, PREFLIGHT_INSTALL_TIMEOUT_MS]]);
    expect(logs.join('\n')).toContain('running bun install');
  });

  test('an install that fails or times out ends in one plain line naming the fix', () => {
    seed({ dangling: true });
    const r = runPreflight(HOME, { log, install: () => ({ status: null, error: 'timed out' }) });
    expect(r.ok).toBe(false);
    expect(r.message).toBe(fixLine(HOME));
    expect(r.message).toContain(`cd ${HOME} && bun install`);
    expect(r.message).not.toContain('ENOENT');
  });

  test('a repair that just failed is not repeated on every restart', () => {
    seed({ dangling: true });
    let installs = 0;
    const install = () => { installs++; return { status: 1 }; };
    const t0 = 1_000_000_000;
    runPreflight(HOME, { log, install, now: () => t0 });
    const second = runPreflight(HOME, { log, install, now: () => t0 + 60_000 });
    expect(installs).toBe(1);
    expect(second.ok).toBe(false);
    expect(second.message).toBe(fixLine(HOME));
    // after the cooldown it may try again
    runPreflight(HOME, { log, install, now: () => t0 + PREFLIGHT_RETRY_COOLDOWN_MS + 1 });
    expect(installs).toBe(2);
  });

  test('packages moved aside by an interrupted update come back without any install', () => {
    seed({ dangling: false });
    nodeFs.renameSync(join(HOME, 'node_modules'), join(HOME, 'node_modules.buildd-prev'));
    nodeFs.rmSync(join(HOME, 'node_modules'), { recursive: true, force: true });
    let installs = 0;
    const r = runPreflight(HOME, { log, install: () => { installs++; return { status: 0 }; } });
    expect(r.ok).toBe(true);
    expect(installs).toBe(0);
    expect(findMissingPackages(HOME)).toEqual([]);
  });
});

describe('runPreflight while an auto-update is installing (second launch)', () => {
  const OTHER_PID = 424242;
  const T0 = 2_000_000_000;
  /** Mid-install: previous tree aside, half-built live tree whose links dangle. */
  function midInstall(lockAgeMs: number): void {
    seed({ dangling: false });
    nodeFs.renameSync(join(HOME, 'node_modules'), join(HOME, 'node_modules.buildd-prev'));
    nodeFs.mkdirSync(join(HOME, 'node_modules', '.bun'), { recursive: true }); // the install has started writing
    nodeFs.writeFileSync(join(HOME, INSTALL_LOCK_FILE), JSON.stringify({ pid: OTHER_PID, startedAt: T0 - lockAgeMs }));
  }

  test('a live, fresh lock: the in-flight tree is left alone and no repair install starts', () => {
    midInstall(60_000);
    let installs = 0;
    const r = runPreflight(HOME, { log, now: () => T0, isAlive: () => true, install: () => { installs++; return { status: 0 }; } });
    expect(installs).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(busyLine(HOME));
    // nothing moved: the aside copy is still where the updater expects it
    expect(nodeFs.existsSync(join(HOME, 'node_modules.buildd-prev'))).toBe(true);
    expect(nodeFs.existsSync(join(HOME, 'node_modules', '.bun'))).toBe(true);
  });

  test('the lock names a dead process: recovery runs and restores the previous tree', () => {
    midInstall(60_000);
    let installs = 0;
    const r = runPreflight(HOME, { log, now: () => T0, isAlive: () => false, install: () => { installs++; return { status: 0 }; } });
    expect(r.ok).toBe(true);
    expect(installs).toBe(0);
    expect(nodeFs.existsSync(join(HOME, 'node_modules.buildd-prev'))).toBe(false);
    expect(findMissingPackages(HOME)).toEqual([]);
  });

  test('the lock is older than the install bound: treated as stale even if the pid is alive (pid reuse)', () => {
    midInstall(INSTALL_LOCK_MAX_AGE_MS + 1);
    const r = runPreflight(HOME, { log, now: () => T0, isAlive: () => true, install: () => ({ status: 0 }) });
    expect(r.ok).toBe(true);
    expect(findMissingPackages(HOME)).toEqual([]);
  });

  test('the repair install holds the lock while it runs and drops it after', () => {
    seed({ dangling: true });
    let lockDuring: any = null;
    runPreflight(HOME, { log, install: () => {
      lockDuring = JSON.parse(nodeFs.readFileSync(join(HOME, INSTALL_LOCK_FILE), 'utf-8'));
      heal(); return { status: 0 };
    } });
    expect(lockDuring?.pid).toBe(process.pid);
    expect(nodeFs.existsSync(join(HOME, INSTALL_LOCK_FILE))).toBe(false);
  });
});

describe('the preload hook, run for real', () => {
  const FAKE = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'preflight-boot-'));
  afterAll(() => nodeFs.rmSync(FAKE, { recursive: true, force: true }));
  const repo = join(import.meta.dir, '../../../..');

  function layout(): void {
    nodeFs.rmSync(FAKE, { recursive: true, force: true });
    nodeFs.mkdirSync(join(FAKE, 'scripts'), { recursive: true });
    nodeFs.mkdirSync(join(FAKE, 'apps', 'runner', 'src'), { recursive: true });
    nodeFs.copyFileSync(join(repo, 'scripts/stub-server-only.ts'), join(FAKE, 'scripts/stub-server-only.ts'));
    for (const f of ['preflight.ts', 'package-tree.ts']) {
      nodeFs.copyFileSync(join(repo, 'apps/runner/src', f), join(FAKE, 'apps/runner/src', f));
    }
    nodeFs.writeFileSync(join(FAKE, 'apps/runner/src/index.ts'), 'console.log("RUNNER STARTED");\n');
    nodeFs.writeFileSync(join(FAKE, 'apps/runner/package.json'), JSON.stringify({ dependencies: { 'pusher-js': '^8' } }));
  }

  const boot = () => Bun.spawnSync(
    [process.execPath, '--no-env-file', 'run', '--preload', join(FAKE, 'scripts/stub-server-only.ts'), join(FAKE, 'apps/runner/src/index.ts')],
    { cwd: FAKE, stdout: 'pipe', stderr: 'pipe' },
  );

  test('old launchers get the message, not a crash: dangling link, repair on cooldown', () => {
    layout();
    nodeFs.mkdirSync(join(FAKE, 'apps/runner/node_modules'), { recursive: true });
    nodeFs.symlinkSync('../../../node_modules/.bun/x/node_modules/pusher-js', join(FAKE, 'apps/runner/node_modules/pusher-js'));
    nodeFs.writeFileSync(join(FAKE, '.buildd-package-repair'), String(Date.now())); // a repair just ran: do not spawn bun install here
    const r = boot();
    const err = r.stderr.toString();
    expect(r.exitCode).toBe(78);
    expect(r.stdout.toString()).not.toContain('RUNNER STARTED');
    expect(err).toContain('bun install');
    expect(err).not.toContain('ENOENT');
  });

  test('a healthy tree boots normally', () => {
    layout();
    nodeFs.mkdirSync(join(FAKE, 'apps/runner/node_modules/pusher-js'), { recursive: true });
    nodeFs.writeFileSync(join(FAKE, 'apps/runner/node_modules/pusher-js/package.json'), '{}');
    const r = boot();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('RUNNER STARTED');
  });
});
