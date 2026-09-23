/**
 * The runner's own stores refuse to resolve the operator's real runner home
 * from inside a test runtime.
 *
 * `scripts/run-unit-tests.ts` injects a throwaway BUILDD_HOME into every test
 * process, but that only protects runs that go through it. A raw `bun test`
 * (including `apps/runner`'s own `test` script), or a checkout whose runner
 * predates the injection, fell straight through to `$HOME/.buildd` — and the
 * fixture records it wrote there were then reconciled by the live runner as
 * if they were fleet data. This makes the modules themselves fail closed, so
 * the protection no longer depends on how the test was launched.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-home-guard.test.ts
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBuilddHome, isTestRuntime, UnisolatedTestHomeError } from '../../src/buildd-home';

const fakeHome = mkdtempSync(join(tmpdir(), 'buildd-home-guard-home-'));
const tmp = tmpdir();
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('isTestRuntime', () => {
  test('NODE_ENV=test is a test runtime', () => {
    expect(isTestRuntime({ NODE_ENV: 'test' }, '/srv/runner/src/index.ts')).toBe(true);
  });

  test('a *.test.ts entrypoint is a test runtime even when NODE_ENV says otherwise', () => {
    expect(isTestRuntime({ NODE_ENV: 'production' }, '/x/apps/runner/__tests__/unit/a.test.ts')).toBe(true);
    expect(isTestRuntime({}, '/x/a.spec.tsx')).toBe(true);
  });

  test('the runner entrypoint is not a test runtime', () => {
    expect(isTestRuntime({}, '/x/apps/runner/src/index.ts')).toBe(false);
    expect(isTestRuntime({ NODE_ENV: 'production' }, '/x/apps/runner/src/index.ts')).toBe(false);
  });
});

describe('resolveBuilddHome', () => {
  const runnerMain = '/x/apps/runner/src/index.ts';

  test('outside tests: BUILDD_HOME wins, else $HOME/.buildd (unchanged prod behaviour)', () => {
    expect(resolveBuilddHome({ env: {}, home: fakeHome, tmp, main: runnerMain })).toBe(join(fakeHome, '.buildd'));
    expect(resolveBuilddHome({ env: { BUILDD_HOME: '/srv/buildd' }, home: fakeHome, tmp, main: runnerMain })).toBe('/srv/buildd');
  });

  test('in a test runtime with no BUILDD_HOME it throws instead of defaulting to the real home', () => {
    expect(() => resolveBuilddHome({ env: { NODE_ENV: 'test' }, home: fakeHome, tmp, main: runnerMain }))
      .toThrow(UnisolatedTestHomeError);
  });

  test('in a test runtime, BUILDD_HOME pointing at the real home throws', () => {
    expect(() => resolveBuilddHome({
      env: { NODE_ENV: 'test', BUILDD_HOME: join(fakeHome, '.buildd') }, home: fakeHome, tmp, main: runnerMain,
    })).toThrow(UnisolatedTestHomeError);
  });

  test('in a test runtime, a BUILDD_HOME outside the temp dir throws (e.g. one inherited from a runner)', () => {
    expect(() => resolveBuilddHome({
      env: { NODE_ENV: 'test', BUILDD_HOME: '/srv/buildd' }, home: fakeHome, tmp, main: runnerMain,
    })).toThrow(UnisolatedTestHomeError);
  });

  test('in a test runtime, a temp BUILDD_HOME is returned as-is', () => {
    const home = join(tmp, 'buildd-test-home-abc');
    expect(resolveBuilddHome({ env: { NODE_ENV: 'test', BUILDD_HOME: home }, home: fakeHome, tmp, main: runnerMain }))
      .toBe(home);
  });

  test('a sibling path that merely shares the temp prefix is not "inside" it', () => {
    expect(() => resolveBuilddHome({
      env: { NODE_ENV: 'test', BUILDD_HOME: `${tmp}-evil/buildd` }, home: fakeHome, tmp, main: runnerMain,
    })).toThrow(UnisolatedTestHomeError);
  });
});

describe('runner stores refuse to write the real home from a test runtime', () => {
  test('no store creates $HOME/.buildd when BUILDD_HOME is missing', () => {
    // Remove the injected BUILDD_HOME and point HOME at a throwaway dir: any
    // write that falls through to the default lands where we can see it.
    const { BUILDD_HOME: _dropped, ...rest } = process.env;
    const probe = join(import.meta.dir, '..', 'fixtures', 'home-guard-probe.ts');
    const child = Bun.spawnSync([process.execPath, 'run', probe], {
      env: { ...rest, HOME: fakeHome, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = `${child.stdout.toString()}${child.stderr.toString()}`;

    // The probe must actually have run every store, or an empty home proves nothing.
    for (const name of ['session-logger', 'worker-store', 'history-store', 'outbox']) {
      expect(out).toContain(`${name}:`);
    }

    const realHome = join(fakeHome, '.buildd');
    const leaked = existsSync(realHome) ? readdirSync(realHome, { recursive: true }) : [];
    expect({ leaked, out: leaked.length ? out : '' }).toEqual({ leaked: [], out: '' });
  });
});
