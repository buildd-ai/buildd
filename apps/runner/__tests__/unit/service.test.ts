/**
 * Unit tests for `buildd service install|uninstall|status|logs`
 * (apps/runner/src/service.ts). The plist/unit generators are pure and
 * covered directly; the install/uninstall/status actions are exercised
 * against a throwaway temp directory with a fake CommandRunner so no real
 * launchctl/systemctl call is ever made.
 */
import { describe, test, expect, beforeEach, afterEach, skip, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, chmodSync, mkdirSync } from 'fs';
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
  installedServiceDebug,
  parseInstallArgs,
  handleInstallCommand,
  SERVICE_STOP_TIMEOUT_S,
  generateWindowsTaskXml,
  windowsTaskXmlPath,
  type CommandResult,
  type CommandRunner,
} from '../../src/service';
import { SHUTDOWN_DEADLINE_MS } from '../../src/restart-resume';

describe('detectServicePlatform', () => {
  test('darwin', () => expect(detectServicePlatform('darwin')).toBe('darwin'));
  test('linux', () => expect(detectServicePlatform('linux')).toBe('linux'));
  test('win32 is a Scheduled Task', () => expect(detectServicePlatform('win32')).toBe('win32'));
  test('freebsd is unsupported', () => expect(detectServicePlatform('freebsd')).toBe('unsupported'));
});

describe('resolveServicePaths', () => {
  test('derives builddBin, logs dir and labels from the given homes', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });
    expect(paths.builddBin).toBe(join('/home/alice', '.local', 'bin', 'buildd'));
    expect(paths.logsDir).toBe(join('/home/alice/.buildd', 'logs'));
    expect(paths.stdoutLog).toBe(join('/home/alice/.buildd', 'logs', 'stdout.log'));
    expect(paths.stderrLog).toBe(join('/home/alice/.buildd', 'logs', 'stderr.log'));
    expect(paths.label).toBe('dev.buildd.runner');
    expect(paths.unitName).toBe('buildd-runner');
  });

  test('respects a custom BUILDD_HOME independent of the operator home', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/mnt/data/buildd-home', platform: 'linux' });
    expect(paths.logsDir).toBe(join('/mnt/data/buildd-home', 'logs'));
    expect(paths.builddBin).toBe(join('/home/alice', '.local', 'bin', 'buildd'));
  });

  test('pathEnv includes bun and local bin ahead of system paths', () => {
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });
    const entries = paths.pathEnv.split(':');
    expect(entries[0]).toBe(join('/home/alice', '.bun', 'bin'));
    expect(entries[1]).toBe(join('/home/alice', '.local', 'bin'));
    expect(entries).toContain('/usr/bin');
  });
});

describe('launchdPlistPath / systemdUnitPath', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });

  test('plist lives under ~/Library/LaunchAgents', () => {
    expect(launchdPlistPath(paths)).toBe(join('/home/alice', 'Library', 'LaunchAgents', 'dev.buildd.runner.plist'));
  });

  test('unit lives under ~/.config/systemd/user', () => {
    expect(systemdUnitPath(paths)).toBe(join('/home/alice', '.config', 'systemd', 'user', 'buildd-runner.service'));
  });
});

describe('generateLaunchdPlist: the stop window (R-37)', () => {
  test('ExitTimeOut leaves the runner time to pause its agents before launchd kills it', () => {
    const plist = generateLaunchdPlist(resolveServicePaths({ home: '/Users/alice', builddHome: '/Users/alice/.buildd', platform: 'linux' }));
    expect(plist).toMatch(new RegExp(`<key>ExitTimeOut</key>\\s*<integer>${SERVICE_STOP_TIMEOUT_S}</integer>`));
  });

  test('the runner exits on its own inside launchd\'s default ExitTimeOut too (an install from before this setting)', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(20_000);
  });
});

describe('generateLaunchdPlist', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });
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
    const weird = resolveServicePaths({ home: '/home/a&b<c>', builddHome: '/home/a&b<c>/.buildd', platform: 'linux' });
    const out = generateLaunchdPlist(weird);
    expect(out).not.toContain('a&b<c>');
    expect(out).toContain('a&amp;b&lt;c&gt;');
  });

  test('is a pure function: same input always produces the same output', () => {
    expect(generateLaunchdPlist(paths)).toBe(generateLaunchdPlist(paths));
  });
});

describe('generateSystemdUnit', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });
  const unit = generateSystemdUnit(paths);

  test('R-37: a stop signals the launcher only and waits longer than the runner takes to pause its agents', () => {
    // control-group (the default) signals every agent process at once, so each
    // died before the runner could pause it.
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain(`TimeoutStopSec=${SERVICE_STOP_TIMEOUT_S}`);
    expect(SERVICE_STOP_TIMEOUT_S * 1000).toBeGreaterThan(SHUTDOWN_DEADLINE_MS + 5_000);
  });

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
    const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });
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
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
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
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run } = fakeRunner(1);

    const result = installService(paths, 'darwin', run);

    expect(result.ok).toBe(false);
  });

  test('status reports not installed when no plist exists', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run } = fakeRunner(0);

    const result = serviceStatus(paths, 'darwin', run);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Not installed');
  });

  test('status reports running once installed and launchctl list succeeds', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    installService(paths, 'darwin', fakeRunner(0).run);

    const result = serviceStatus(paths, 'darwin', fakeRunner(0).run);

    expect(result.ok).toBe(true);
  });

  test('uninstall removes the plist and calls launchctl unload', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    installService(paths, 'darwin', fakeRunner(0).run);
    const { run, calls } = fakeRunner(0);

    const result = uninstallService(paths, 'darwin', run);

    expect(result.ok).toBe(true);
    expect(existsSync(launchdPlistPath(paths))).toBe(false);
    expect(calls.some((c) => c.cmd === 'launchctl' && c.args[0] === 'unload')).toBe(true);
  });

  test('uninstall is a no-op (not an error) when nothing was installed', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
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
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
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
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run } = fakeRunner(1);

    const result = installService(paths, 'linux', run);

    expect(result.ok).toBe(false);
  });

  test('uninstall removes the unit and calls systemctl --user disable --now', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    installService(paths, 'linux', fakeRunner(0).run);
    const { run, calls } = fakeRunner(0);

    const result = uninstallService(paths, 'linux', run);

    expect(result.ok).toBe(true);
    expect(existsSync(systemdUnitPath(paths))).toBe(false);
    expect(calls.some((c) => c.cmd === 'systemctl' && c.args.includes('disable'))).toBe(true);
  });

  test('status reports not installed when no unit file exists', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
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
      const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
      const { run } = fakeRunner(0);

      expect(installService(paths, 'unsupported', run).ok).toBe(false);
      expect(uninstallService(paths, 'unsupported', run).ok).toBe(false);
      expect(serviceStatus(paths, 'unsupported', run).ok).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── Spec c7410e76 R-14/R-15/AC-5: say how to watch it; --debug turns the web UI on ──

describe('installService: how to watch the runner', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'buildd-service-test-watch-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform}: ends with buildd top, then buildd web`, () => {
      const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
      const result = installService(paths, platform, fakeRunner(0).run);
      expect(result.ok).toBe(true);
      const lines = result.message.trimEnd().split('\n');
      const top = lines.findIndex((l) => l.includes('buildd top'));
      const web = lines.findIndex((l) => l.includes('buildd web'));
      expect(top).toBeGreaterThan(-1);
      expect(web).toBeGreaterThan(top);
      expect(web).toBe(lines.length - 1);
    });
  }

  test('a failed install does not tell anyone to watch it', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    expect(installService(paths, 'darwin', fakeRunner(1).run).message).not.toContain('buildd top');
  });
});

describe('--debug: the service serves the web UI', () => {
  const paths = resolveServicePaths({ home: '/home/alice', builddHome: '/home/alice/.buildd', platform: 'linux' });

  test('off by default: the service runs the launcher with no arguments', () => {
    expect(generateLaunchdPlist(paths)).not.toContain('--debug');
    expect(generateSystemdUnit(paths)).not.toContain('--debug');
  });

  test('launchd passes --debug as its own argument', () => {
    expect(generateLaunchdPlist(paths, { debug: true })).toContain(`<string>${paths.builddBin}</string>\n\t\t<string>--debug</string>`);
  });

  test('systemd runs the launcher with --debug', () => {
    expect(generateSystemdUnit(paths, { debug: true })).toContain(`ExecStart=${paths.builddBin} --debug\n`);
  });

  test('installService writes what it was asked for', () => {
    const home = mkdtempSync(join(tmpdir(), 'buildd-service-test-debug-'));
    try {
      const p = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
      installService(p, 'linux', fakeRunner(0).run, { debug: true });
      expect(readFileSync(systemdUnitPath(p), 'utf-8')).toBe(generateSystemdUnit(p, { debug: true }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Review of PR #4766 (task 4b59eb5b): a reinstall must actually restart a running
// Linux unit, and must keep --debug unless told otherwise.

function scriptedRunner(answers: Record<string, number>): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const hit = Object.keys(answers).find((k) => line.startsWith(k));
    return { exitCode: hit ? answers[hit] : 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('linux reinstall restarts a running unit', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'buildd-service-test-restart-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test('already active: daemon-reload, then restart, so the new ExecStart takes effect', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run, calls } = scriptedRunner({ 'systemctl --user is-active': 0 });
    expect(installService(paths, 'linux', run, { debug: true }).ok).toBe(true);
    const reload = calls.indexOf('systemctl --user daemon-reload');
    const restart = calls.indexOf(`systemctl --user restart ${paths.unitName}.service`);
    expect(reload).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(reload);
  });

  test('not active yet: enable --now starts it, no extra restart', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run, calls } = scriptedRunner({ 'systemctl --user is-active': 3 });
    expect(installService(paths, 'linux', run).ok).toBe(true);
    expect(calls).toContain(`systemctl --user enable --now ${paths.unitName}.service`);
    expect(calls.some((c) => c.startsWith('systemctl --user restart'))).toBe(false);
  });

  test('a failed restart is reported', () => {
    const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
    const { run } = scriptedRunner({ 'systemctl --user is-active': 0, 'systemctl --user restart': 1 });
    const result = installService(paths, 'linux', run);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('restart');
  });
});

describe('--debug is kept across reinstalls', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'buildd-service-test-keep-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  for (const platform of ['darwin', 'linux'] as const) {
    test(`${platform}: reads whether the installed service runs with --debug`, () => {
      const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
      expect(installedServiceDebug(paths, platform)).toBe(false);
      installService(paths, platform, fakeRunner(0).run, { debug: true });
      expect(installedServiceDebug(paths, platform)).toBe(true);
      installService(paths, platform, fakeRunner(0).run, { debug: false });
      expect(installedServiceDebug(paths, platform)).toBe(false);
    });

    // Windows has no write-only mode bit: chmod 0o200 leaves the file readable there.
    test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(`${platform}: returns false if the service file is unreadable`, () => {
      const paths = resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'linux' });
      installService(paths, platform, fakeRunner(0).run, { debug: true });
      const file = platform === 'darwin' ? launchdPlistPath(paths) : systemdUnitPath(paths);
      // Make file unreadable by changing its mode to write-only (fails for root, hence skipIf above)
      chmodSync(file, 0o200);
      const originalWarn = console.warn;
      let warnCalled = false;
      let warnMessage = '';
      console.warn = ((msg: string) => {
        warnCalled = true;
        warnMessage = msg;
      }) as any;
      try {
        expect(installedServiceDebug(paths, platform)).toBe(false);
        expect(warnCalled).toBe(true);
        expect(warnMessage).toContain(file);
      } finally {
        console.warn = originalWarn;
      }
    });
  }

  test('a plain install keeps what is installed; --debug turns it on, --no-debug off', () => {
    expect(parseInstallArgs([], true)).toEqual({ debug: true });
    expect(parseInstallArgs([], false)).toEqual({ debug: false });
    expect(parseInstallArgs(['--debug'], false)).toEqual({ debug: true });
    expect(parseInstallArgs(['--no-debug'], true)).toEqual({ debug: false });
  });

  test('unknown or conflicting arguments are refused', () => {
    expect(parseInstallArgs(['--verbose'], false)).toEqual({ error: 'Unknown argument: --verbose' });
    expect('error' in parseInstallArgs(['--debug', '--no-debug'], false)).toBe(true);
  });

  test('handleInstallCommand wires installedServiceDebug into parseInstallArgs: reinstall without args preserves --debug', () => {
    const testHome = mkdtempSync(join(tmpdir(), 'buildd-service-test-main-wiring-'));
    try {
      for (const platform of ['darwin', 'linux'] as const) {
        const paths = resolveServicePaths({ home: testHome, builddHome: join(testHome, '.buildd'), platform: 'linux' });
        // First install with --debug
        const firstResult = installService(paths, platform, fakeRunner(0).run, { debug: true });
        expect(firstResult.ok).toBe(true);
        // Verify installed with debug
        expect(installedServiceDebug(paths, platform)).toBe(true);
        // Reinstall with no args through handleInstallCommand verifies the wiring
        const handleResult = handleInstallCommand(paths, platform, fakeRunner(0).run, []);
        expect(handleResult.ok).toBe(true);
        // Verify it preserved the debug flag
        expect(installedServiceDebug(paths, platform)).toBe(true);
      }
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

// ── Windows: a per-user Scheduled Task ───────────────────────────────────────

/** A schtasks fake: /Query answers per `state`, everything else exits 0 (or 1 for `failOn`). */
function schtasksRunner(state: 'absent' | 'ready' | 'running', failOn?: string) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (failOn && args.includes(failOn)) return { exitCode: 1, stdout: '', stderr: `ERROR: ${failOn} failed` };
    if (args.includes('/Query')) {
      if (state === 'absent') return { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      return { exitCode: 0, stdout: `TaskName: \\buildd runner\nStatus: ${state === 'running' ? 'Running' : 'Ready'}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: 'SUCCESS', stderr: '' };
  };
  return { run, calls };
}

const WIN_USER = 'PC\\alice';
const winPaths = (home: string, builddHome = `${home}\\.buildd`, windowsUser = WIN_USER) =>
  resolveServicePaths({ home, builddHome, platform: 'win32', windowsUser });

describe('resolveServicePaths (win32)', () => {
  test('runs the cmd launcher install.ps1 writes, as the named user, under the task name install.ps1 used', () => {
    const paths = winPaths('C:\\Users\\alice');
    expect(paths.builddBin.endsWith('buildd.cmd')).toBe(true);
    expect(paths.builddBin).toContain('.local');
    expect(paths.taskName).toBe('buildd runner');
    expect(paths.windowsUser).toBe(WIN_USER);
  });
});

describe('generateWindowsTaskXml', () => {
  const paths = winPaths('C:\\Users\\alice');
  const xml = generateWindowsTaskXml(paths);
  const argsOf = (x: string) => x.match(/<Arguments>([^<]*)<\/Arguments>/)?.[1] ?? '';

  test('starts at logon of this user only, as this user, never elevated', () => {
    expect(xml).toMatch(/<LogonTrigger>[\s\S]*<UserId>PC\\alice<\/UserId>[\s\S]*<\/LogonTrigger>/);
    expect(xml).toMatch(/<Principal id="Author">[\s\S]*<UserId>PC\\alice<\/UserId>[\s\S]*<LogonType>InteractiveToken<\/LogonType>[\s\S]*<RunLevel>LeastPrivilege<\/RunLevel>/);
    expect(xml).not.toContain('HighestAvailable');
  });

  test('restarts on failure, never times out, keeps running on battery, one instance', () => {
    expect(xml).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  test('runs the launcher without a console window and appends to the service logs', () => {
    expect(xml).toContain('<Command>conhost.exe</Command>');
    const args = argsOf(xml);
    expect(args.startsWith('--headless cmd.exe /d /c ')).toBe(true);
    expect(args).toContain(`&quot;${paths.builddBin}&quot;`);
    expect(args).toContain(`&gt;&gt;&quot;${paths.stdoutLog}&quot;`);
    expect(args).toContain(`2&gt;&gt;&quot;${paths.stderrLog}&quot;`);
    expect(args).not.toContain('--debug');
  });

  test('--debug reaches the launcher', () => {
    expect(argsOf(generateWindowsTaskXml(paths, { debug: true }))).toContain(`&quot;${paths.builddBin}&quot; --debug`);
  });

  test('escapes XML-significant characters in the user and paths', () => {
    const out = generateWindowsTaskXml(winPaths('C:\\Users\\a&b', 'C:\\Users\\a&b\\.buildd', 'PC\\a<b>'));
    expect(out).toContain('a&amp;b');
    expect(out).toContain('PC\\a&lt;b&gt;');
    expect(out).not.toMatch(/a&b/);
  });

  test('is a pure function', () => {
    expect(generateWindowsTaskXml(paths)).toBe(xml);
  });
});

describe('installService / uninstallService / serviceStatus (win32)', () => {
  let home: string;
  let paths: ReturnType<typeof resolveServicePaths>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'buildd-service-test-win32-'));
    paths = winPaths(home, join(home, '.buildd'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('install writes the task XML as UTF-16 (what schtasks reads), registers it with /F and starts it', () => {
    const { run, calls } = schtasksRunner('absent');
    const result = installService(paths, 'win32', run);
    expect(result.ok).toBe(true);
    const xmlPath = windowsTaskXmlPath(paths);
    const bytes = readFileSync(xmlPath);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString('utf16le')).toBe(generateWindowsTaskXml(paths));
    const create = calls.find((c) => c.args.includes('/Create'));
    expect(create?.cmd).toBe('schtasks.exe');
    expect(create?.args).toEqual(['/Create', '/TN', 'buildd runner', '/XML', xmlPath, '/F']);
    expect(calls.some((c) => c.args.includes('/Run'))).toBe(true);
    expect(calls.some((c) => c.args.includes('/End'))).toBe(false);
    expect(existsSync(paths.logsDir)).toBe(true);
  });

  test('reinstall ends the running task first, so the new definition takes effect', () => {
    const { run, calls } = schtasksRunner('running');
    expect(installService(paths, 'win32', run).ok).toBe(true);
    const order = calls.map((c) => c.args[0]);
    expect(order.indexOf('/End')).toBeGreaterThan(-1);
    expect(order.indexOf('/End')).toBeLessThan(order.indexOf('/Create'));
    expect(order.indexOf('/Create')).toBeLessThan(order.indexOf('/Run'));
  });

  test('install reports schtasks failure', () => {
    const result = installService(paths, 'win32', schtasksRunner('absent', '/Create').run);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('/Create failed');
  });

  test('reinstall without args keeps --debug; --no-debug turns it off', () => {
    installService(paths, 'win32', schtasksRunner('absent').run, { debug: true });
    expect(installedServiceDebug(paths, 'win32')).toBe(true);
    handleInstallCommand(paths, 'win32', schtasksRunner('running').run, []);
    expect(installedServiceDebug(paths, 'win32')).toBe(true);
    handleInstallCommand(paths, 'win32', schtasksRunner('running').run, ['--no-debug']);
    expect(installedServiceDebug(paths, 'win32')).toBe(false);
  });

  test('status: not installed', () => {
    const result = serviceStatus(paths, 'win32', schtasksRunner('absent').run);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('buildd service install');
  });

  test('status: installed and running', () => {
    const result = serviceStatus(paths, 'win32', schtasksRunner('running').run);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Running');
  });

  test('status: installed but not running is not ok', () => {
    const result = serviceStatus(paths, 'win32', schtasksRunner('ready').run);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Ready');
  });

  test('uninstall ends and deletes the task and removes the XML', () => {
    installService(paths, 'win32', schtasksRunner('absent').run);
    const { run, calls } = schtasksRunner('running');
    expect(uninstallService(paths, 'win32', run).ok).toBe(true);
    expect(calls.some((c) => c.args.includes('/End'))).toBe(true);
    expect(calls.find((c) => c.args.includes('/Delete'))?.args).toEqual(['/Delete', '/TN', 'buildd runner', '/F']);
    expect(existsSync(windowsTaskXmlPath(paths))).toBe(false);
  });

  test('uninstall is a no-op when nothing was installed', () => {
    const { run, calls } = schtasksRunner('absent');
    expect(uninstallService(paths, 'win32', run).ok).toBe(true);
    expect(calls.some((c) => c.args.includes('/Delete'))).toBe(false);
  });
});

describe('serviceLogsHint (win32)', () => {
  test('names a PowerShell tail, not tail -f', () => {
    const hint = serviceLogsHint(winPaths('C:\\Users\\alice'));
    expect(hint).toContain('Get-Content');
    expect(hint).toContain('-Wait');
    expect(hint).not.toContain('tail -f');
  });
});
