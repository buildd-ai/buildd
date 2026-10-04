/**
 * `buildd service install|uninstall|status|logs` — registers the launcher's
 * own restart-on-update loop (`~/.local/bin/buildd`, see the LAUNCHER heredoc
 * in install.sh) as a per-user background service, so it survives reboots
 * without the user wiring nohup/systemd/launchd themselves.
 *
 * macOS: a launchd LaunchAgent (~/Library/LaunchAgents). Linux: a systemd
 * --user unit (~/.config/systemd/user). Windows is handled entirely inside
 * install.ps1 (a Scheduled Task) since the Windows launcher has no
 * subcommand dispatch to reach this file from — see apps/runner/README.md.
 *
 * Every generator below is pure (string in, string out) so the service file
 * contents are unit-tested directly; nothing here calls launchctl/systemctl
 * for real in a test. The service always runs as the invoking user, never
 * root — the whole point is a per-user service a sandboxed agent account can
 * manage without sudo.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolveBuilddHome } from './buildd-home';

export type ServicePlatform = 'darwin' | 'linux' | 'unsupported';

export function detectServicePlatform(platform: string = process.platform): ServicePlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

export interface ServicePaths {
  /** Operator home directory (os.homedir()) — where LaunchAgents/systemd user dirs and the launcher live. */
  home: string;
  /** The launcher script install.sh writes to ~/.local/bin/buildd. */
  builddBin: string;
  /** Runner home (resolveBuilddHome()) — logs live under here so BUILDD_HOME overrides are respected. */
  logsDir: string;
  stdoutLog: string;
  stderrLog: string;
  /** launchd service label. */
  label: string;
  /** systemd unit name (without the .service suffix). */
  unitName: string;
  /** PATH handed to the service — non-interactive supervisors don't source .bashrc/.zshrc. */
  pathEnv: string;
}

export interface ResolveServicePathsOptions {
  /** Operator home directory. Defaults to os.homedir(). */
  home?: string;
  /** Runner home directory. Defaults to resolveBuilddHome(). */
  builddHome?: string;
}

export function resolveServicePaths(opts: ResolveServicePathsOptions = {}): ServicePaths {
  const home = opts.home ?? homedir();
  const builddHome = opts.builddHome ?? resolveBuilddHome({ home });
  const logsDir = join(builddHome, 'logs');
  return {
    home,
    builddBin: join(home, '.local', 'bin', 'buildd'),
    logsDir,
    stdoutLog: join(logsDir, 'stdout.log'),
    stderrLog: join(logsDir, 'stderr.log'),
    label: 'dev.buildd.runner',
    unitName: 'buildd-runner',
    pathEnv: [
      join(home, '.bun', 'bin'),
      join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
  };
}

export function launchdPlistPath(paths: ServicePaths): string {
  return join(paths.home, 'Library', 'LaunchAgents', `${paths.label}.plist`);
}

export function systemdUnitPath(paths: ServicePaths): string {
  return join(paths.home, '.config', 'systemd', 'user', `${paths.unitName}.service`);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** macOS LaunchAgent plist. KeepAlive + RunAtLoad cover both reboot survival and crash restart. */
export function generateLaunchdPlist(paths: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(paths.label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(paths.builddBin)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>WorkingDirectory</key>
	<string>${escapeXml(paths.home)}</string>
	<key>StandardOutPath</key>
	<string>${escapeXml(paths.stdoutLog)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(paths.stderrLog)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(paths.pathEnv)}</string>
		<key>HOME</key>
		<string>${escapeXml(paths.home)}</string>
	</dict>
</dict>
</plist>
`;
}

/** Linux systemd --user unit. Restart=always covers crash restart; reboot survival needs `loginctl enable-linger`. */
export function generateSystemdUnit(paths: ServicePaths): string {
  return `[Unit]
Description=buildd runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${paths.builddBin}
WorkingDirectory=${paths.home}
Restart=always
RestartSec=5
Environment=PATH=${paths.pathEnv}
Environment=HOME=${paths.home}
StandardOutput=append:${paths.stdoutLog}
StandardError=append:${paths.stderrLog}

[Install]
WantedBy=default.target
`;
}

export function serviceLogsHint(paths: ServicePaths): string {
  return [
    'Service logs:',
    `  stdout: ${paths.stdoutLog}`,
    `  stderr: ${paths.stderrLog}`,
    '',
    'Tail live with:',
    `  tail -f ${paths.stdoutLog} ${paths.stderrLog}`,
  ].join('\n');
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected in tests; the real implementation (`runSync`, below) is the only thing that ever shells out. */
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

export function runSync(cmd: string, args: string[]): CommandResult {
  const proc = Bun.spawnSync([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
  };
}

export interface ServiceActionResult {
  ok: boolean;
  message: string;
}

const UNSUPPORTED_PLATFORM_MESSAGE =
  'buildd service is only supported on macOS and Linux. On Windows, install.ps1 registers a Scheduled Task automatically.';

export function installService(
  paths: ServicePaths,
  platform: ServicePlatform,
  run: CommandRunner = runSync,
): ServiceActionResult {
  if (platform === 'unsupported') return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };

  mkdirSync(paths.logsDir, { recursive: true });

  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(paths);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, generateLaunchdPlist(paths));
    run('launchctl', ['unload', plistPath]); // idempotent: ignore failure if not already loaded
    const load = run('launchctl', ['load', '-w', plistPath]);
    if (load.exitCode !== 0) {
      return { ok: false, message: `launchctl load failed: ${(load.stderr || load.stdout).trim()}` };
    }
    return {
      ok: true,
      message: `Installed launchd service (${plistPath}).\n${serviceLogsHint(paths)}`,
    };
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(paths);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, generateSystemdUnit(paths));
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      return { ok: false, message: `systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}` };
    }
    const enable = run('systemctl', ['--user', 'enable', '--now', `${paths.unitName}.service`]);
    if (enable.exitCode !== 0) {
      return { ok: false, message: `systemctl --user enable failed: ${(enable.stderr || enable.stdout).trim()}` };
    }
    return {
      ok: true,
      message:
        `Installed systemd --user service (${unitPath}).\n${serviceLogsHint(paths)}\n\n` +
        'To keep it running after you log out and across reboots, run:\n' +
        '  loginctl enable-linger $USER',
    };
  }

  return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };
}

export function uninstallService(
  paths: ServicePaths,
  platform: ServicePlatform,
  run: CommandRunner = runSync,
): ServiceActionResult {
  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(paths);
    if (!existsSync(plistPath)) {
      return { ok: true, message: 'No launchd service installed.' };
    }
    run('launchctl', ['unload', '-w', plistPath]);
    rmSync(plistPath, { force: true });
    return { ok: true, message: `Removed launchd service (${plistPath}).` };
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(paths);
    if (!existsSync(unitPath)) {
      return { ok: true, message: 'No systemd service installed.' };
    }
    run('systemctl', ['--user', 'disable', '--now', `${paths.unitName}.service`]);
    rmSync(unitPath, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    return { ok: true, message: `Removed systemd service (${unitPath}).` };
  }

  return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };
}

export function serviceStatus(
  paths: ServicePaths,
  platform: ServicePlatform,
  run: CommandRunner = runSync,
): ServiceActionResult {
  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(paths);
    if (!existsSync(plistPath)) {
      return { ok: false, message: `Not installed (no ${plistPath}). Run \`buildd service install\`.` };
    }
    const result = run('launchctl', ['list', paths.label]);
    if (result.exitCode !== 0) {
      return { ok: false, message: 'Installed but not loaded. Run `buildd service install` to reload it.' };
    }
    return { ok: true, message: `Running.\n${result.stdout.trim()}` };
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(paths);
    if (!existsSync(unitPath)) {
      return { ok: false, message: `Not installed (no ${unitPath}). Run \`buildd service install\`.` };
    }
    const result = run('systemctl', ['--user', 'status', `${paths.unitName}.service`, '--no-pager']);
    const linger = run('loginctl', ['show-user', String(process.env.USER ?? ''), '-p', 'Linger', '--value']);
    const lingerHint =
      linger.exitCode === 0 && linger.stdout.trim() !== 'yes'
        ? '\n\nNote: linger is not enabled — the service will stop when you log out. Run `loginctl enable-linger $USER` to keep it running.'
        : '';
    return { ok: result.exitCode === 0, message: `${result.stdout.trim()}${lingerHint}` };
  }

  return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };
}

const USAGE = 'Usage: buildd service <install|uninstall|status|logs>';

async function main(): Promise<void> {
  const sub = Bun.argv[2];
  const platform = detectServicePlatform();
  const paths = resolveServicePaths();

  switch (sub) {
    case 'install': {
      const result = installService(paths, platform);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    case 'uninstall': {
      const result = uninstallService(paths, platform);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    case 'status': {
      const result = serviceStatus(paths, platform);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
    }
    case 'logs': {
      if (!existsSync(paths.stdoutLog) && !existsSync(paths.stderrLog)) {
        console.log(serviceLogsHint(paths));
        process.exit(0);
      }
      const proc = Bun.spawn(['tail', '-f', paths.stdoutLog, paths.stderrLog], { stdio: ['inherit', 'inherit', 'inherit'] });
      process.exit(await proc.exited);
    }
    default: {
      console.log(USAGE);
      process.exit(sub ? 1 : 0);
    }
  }
}

if (import.meta.main) {
  await main();
}
