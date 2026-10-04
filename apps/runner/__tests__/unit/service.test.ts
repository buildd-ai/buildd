/**
 * Unit tests for `buildd service install|uninstall|status|logs`
 * (apps/runner/src/service.ts). The plist/unit generators are pure and
 * covered directly; the install/uninstall/status actions are exercised
 * against a throwaway temp directory with a fake CommandRunner so no real
 * launchctl/systemctl call is ever made.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectServicePlatform,
  resolveServicePaths,
  launchdPlistPath,
  systemdUnitPath,
  generateLaunchdPlist,
  generateSystemdUnit,
  serviceLogsHint,
  installService,
  uninstallService,
  serviceStatus,
  type CommandResult,
  type CommandRunner,
} from '../../src/service';

describe('detectServicePlatform', () => {
  test('darwin', () => expect(detectServicePlatform('darwin')).toBe('darwin'));
  test('linux', () => expect(detectServicePlatform('linux')).toBe('linux'));
  test('win32 is unsupported', () => expect(detectServicePlatform('win32')).toBe('unsupported'));
  test('freebsd is unsupported', () => expect(detectServicePlatform('freebsd')).toBe('unsupported'));
});

describe('resolveServicePaths', () => {
  test('derives builddBin, logs dir and labels from the given homes', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });
    expect(paths.builddBin).toBe(join('/home/alice', '.local', 'bin', 'buildd'));
    expect(paths.logsDir).toBe(join('/home/alice/.buildd', 'logs'));
    expect(paths.stdoutLog).toBe(join('/home/alice/.buildd', 'logs', 'stdout.log'));
    expect(paths.stderrLog).toBe(join('/home/alice/.buildd', 'logs', 'stderr.log'));
    expect(paths.label).toBe('dev.buildd.runner');
    expect(paths.unitName).toBe('buildd-runner');
  });

  test('respects a custom BUILDD_HOME independent of the operator home', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/mnt/data/buildd-home' });
    expect(paths.logsDir).toBe(join('/mnt/data/buildd-home', 'logs'));
    expect(paths.builddBin).toBe(join('/home/alice', '.local', 'bin', 'buildd'));
  });

  test('pathEnv includes bun and local bin ahead of system paths', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });
    const entries = paths.pathEnv.split(':');
    expect(entries[0]).toBe(join('/home/alice', '.bun', 'bin'));
    expect(entries[1]).toBe(join('/home/alice', '.local', 'bin'));
    expect(entries).toContain('/usr/bin');
  });
});

describe('launchdPlistPath / systemdUnitPath', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });

  test('plist lives under ~/Library/LaunchAgents', () => {
    expect(launchdPlistPath(paths)).toBe('/home/alice/Library/LaunchAgents/dev.buildd.runner.plist');
  });

  test('unit lives under ~/.config/systemd/user', () => {
    expect(systemdUnitPath(paths)).toBe('/home/alice/.config/systemd/user/buildd-runner.service');
  });
});

describe('generateLaunchdPlist', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });
  const plist = generateLaunchdPlist(paths);

  test('is well-formed XML with a plist root', () => {
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('</plist>');
  });

  test('runs the launcher binary, not a bare bun command', () => {
    expect(plist).toContain(`<string>${paths.builddBin}</string>`);
  });

  test('sets RunAtLoad and KeepAlive so it survives both reboot and crash', () => {
    const runAtLoadIdx = plist.indexOf('<key>RunAtLoad</key>');
    const keepAliveIdx = plist.indexOf('<key>KeepAlive</key>');
    expect(runAtLoadIdx).toBeGreaterThan(-1);
    expect(keepAliveIdx).toBeGreaterThan(-1);
    expect(plist.slice(runAtLoadIdx, runAtLoadIdx + 60)).toContain('<true/>');
    expect(plist.slice(keepAliveIdx, keepAliveIdx + 60)).toContain('<true/>');
  });

  test('logs stdout/stderr under the runner home logs dir', () => {
    expect(plist).toContain(`<string>${paths.stdoutLog}</string>`);
    expect(plist).toContain(`<string>${paths.stderrLog}</string>`);
  });

  test('carries a PATH so bun resolves in a non-interactive launch', () => {
    expect(plist).toContain(`<string>${paths.pathEnv}</string>`);
  });

  test('escapes XML-significant characters in paths', () => {
    const weird = resolveServicePaths({ home: '/home/a&b<c>', builddHome: '/home/a&b<c>/.buildd' });
    const out = generateLaunchdPlist(weird);
    expect(out).not.toContain('a&b<c>');
    expect(out).toContain('a&amp;b&lt;c&gt;');
  });

  test('is a pure function: same input always produces the same output', () => {
    expect(generateLaunchdPlist(paths)).toBe(generateLaunchdPlist(paths));
  });
});

describe('generateSystemdUnit', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });
  const unit = generateSystemdUnit(paths);

  test('runs the launcher binary as ExecStart', () => {
    expect(unit).toContain(`ExecStart=${paths.builddBin}`);
  });

  test('restarts on crash', () => {
    expect(unit).toContain('Restart=always');
  });

  test('starts at login/boot via the default user target', () => {
    expect(unit).toContain('WantedBy=default.target');
  });

  test('logs stdout/stderr to the runner home logs dir', () => {
    expect(unit).toContain(`StandardOutput=append:${paths.stdoutLog}`);
    expect(unit).toContain(`StandardError=append:${paths.stderrLog}`);
  });

  test('carries a PATH so bun resolves in a non-interactive launch', () => {
    expect(unit).toContain(`Environment=PATH=${paths.pathEnv}`);
  });

  test('is a pure function: same input always produces the same output', () => {
    expect(generateSystemdUnit(paths)).toBe(generateSystemdUnit(paths));
  });
});

describe('serviceLogsHint', () => {
  test('names both log files and a tail command', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd' });
    const hint = serviceLogsHint(paths);
    expect(hint).toContain(paths.stdoutLog);
    expect(hint).toContain(paths.stderrLog);
    expect(hint).toContain('tail -f');
  });
});

// ── install/uninstall/status: real fs under a throwaway temp dir, fake CommandRunner ──
// Never calls a real launchctl/systemctl — `run` below just records invocations.

function fakeRunner(exitCode = 0): { run: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    const result: CommandResult = { exitCode, stdout: '', stderr: '' };
    return result;
  };
  return { run, calls };
}

describe('installService / uninstallService / serviceStatus (darwin)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'buildd-service-test-darwin-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('install writes the plist and calls launchctl load', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run, calls } = fakeRunner(0);

    const result = installService(paths, 'darwin', run);

    expect(result.ok).toBe(true);
    const plistPath = launchdPlistPath(paths);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, 'utf-8')).toBe(generateLaunchdPlist(paths));
    expect(calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'load')).toBe(true);
    expect(existsSync(paths.logsDir)).toBe(true);
  });

  test('install reports failure when launchctl load fails', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run } = fakeRunner(1);

    const result = installService(paths, 'darwin', run);

    expect(result.ok).toBe(false);
  });

  test('status reports not installed when no plist exists', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run } = fakeRunner(0);

    const result = serviceStatus(paths, 'darwin', run);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Not installed');
  });

  test('status reports running once installed and launchctl list succeeds', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    installService(paths, 'darwin', fakeRunner(0).run);

    const result = serviceStatus(paths, 'darwin', fakeRunner(0).run);

    expect(result.ok).toBe(true);
  });

  test('uninstall removes the plist and calls launchctl unload', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    installService(paths, 'darwin', fakeRunner(0).run);
    const { run, calls } = fakeRunner(0);

    const result = uninstallService(paths, 'darwin', run);

    expect(result.ok).toBe(true);
    expect(existsSync(launchdPlistPath(paths))).toBe(false);
    expect(calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'unload')).toBe(true);
  });

  test('uninstall is a no-op (not an error) when nothing was installed', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run } = fakeRunner(0);

    const result = uninstallService(paths, 'darwin', run);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('No launchd service installed');
  });
});

describe('installService / uninstallService / serviceStatus (linux)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'buildd-service-test-linux-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('install writes the unit and calls systemctl --user enable --now', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run, calls } = fakeRunner(0);

    const result = installService(paths, 'linux', run);

    expect(result.ok).toBe(true);
    const unitPath = systemdUnitPath(paths);
    expect(existsSync(unitPath)).toBe(true);
    expect(readFileSync(unitPath, 'utf-8')).toBe(generateSystemdUnit(paths));
    expect(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('enable'))).toBe(true);
    expect(result.message).toContain('loginctl enable-linger');
  });

  test('install reports failure when systemctl enable fails', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run } = fakeRunner(1);

    const result = installService(paths, 'linux', run);

    expect(result.ok).toBe(false);
  });

  test('uninstall removes the unit and calls systemctl --user disable --now', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    installService(paths, 'linux', fakeRunner(0).run);
    const { run, calls } = fakeRunner(0);

    const result = uninstallService(paths, 'linux', run);

    expect(result.ok).toBe(true);
    expect(existsSync(systemdUnitPath(paths))).toBe(false);
    expect(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('disable'))).toBe(true);
  });

  test('status reports not installed when no unit file exists', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
    const { run } = fakeRunner(0);

    const result = serviceStatus(paths, 'linux', run);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Not installed');
  });
});

describe('unsupported platform', () => {
  test('install/uninstall/status all refuse cleanly', () => {
    const home = mkdtempSync(join(tmpdir(), 'buildd-service-test-unsupported-'));
    try {
      const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd') });
      const { run } = fakeRunner(0);

      expect(installService(paths, 'unsupported', run).ok).toBe(false);
      expect(uninstallService(paths, 'unsupported', run).ok).toBe(false);
      expect(serviceStatus(paths, 'unsupported', run).ok).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
