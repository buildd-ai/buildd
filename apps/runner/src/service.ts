/**
 * `buildd service install|uninstall|status|logs` — registers the launcher's
 * own restart-on-update loop (`~/.local/bin/buildd`, see the LAUNCHER heredoc
 * in install.sh) as a per-user background service, so it survives reboots
 * without the user wiring nohup/systemd/launchd themselves.
 *
 * macOS: a launchd LaunchAgent (~/Library/LaunchAgents). Linux: a systemd
 * --user unit (~/.config/systemd/user). Windows: a per-user Scheduled Task
 * (`buildd runner`, at logon, as the user, never elevated) registered from a
 * task XML with schtasks.exe; the cmd launcher (buildd.cmd, written by
 * install.ps1) dispatches `buildd service` here as the bash launcher does.
 *
 * Every generator below is pure (string in, string out) so the service file
 * contents are unit-tested directly; nothing here calls launchctl/systemctl
 * for real in a test. The service always runs as the invoking user, never
 * root — the whole point is a per-user service a sandboxed agent account can
 * manage without sudo.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { resolveBuilddHome } from './buildd-home';

export type ServicePlatform = 'darwin' | 'linux' | 'win32' | 'unsupported';

export function detectServicePlatform(platform: string = process.platform): ServicePlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'win32';
  return 'unsupported';
}

export interface ServicePaths {
  /** Operator home directory (os.homedir()) — where LaunchAgents/systemd user dirs and the launcher live. */
  home: string;
  /** The launcher install.sh writes to ~/.local/bin/buildd (install.ps1: buildd.cmd beside it). */
  builddBin: string;
  /** Runner home (resolveBuilddHome()) — logs live under here so BUILDD_HOME overrides are respected. */
  logsDir: string;
  stdoutLog: string;
  stderrLog: string;
  /** launchd service label. */
  label: string;
  /** systemd unit name (without the .service suffix). */
  unitName: string;
  /** Windows Scheduled Task name; the one install.ps1 registered before this file handled Windows. */
  taskName: string;
  /** Windows account the task runs as and starts at the logon of (DOMAIN\user). */
  windowsUser: string;
  /** PATH handed to the service — non-interactive supervisors don't source .bashrc/.zshrc. */
  pathEnv: string;
}

export interface ResolveServicePathsOptions {
  /** Operator home directory. Defaults to os.homedir(). */
  home?: string;
  /** Runner home directory. Defaults to resolveBuilddHome(). */
  builddHome?: string;
  /** Defaults to process.platform; decides the launcher's file name. */
  platform?: string;
  /** Defaults to %USERDOMAIN%\%USERNAME%. */
  windowsUser?: string;
}

export function resolveServicePaths(opts: ResolveServicePathsOptions = {}): ServicePaths {
  const home = opts.home ?? homedir();
  const builddHome = opts.builddHome ?? resolveBuilddHome({ home });
  const logsDir = join(builddHome, 'logs');
  const platform = opts.platform ?? process.platform;
  const user = process.env.USERNAME ?? '';
  const domain = process.env.USERDOMAIN;
  return {
    home,
    builddBin: join(home, '.local', 'bin', platform === 'win32' ? 'buildd.cmd' : 'buildd'),
    logsDir,
    stdoutLog: join(logsDir, 'stdout.log'),
    stderrLog: join(logsDir, 'stderr.log'),
    label: 'dev.buildd.runner',
    unitName: 'buildd-runner',
    taskName: 'buildd runner',
    windowsUser: opts.windowsUser ?? (domain ? `${domain}\\${user}` : user),
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

/** The task XML `buildd service install` registers, kept so a reinstall can read whether it ran with --debug. */
export function windowsTaskXmlPath(paths: ServicePaths): string {
  return join(dirname(paths.logsDir), 'service', `${paths.unitName}.xml`);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** How the service runs the launcher. `debug` passes --debug, so it serves the local web UI (`buildd web`). */
export interface ServiceRunOptions {
  debug?: boolean;
}

/**
 * How long the service manager waits after its stop signal before it kills
 * the runner (launchd ExitTimeOut, systemd TimeoutStopSec). The runner pauses
 * its running agents in that window and exits on its own well inside it
 * (restart-resume.ts SHUTDOWN_DEADLINE_MS); this is the margin above that.
 */
export const SERVICE_STOP_TIMEOUT_S = 30;

/** macOS LaunchAgent plist. KeepAlive + RunAtLoad cover both reboot survival and crash restart. */
export function generateLaunchdPlist(paths: ServicePaths, opts: ServiceRunOptions = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${escapeXml(paths.label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(paths.builddBin)}</string>${opts.debug ? '\n\t\t<string>--debug</string>' : ''}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>ExitTimeOut</key>
	<integer>${SERVICE_STOP_TIMEOUT_S}</integer>
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
export function generateSystemdUnit(paths: ServicePaths, opts: ServiceRunOptions = {}): string {
  return `[Unit]
Description=buildd runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${paths.builddBin}${opts.debug ? ' --debug' : ''}
WorkingDirectory=${paths.home}
Restart=always
RestartSec=5
# The stop signal goes to the launcher (the main process) only, which hands it
# to the runner; the runner pauses its agents and exits, and the launcher exits
# with it. Once the main process has exited, systemd SIGKILLs whatever is left
# in the unit (and everything at TimeoutStopSec if it has not). The default,
# control-group, signals every agent process at once, so each died before the
# runner could pause it.
KillMode=mixed
TimeoutStopSec=${SERVICE_STOP_TIMEOUT_S}
Environment=PATH=${paths.pathEnv}
Environment=HOME=${paths.home}
StandardOutput=append:${paths.stdoutLog}
StandardError=append:${paths.stderrLog}

[Install]
WantedBy=default.target
`;
}

/**
 * Windows Scheduled Task definition (Task Scheduler schema 1.2). Starts at
 * this user's logon and runs as them with a limited token, never elevated;
 * restarts on failure, no 72h execution limit, not stopped on battery.
 *
 * Runs `conhost --headless cmd /c` so no console window opens and cmd can
 * append the launcher's output to the service logs (Task Scheduler has no
 * stdout redirection of its own). The outer quotes are cmd's: /c strips the
 * first and last quote of a line that holds more than two.
 *
 * Stopping: schtasks /End terminates the process tree outright, so on Windows
 * the runner gets no SERVICE_STOP_TIMEOUT_S window to pause its agents.
 */
export function generateWindowsTaskXml(paths: ServicePaths, opts: ServiceRunOptions = {}): string {
  const line = `""${paths.builddBin}"${opts.debug ? ' --debug' : ''} >>"${paths.stdoutLog}" 2>>"${paths.stderrLog}""`;
  const user = escapeXml(paths.windowsUser);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>buildd runner (buildd service install)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless cmd.exe /d /c ${escapeXml(line).replace(/"/g, '&quot;')}</Arguments>
      <WorkingDirectory>${escapeXml(paths.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function serviceLogsHint(paths: ServicePaths): string {
  if (paths.builddBin.endsWith('.cmd')) {
    return [
      'Service logs:',
      `  stdout: ${paths.stdoutLog}`,
      `  stderr: ${paths.stderrLog}`,
      '',
      'Tail live with (PowerShell):',
      `  Get-Content -Wait -Tail 50 "${paths.stdoutLog}", "${paths.stderrLog}"`,
    ].join('\n');
  }
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

/** Printed last after a successful install: the two ways to look at the runner, in that order. */
export const SERVICE_WATCH_HINT = [
  'Watch it:                buildd top',
  'Open it in your browser: buildd web',
].join('\n');

function withWatchHint(message: string, opts: { watchHint?: boolean }): string {
  return opts.watchHint === false ? message : `${message}\n\n${SERVICE_WATCH_HINT}`;
}

const UNSUPPORTED_PLATFORM_MESSAGE = 'buildd service is supported on macOS, Linux and Windows only.';

const SCHTASKS = 'schtasks.exe';

function failure(r: CommandResult): string {
  return (r.stderr || r.stdout).trim();
}

/** The task's `Status:` from schtasks /Query, or null when it is not registered. */
function windowsTaskStatus(paths: ServicePaths, run: CommandRunner): { status: string; detail: string } | null {
  const q = run(SCHTASKS, ['/Query', '/TN', paths.taskName, '/FO', 'LIST']);
  if (q.exitCode !== 0) return null;
  return { status: q.stdout.match(/^Status:\s*(.+?)\s*$/m)?.[1] ?? 'unknown', detail: q.stdout.trim() };
}

export function installService(
  paths: ServicePaths,
  platform: ServicePlatform,
  run: CommandRunner = runSync,
  opts: ServiceRunOptions & { watchHint?: boolean } = {},
): ServiceActionResult {
  if (platform === 'unsupported') return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };

  mkdirSync(paths.logsDir, { recursive: true });

  if (platform === 'darwin') {
    const plistPath = launchdPlistPath(paths);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, generateLaunchdPlist(paths, opts));
    run('launchctl', ['unload', plistPath]); // idempotent: ignore failure if not already loaded
    const load = run('launchctl', ['load', '-w', plistPath]);
    if (load.exitCode !== 0) {
      return { ok: false, message: `launchctl load failed: ${(load.stderr || load.stdout).trim()}` };
    }
    return {
      ok: true,
      message: withWatchHint(`Installed launchd service (${plistPath}).\n${serviceLogsHint(paths)}`, opts),
    };
  }

  if (platform === 'win32') {
    const xmlPath = windowsTaskXmlPath(paths);
    mkdirSync(dirname(xmlPath), { recursive: true });
    // The declaration says UTF-16, which is what schtasks reads; BOM first.
    writeFileSync(xmlPath, Buffer.from(`﻿${generateWindowsTaskXml(paths, opts)}`, 'utf16le'));
    // Re-registering leaves a running instance alone, so end it first or a
    // reinstall (e.g. to add --debug) keeps the old process.
    if (windowsTaskStatus(paths, run)?.status === 'Running') run(SCHTASKS, ['/End', '/TN', paths.taskName]);
    const create = run(SCHTASKS, ['/Create', '/TN', paths.taskName, '/XML', xmlPath, '/F']);
    if (create.exitCode !== 0) return { ok: false, message: `schtasks /Create failed: ${failure(create)}` };
    const start = run(SCHTASKS, ['/Run', '/TN', paths.taskName]);
    if (start.exitCode !== 0) return { ok: false, message: `schtasks /Run failed: ${failure(start)}` };
    return {
      ok: true,
      message: withWatchHint(
        `Installed Scheduled Task '${paths.taskName}' (starts at logon as ${paths.windowsUser}, restarts on failure).\n${serviceLogsHint(paths)}`,
        opts,
      ),
    };
  }

  if (platform === 'linux') {
    const unitPath = systemdUnitPath(paths);
    mkdirSync(dirname(unitPath), { recursive: true });
    // `enable --now` does not restart a unit that is already running, so a
    // reinstall (e.g. to add --debug) would leave the old process in place.
    const wasActive = run('systemctl', ['--user', 'is-active', '--quiet', `${paths.unitName}.service`]).exitCode === 0;
    writeFileSync(unitPath, generateSystemdUnit(paths, opts));
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      return { ok: false, message: `systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}` };
    }
    const enable = run('systemctl', ['--user', 'enable', '--now', `${paths.unitName}.service`]);
    if (enable.exitCode !== 0) {
      return { ok: false, message: `systemctl --user enable failed: ${(enable.stderr || enable.stdout).trim()}` };
    }
    if (wasActive) {
      const restart = run('systemctl', ['--user', 'restart', `${paths.unitName}.service`]);
      if (restart.exitCode !== 0) {
        return { ok: false, message: `systemctl --user restart failed: ${(restart.stderr || restart.stdout).trim()}` };
      }
    }
    return {
      ok: true,
      message: withWatchHint(
        `Installed systemd --user service (${unitPath}).\n${serviceLogsHint(paths)}\n\n` +
        'To keep it running after you log out and across reboots, run:\n' +
        '  loginctl enable-linger $USER',
        opts,
      ),
    };
  }

  return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };
}

/** Whether the installed service runs with --debug, so a plain reinstall keeps it. False when none is installed. */
export function installedServiceDebug(paths: ServicePaths, platform: ServicePlatform): boolean {
  const file = platform === 'darwin' ? launchdPlistPath(paths)
    : platform === 'linux' ? systemdUnitPath(paths)
    : platform === 'win32' ? windowsTaskXmlPath(paths)
    : null;
  if (!file || !existsSync(file)) return false;
  try {
    if (platform === 'win32') {
      return /<Arguments>[^<]*&quot; --debug /.test(readFileSync(file).toString('utf16le'));
    }
    const text = readFileSync(file, 'utf-8');
    return platform === 'darwin'
      ? text.includes('<string>--debug</string>')
      : /^ExecStart=.* --debug$/m.test(text);
  } catch {
    console.warn(`Failed to read service file ${file}`);
    return false;
  }
}

/** Handles the `buildd service install` subcommand: preserves --debug flag if not specified. For testing. */
export function handleInstallCommand(paths: ServicePaths, platform: ServicePlatform, runner: CommandRunner, args: string[]): CommandResult {
  const parsed = parseInstallArgs(args, installedServiceDebug(paths, platform));
  if ('error' in parsed) return { ok: false, message: `${parsed.error}\n${USAGE}` };
  return installService(paths, platform, runner, {
    debug: parsed.debug,
    watchHint: process.env.BUILDD_INSTALLER !== '1',
  });
}

/** `buildd service install [--debug|--no-debug]`: with neither, keep what the installed service does. */
export function parseInstallArgs(args: string[], installedDebug: boolean): { debug: boolean } | { error: string } {
  const unknown = args.find((a) => a !== '--debug' && a !== '--no-debug');
  if (unknown) return { error: `Unknown argument: ${unknown}` };
  const on = args.includes('--debug');
  const off = args.includes('--no-debug');
  if (on && off) return { error: 'Pass --debug or --no-debug, not both' };
  return { debug: on ? true : off ? false : installedDebug };
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

  if (platform === 'win32') {
    if (!windowsTaskStatus(paths, run)) {
      rmSync(windowsTaskXmlPath(paths), { force: true });
      return { ok: true, message: 'No Scheduled Task installed.' };
    }
    run(SCHTASKS, ['/End', '/TN', paths.taskName]);
    const del = run(SCHTASKS, ['/Delete', '/TN', paths.taskName, '/F']);
    if (del.exitCode !== 0) return { ok: false, message: `schtasks /Delete failed: ${failure(del)}` };
    rmSync(windowsTaskXmlPath(paths), { force: true });
    return { ok: true, message: `Removed Scheduled Task '${paths.taskName}'.` };
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

  if (platform === 'win32') {
    const task = windowsTaskStatus(paths, run);
    if (!task) return { ok: false, message: `Not installed (no Scheduled Task '${paths.taskName}'). Run \`buildd service install\`.` };
    if (task.status !== 'Running') {
      return { ok: false, message: `Installed but ${task.status}, not running. Run \`buildd service install\` to start it.\n${task.detail}` };
    }
    return { ok: true, message: `Running.\n${task.detail}` };
  }

  return { ok: false, message: UNSUPPORTED_PLATFORM_MESSAGE };
}

const USAGE = [
  'Usage: buildd service <install|uninstall|status|logs>',
  '  buildd service install --debug     also serve the local web UI (buildd web); kept on reinstall',
  '  buildd service install --no-debug  turn the web UI off again',
].join('\n');

async function main(): Promise<void> {
  const sub = Bun.argv[2];
  const platform = detectServicePlatform();
  const paths = resolveServicePaths();

  switch (sub) {
    case 'install': {
      const result = handleInstallCommand(paths, platform, runSync, Bun.argv.slice(3));
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
      const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;
      const tail = platform === 'win32'
        ? ['powershell.exe', '-NoProfile', '-Command', `Get-Content -Wait -Tail 50 ${quote(paths.stdoutLog)}, ${quote(paths.stderrLog)}`]
        : ['tail', '-f', paths.stdoutLog, paths.stderrLog];
      const proc = Bun.spawn(tail, { stdio: ['inherit', 'inherit', 'inherit'] });
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
