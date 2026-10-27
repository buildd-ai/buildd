/**
 * A runner inside WSL is a second runner, apart from a native Windows runner on
 * the same machine (spec a0b82b5d "Windows runner through WSL2", part 4).
 * WSL2 reports the Windows computer name as its hostname, so the WSL runner
 * takes `<hostname>-wsl` for its headless key (R-22) and its default name
 * (R-23); a native host keeps its hostname, and a configured name still wins.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runnerHostName, headlessRunnerKey, wslIdentityNotice } from '../../src/runner-host';
import { resolveRunnerName, heartbeatRunnerName, runNameCommand } from '../../src/runner-name';

let home: string;
let configFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buildd-wsl-name-'));
  configFile = join(home, 'config.json');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('runnerHostName (R-22)', () => {
  test('a WSL host gets the Windows name with -wsl', () => {
    expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBe('DESKTOP-ABC-wsl');
  });

  test('native hosts keep the hostname', () => {
    for (const platform of ['windows', 'linux', 'darwin', 'linux-container', 'other'] as const) {
      expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform })).toBe('DESKTOP-ABC');
    }
  });

  test('a WSL hostname that already ends in -wsl is not suffixed twice', () => {
    expect(runnerHostName({ hostname: 'desk-WSL', platform: 'linux-wsl' })).toBe('desk-WSL');
  });

  test('the headless key differs between a Windows and a WSL runner on one machine', () => {
    const windows = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'windows' });
    const wsl = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(windows).toBe('headless://DESKTOP-ABC');
    expect(wsl).toBe('headless://DESKTOP-ABC-wsl');
  });
});

describe('the runner name inside WSL (R-23)', () => {
  test('with nothing set, a WSL runner is named <hostname>-wsl', () => {
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' }))
      .toEqual({ name: 'DESKTOP-ABC-wsl', source: 'wsl' });
  });

  test('a native host is unchanged: the hostname, and no name on the heartbeat', () => {
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'windows' }))
      .toEqual({ name: 'DESKTOP-ABC', source: 'hostname' });
    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'windows' })).toBeNull();
  });

  test('the heartbeat carries the -wsl name, so the dashboard shows it apart from the Windows runner', () => {
    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBe('DESKTOP-ABC-wsl');
  });

  test('a name in config wins inside WSL', () => {
    writeFileSync(configFile, JSON.stringify({ name: 'atlas' }));
    expect(resolveRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' }))
      .toEqual({ name: 'atlas', source: 'config' });
  });

  test('BUILDD_RUNNER_NAME wins inside WSL', () => {
    writeFileSync(configFile, JSON.stringify({ name: 'atlas' }));
    expect(resolveRunnerName({ env: { BUILDD_RUNNER_NAME: 'birch' }, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' }))
      .toEqual({ name: 'birch', source: 'env' });
  });

  test('buildd name says where the WSL default comes from', () => {
    const r = runNameCommand([], { env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DESKTOP-ABC-wsl');
    expect(r.stdout).toContain('inside WSL');
    expect(r.stdout).toContain('buildd name <name>');
  });

  test('buildd name --clear inside WSL falls back to the -wsl name', () => {
    writeFileSync(configFile, JSON.stringify({ name: 'atlas' }));
    const r = runNameCommand(['--clear'], { env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(r.stdout).toContain('DESKTOP-ABC-wsl');
  });
});

describe('the one-time identity notice (R-26)', () => {
  test('inside WSL it says once that the key moved, then stays quiet', () => {
    const first = wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(first).not.toBeNull();
    expect(first).toContain('headless://DESKTOP-ABC-wsl');
    expect(first).toContain('headless://DESKTOP-ABC');
    expect(wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBeNull();
  });

  test('never on a native host, and leaves no marker', () => {
    expect(wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'windows' })).toBeNull();
    expect(wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'linux' })).toBeNull();
    expect(existsSync(join(home, '.wsl-identity'))).toBe(false);
  });

  test('a missing or unwritable home never throws', () => {
    expect(() => wslIdentityNotice({ builddHome: join(home, 'missing', 'deeper'), hostname: 'h', platform: 'linux-wsl' })).not.toThrow();
  });
});

// Acceptance criteria (Living Spec a0b82b5d, part 4): one test per check id.
// AC-15 is graded at the dashboard (the runner list rendering two rows),
// which is pre-existing, platform-generic code this mission did not change;
// what the mission adds is the mechanism that makes the two rows distinct
// and correctly labelled, tested here.
describe('acceptance criteria', () => {
  test('AC-15: a Windows and a WSL runner on one machine get distinct heartbeat keys, names and platforms', () => {
    const windowsKey = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'windows' });
    const wslKey = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(windowsKey).not.toBe(wslKey);

    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'windows' })).toBeNull();
    expect(heartbeatRunnerName({ env: {}, configFile, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBe('DESKTOP-ABC-wsl');
    expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBe('DESKTOP-ABC-wsl');
  });

  test('AC-17: a WSL runner installed before this change takes the WSL key on its first start, saying so once; the Windows row is untouched', () => {
    const notice = wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(notice).not.toBeNull();
    expect(notice).toContain(headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' }));
    expect(notice).toContain(headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'windows' }));
    // Said once: a second start inside the same WSL home stays quiet.
    expect(wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBeNull();
    // A native Windows runner on the same machine never gets this notice, so
    // its own row is never touched by a WSL runner starting up.
    expect(wslIdentityNotice({ builddHome: home, hostname: 'DESKTOP-ABC', platform: 'windows' })).toBeNull();
  });
});
