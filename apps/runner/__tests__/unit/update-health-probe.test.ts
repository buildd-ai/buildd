import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  AUTO_UPDATE_RETRY_LIMIT,
  HEALTH_PROBE_SERVER,
  RUNNER_ENTRY,
  buildHealthProbeSpawn,
  hasAutoUpdateBudget,
} from '../../src/updater';

/**
 * The health probe boots the freshly-updated code on a spare port and only
 * restarts into it if it answers `/health`. In production it did the opposite of
 * its job for weeks: it could never succeed, so every attempt reset the tree
 * back to the previous commit and the fleet stayed pinned to old code.
 *
 * The cause was the spawn shape, not a timeout. The probe ran
 * `bun run src/index.ts` with `cwd` = `<install>/apps/runner`, and Bun reads
 * `bunfig.toml` **from the cwd only — it does not walk up to the repo root**
 * (the same trap `packages/core/bunfig.toml` exists to work around). The root
 * bunfig is what preloads `scripts/stub-server-only.ts`, without which any
 * transitive import of the DB layer throws `server-only`'s unconditional
 * `Error` at module load. So the child died before binding a port, every time,
 * in about a second — nothing to do with the 10s budget it was blamed on.
 *
 * These cases pin the invocation shape against exactly that regression.
 */
describe('buildHealthProbeSpawn — invocation shape', () => {
  const base = {
    installDir: '/home/coder/.buildd',
    probePort: 8767,
    probeHome: '/home/coder/.buildd/.health-probe',
    configFile: '/home/coder/.buildd/config.json',
    baseEnv: { PATH: '/usr/bin', PORT: '8766', BUILDD_HOME: '/home/coder/.buildd' },
  };

  // THE regression. `apps/runner` has no bunfig.toml, so a probe launched from
  // there cannot resolve the server-only stub and the child always crashes.
  test('runs from the install dir, never from apps/runner', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.cwd).toBe('/home/coder/.buildd');
    expect(spawn.cwd).not.toContain('apps/runner');
  });

  // Matching the launcher is the point: the probe's job is to answer "will the
  // launcher's next `bun run` work?", which it can only do by using the
  // launcher's own cwd and entry path.
  test('invokes the same entry path the launcher does', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.cmd).toEqual(['bun', 'run', RUNNER_ENTRY, '--debug']);
    expect(RUNNER_ENTRY).toBe('apps/runner/src/index.ts');
  });

  test('binds the probe port, not the live one', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.env.PORT).toBe('8767');
  });

  // --debug is explicit rather than inherited: the HTTP server only exists in
  // debug mode, so a probe without it would poll a port nothing is listening on
  // and read that as an unhealthy build.
  test('forces debug mode so an HTTP server actually exists to probe', () => {
    expect(buildHealthProbeSpawn(base).cmd).toContain('--debug');
  });
});

/**
 * The probe boots a *complete* second runner with the real credentials. Left
 * pointed at the live server it registers and starts claiming, and is then
 * killed a few seconds later — orphaning whatever it took. A probe must not be
 * able to take work it will never finish.
 */
describe('buildHealthProbeSpawn — isolation from live state', () => {
  const base = {
    installDir: '/home/coder/.buildd',
    probePort: 8767,
    probeHome: '/home/coder/.buildd/.health-probe',
    configFile: '/home/coder/.buildd/config.json',
    baseEnv: {
      BUILDD_HOME: '/home/coder/.buildd',
      BUILDD_SERVER: 'https://buildd.dev',
      PORT: '8766',
    },
  };

  test('cannot reach the coordination server, so it cannot claim a task', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.env.BUILDD_SERVER).toBe(HEALTH_PROBE_SERVER);
    expect(spawn.env.BUILDD_SERVER).not.toBe('https://buildd.dev');
  });

  // Worker state, worktrees and the repos cache all hang off BUILDD_HOME.
  test('writes its runtime state to an isolated home, not the live install', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.env.BUILDD_HOME).toBe('/home/coder/.buildd/.health-probe');
    expect(spawn.env.BUILDD_HOME).not.toBe('/home/coder/.buildd');
  });

  // The config is the one thing it SHOULD share: a probe that read a different
  // config would be validating a boot path production never takes.
  test('still reads the real config, so it validates the real boot path', () => {
    const spawn = buildHealthProbeSpawn(base);
    expect(spawn.env.BUILDD_CONFIG).toBe('/home/coder/.buildd/config.json');
  });

  test('inherits the rest of the environment, so bun stays on PATH', () => {
    const spawn = buildHealthProbeSpawn({ ...base, baseEnv: { ...base.baseEnv, PATH: '/home/coder/.bun/bin' } });
    expect(spawn.env.PATH).toBe('/home/coder/.bun/bin');
  });

  // Bun.spawn's env takes Record<string, string>; an inherited undefined would
  // otherwise land in the child as the literal "undefined".
  test('drops undefined values rather than stringifying them', () => {
    const spawn = buildHealthProbeSpawn({
      ...base,
      baseEnv: { PATH: '/usr/bin', SOME_UNSET: undefined },
    });
    expect('SOME_UNSET' in spawn.env).toBe(false);
    expect(Object.values(spawn.env).every(v => typeof v === 'string')).toBe(true);
  });
});

/**
 * The probe's cwd is only correct because that directory carries the bunfig
 * that preloads the server-only stub. Asserting the path alone would still pass
 * if someone moved or deleted that config, so pin the pairing itself.
 *
 * The deployed install is a checkout of this repo, so the repo root stands in
 * for `installDir` here.
 */
describe('the probe cwd is a directory bun finds the server-only stub in', () => {
  const REPO_ROOT = resolve(dirname(import.meta.path), '../../../..');

  test('the install root has a bunfig preloading the stub', () => {
    const bunfig = join(REPO_ROOT, 'bunfig.toml');
    expect(existsSync(bunfig)).toBe(true);
    expect(readFileSync(bunfig, 'utf-8')).toContain('stub-server-only');
  });

  test('the entry path the probe runs exists relative to that root', () => {
    expect(existsSync(join(REPO_ROOT, RUNNER_ENTRY))).toBe(true);
  });
});

/**
 * The retry budget could be spent but never refilled.
 *
 * It was reset in exactly one place — the `updateAvailable` false -> true edge.
 * While the runner sits stale that flag is already true, so a *newer* release
 * arriving never re-armed it. Three failed attempts therefore disabled
 * auto-update permanently, until someone restarted the process by hand. Tie the
 * budget to the commit it was spent against instead of to an edge.
 */
describe('hasAutoUpdateBudget', () => {
  test('a fresh target has budget', () => {
    expect(hasAutoUpdateBudget(0, null, 'aaa1111')).toBe(true);
  });

  test('spends down against a single target', () => {
    expect(hasAutoUpdateBudget(AUTO_UPDATE_RETRY_LIMIT - 1, 'aaa1111', 'aaa1111')).toBe(true);
    expect(hasAutoUpdateBudget(AUTO_UPDATE_RETRY_LIMIT, 'aaa1111', 'aaa1111')).toBe(false);
  });

  // The bug: a new release must re-arm the budget even though `updateAvailable`
  // never dipped back to false in between.
  test('a new target commit refills an exhausted budget', () => {
    expect(hasAutoUpdateBudget(AUTO_UPDATE_RETRY_LIMIT, 'aaa1111', 'bbb2222')).toBe(true);
    expect(hasAutoUpdateBudget(AUTO_UPDATE_RETRY_LIMIT * 5, 'aaa1111', 'bbb2222')).toBe(true);
  });

  // Otherwise an unknown target would refill the budget on every tick and the
  // limit would mean nothing.
  test('an unknown target does not refill a budget spent against a known one', () => {
    expect(hasAutoUpdateBudget(AUTO_UPDATE_RETRY_LIMIT, 'aaa1111', null)).toBe(false);
  });

  test('respects an explicit limit', () => {
    expect(hasAutoUpdateBudget(1, 'aaa1111', 'aaa1111', 2)).toBe(true);
    expect(hasAutoUpdateBudget(2, 'aaa1111', 'aaa1111', 2)).toBe(false);
  });
});
