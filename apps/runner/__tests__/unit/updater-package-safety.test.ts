/**
 * A failed or timed-out auto-update must never leave the runner without its
 * packages (task c08b35ae). Real temp dirs, fake git/bun; no network.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';

const nodeFs = require('fs') as typeof import('fs');
const HOME: string = nodeFs.mkdtempSync(join(require('os').tmpdir(), 'updater-safety-'));

const mockExecSync = mock(() => 'oldsha\n');
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { applyUpdate, rollbackTo, UPDATE_FAILURE_FILE } = await import('../../src/updater');
const { INSTALL_LOCK_FILE, recoverInterruptedSwap } = await import('../../src/package-tree');
import type { UpdateExecOps } from '../../src/updater';

const ROOT_NM = join(HOME, 'node_modules');
const RUNNER_NM = join(HOME, 'apps', 'runner', 'node_modules');

afterAll(() => nodeFs.rmSync(HOME, { recursive: true, force: true }));

/** A tree shaped like bun's: runner links point into the root store. */
function seedTree(): void {
  nodeFs.rmSync(HOME, { recursive: true, force: true });
  nodeFs.mkdirSync(join(ROOT_NM, '.bun', 'pusher-js@8', 'node_modules', 'pusher-js'), { recursive: true });
  nodeFs.writeFileSync(join(ROOT_NM, '.bun', 'pusher-js@8', 'node_modules', 'pusher-js', 'package.json'), '{}');
  nodeFs.mkdirSync(RUNNER_NM, { recursive: true });
  nodeFs.symlinkSync('../../../node_modules/.bun/pusher-js@8/node_modules/pusher-js', join(RUNNER_NM, 'pusher-js'));
}

const linkResolves = () => nodeFs.existsSync(join(RUNNER_NM, 'pusher-js', 'package.json'));

function ops(overrides: Partial<UpdateExecOps> = {}): UpdateExecOps {
  return { git: mock(async () => 'sha'), bunVersion: mock(async () => {}), bunInstall: mock(async () => {}), ...overrides };
}

const gitCalls = (o: UpdateExecOps) => (o.git as ReturnType<typeof mock>).mock.calls.map((c: any[]) => c[0] as string[]);

beforeEach(() => { mockExecSync.mockReset(); mockExecSync.mockReturnValue('oldsha\n'); seedTree(); });

describe('applyUpdate when the install fails', () => {
  test('the old packages are still there and still resolve', async () => {
    const o = ops({ bunInstall: mock(async () => { throw new Error('bun install --frozen-lockfile failed (exit 1)'); }) });
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(r.success).toBe(false);
    expect(nodeFs.existsSync(ROOT_NM)).toBe(true);
    expect(linkResolves()).toBe(true);
    expect(nodeFs.existsSync(ROOT_NM + '.buildd-prev')).toBe(false);
  });

  test('the working node_modules is not deleted before the install starts running', async () => {
    let seenDuringInstall: string[] = [];
    const o = ops({ bunInstall: mock(async () => { seenDuringInstall = nodeFs.readdirSync(HOME); throw new Error('boom'); }) });
    await applyUpdate(HOME, nodeFs, o);
    // moved aside (recoverable), never gone
    expect(seenDuringInstall).toContain('node_modules.buildd-prev');
  });

  test('the code goes back to the commit the packages belong to, and the caller is told', async () => {
    const o = ops({ bunInstall: mock(async () => { throw new Error('boom'); }) });
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(gitCalls(o)).toContainEqual(['reset', '--hard', 'oldsha']);
    expect(r.rolledBack).toBe(true);
  });

  test('a timeout is handled exactly like a failure and the reason is recorded', async () => {
    const o = ops({ bunInstall: mock(async () => { throw new Error('bun install --frozen-lockfile timed out after 600s'); }) });
    const warn = mock(() => {});
    const orig = console.error; console.error = warn as any;
    try { var r = await applyUpdate(HOME, nodeFs, o); } finally { console.error = orig; }
    expect(r.success).toBe(false);
    expect(r.error).toContain('timed out');
    const record = JSON.parse(nodeFs.readFileSync(join(HOME, UPDATE_FAILURE_FILE), 'utf-8'));
    expect(record.error).toContain('timed out');
    expect(record.packagesRestored).toBe(true);
    expect(record.codeRestored).toBe(true);
    expect(linkResolves()).toBe(true);
  });

  test('a partially written replacement is discarded, not mixed into the restored tree', async () => {
    const o = ops({
      bunInstall: mock(async () => {
        nodeFs.mkdirSync(join(ROOT_NM, 'half-written'), { recursive: true });
        throw new Error('boom');
      }),
    });
    await applyUpdate(HOME, nodeFs, o);
    expect(nodeFs.existsSync(join(ROOT_NM, 'half-written'))).toBe(false);
    expect(linkResolves()).toBe(true);
  });

  test('if the old packages cannot be moved back, they are reinstalled at the old commit', async () => {
    const realRename = nodeFs.renameSync;
    let installs = 0;
    const o = ops({
      bunInstall: mock(async () => { installs++; if (installs === 1) throw new Error('boom'); }),
    });
    // make the restore step fail
    const fsOps = Object.assign(Object.create(nodeFs), {
      renameSync: (a: string, b: string) => { if (b.endsWith('node_modules') && installs > 0) throw new Error('EXDEV'); return realRename(a, b); },
    });
    const r = await applyUpdate(HOME, fsOps, o);
    expect(r.success).toBe(false);
    expect(installs).toBe(2);
    const calls = gitCalls(o);
    expect(calls.findIndex((c) => c[0] === 'reset' && c[2] === 'oldsha')).toBeGreaterThan(-1);
  });
});

describe('applyUpdate when the install succeeds', () => {
  test('the previous packages are dropped only after the install', async () => {
    const o = ops({
      bunInstall: mock(async () => {
        expect(nodeFs.existsSync(ROOT_NM + '.buildd-prev')).toBe(true);
        nodeFs.mkdirSync(ROOT_NM, { recursive: true });
      }),
    });
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(r.success).toBe(true);
    expect(nodeFs.existsSync(ROOT_NM + '.buildd-prev')).toBe(false);
    expect(nodeFs.existsSync(RUNNER_NM + '.buildd-prev')).toBe(false);
  });
});

describe('rollbackTo when the install fails', () => {
  test('still leaves the packages in place', async () => {
    const o = ops({ bunInstall: mock(async () => { throw new Error('boom'); }) });
    const r = await rollbackTo('deadbeef', HOME, nodeFs, o);
    expect(r.success).toBe(false);
    expect(linkResolves()).toBe(true);
  });
});

describe('an update killed mid-install', () => {
  test('the next update restores the previous packages before judging anything', async () => {
    // killed after the move-aside: live dir gone, aside present
    nodeFs.renameSync(ROOT_NM, ROOT_NM + '.buildd-prev');
    nodeFs.renameSync(RUNNER_NM, RUNNER_NM + '.buildd-prev');
    const o = ops({ bunVersion: mock(async () => { throw new Error('bun: command not found'); }) });
    await applyUpdate(HOME, nodeFs, o);
    expect(nodeFs.existsSync(ROOT_NM)).toBe(true);
    expect(linkResolves()).toBe(true);
  });
});

describe('the install lock', () => {
  const lockPath = () => join(HOME, INSTALL_LOCK_FILE);

  test('is held for the whole install and removed after success', async () => {
    let during: any = null;
    const o = ops({ bunInstall: mock(async () => { during = JSON.parse(nodeFs.readFileSync(lockPath(), 'utf-8')); }) });
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(r.success).toBe(true);
    expect(during?.pid).toBe(process.pid);
    expect(typeof during?.startedAt).toBe('number');
    expect(nodeFs.existsSync(lockPath())).toBe(false);
  });

  test('is removed after a failed install too', async () => {
    const o = ops({ bunInstall: mock(async () => { throw new Error('boom'); }) });
    await applyUpdate(HOME, nodeFs, o);
    expect(nodeFs.existsSync(lockPath())).toBe(false);
  });

  test('a recovery pass from another process during the install leaves both trees alone', async () => {
    let restoredByOther: string[] | null = null;
    let asideAfter = false;
    const o = ops({ bunInstall: mock(async () => {
      // the half-built tree: links dangle, aside copy present
      nodeFs.mkdirSync(join(ROOT_NM, '.bun'), { recursive: true });
      // a second launch's preflight, seen from a different pid
      const lock = JSON.parse(nodeFs.readFileSync(lockPath(), 'utf-8'));
      nodeFs.writeFileSync(lockPath(), JSON.stringify({ ...lock, pid: 1 }));
      restoredByOther = recoverInterruptedSwap(HOME, nodeFs, { isAlive: () => true });
      asideAfter = nodeFs.existsSync(ROOT_NM + '.buildd-prev');
      heal();
    }) });
    const heal = () => {
      nodeFs.mkdirSync(join(ROOT_NM, '.bun', 'pusher-js@8', 'node_modules', 'pusher-js'), { recursive: true });
      nodeFs.writeFileSync(join(ROOT_NM, '.bun', 'pusher-js@8', 'node_modules', 'pusher-js', 'package.json'), '{}');
      nodeFs.mkdirSync(RUNNER_NM, { recursive: true });
      nodeFs.symlinkSync('../../../node_modules/.bun/pusher-js@8/node_modules/pusher-js', join(RUNNER_NM, 'pusher-js'));
    };
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(restoredByOther).toEqual([]);
    expect(asideAfter).toBe(true);
    expect(r.success).toBe(true);
    expect(linkResolves()).toBe(true);
  });

  test('a live install by another process refuses a second one without touching the tree', async () => {
    nodeFs.writeFileSync(lockPath(), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const o = ops();
    // our parent (the test runner) is alive and is not us; pid 1 does not exist on Windows
    const r = await applyUpdate(HOME, nodeFs, o);
    expect(r.success).toBe(false);
    expect(r.error).toContain('another package install is running');
    expect((o.bunInstall as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(nodeFs.existsSync(ROOT_NM + '.buildd-prev')).toBe(false);
    expect(linkResolves()).toBe(true);
  });
});
