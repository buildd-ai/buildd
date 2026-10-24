/**
 * `buildd wsl migrate [--distro <name>] [--undo]`, run from PowerShell: hand
 * work over from the native Windows runner to the runner inside a WSL2
 * distribution, and keep that distribution running across reboots.
 * Living Spec "Windows runner through WSL2: one guided setup" (a0b82b5d),
 * part 3, R-14..R-21.
 *
 * Steps, each safe to rerun (a step already done is reported, not repeated):
 *
 *   1. Check, changing nothing (R-14): the WSL runner is installed, logged in
 *      and passes `--verify-wsl` now; systemd runs in the distribution (R-17);
 *      no foreground runner inside WSL would sit beside the service (R-19).
 *      Linger is asked for here, before anything else changes, so a no leaves
 *      the machine as it was.
 *   2. Hold the Windows runner (`buildd hold`) and wait for its active work
 *      to finish. Nothing is stopped, paused or aborted (R-15).
 *   3. Install the WSL user service and check it runs (R-17).
 *   4. Register and start the `buildd wsl` logon task: it starts the
 *      distribution at logon and keeps it running with a long-lived process,
 *      since WSL starts no distribution on its own and stops an idle one (R-18).
 *   5. Check again that nothing runs on the Windows runner, then remove its
 *      Scheduled Task and wait for a foreground Windows runner to close (R-16).
 *
 * 3 and 4 come before 5 so a failure part-way leaves the Windows runner on
 * hold with its Scheduled Task in place, never removed with no WSL service
 * running (R-20). The logon task never runs a runner, so it and the Windows
 * Scheduled Task are never two supervisors of one runner (R-19).
 *
 * Every Linux step is a fixed script; the distribution name is only ever an
 * argument to wsl.exe, never part of a shell command (as wsl-setup.ts).
 */
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseDistributions } from './wsl-setup';
import { resolveServicePaths, scheduledTaskStatus, uninstallService, windowsTaskStatus, type CommandResult, type CommandRunner, type ServicePaths } from './service';
import { headlessRunnerKey } from './runner-host';

/** One task per distribution: migrating a second distribution must not reuse or overwrite the first one's. */
export const logonTaskName = (distro: string) => `buildd WSL (${distro})`;
/** The single fixed name earlier versions registered for whichever distribution was migrated. */
export const LEGACY_LOGON_TASK_NAME = 'buildd wsl';
const SCHTASKS = 'schtasks.exe';
const MARKER = 'BUILDD_WSL_MIGRATE=';
/** A distribution name we pass as one argument without quoting worries. */
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SYSTEMD_DOCS = 'https://learn.microsoft.com/windows/wsl/systemd';

const LINUX_PATH = 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; B="$HOME/.buildd";';

/** Read-only: what migrate needs to know about the WSL side, as one marker line. */
export const WSL_MIGRATE_PREFLIGHT = [
  LINUX_PATH,
  `if [ ! -f "$B/apps/runner/src/isolation-check.ts" ] || ! command -v buildd >/dev/null 2>&1; then echo ${MARKER}no-runner; exit 0; fi;`,
  `grep -q '"apiKey"' "$B/config.json" 2>/dev/null || { echo ${MARKER}no-login; exit 0; };`,
  'if [ -d /run/systemd/system ] && systemctl --user show-environment >/dev/null 2>&1; then S=yes; else S=no; fi;',
  'if [ "$S" = yes ] && systemctl --user is-active --quiet buildd-runner.service; then A=yes; else A=no; fi;',
  'L=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null); [ "$L" = yes ] || L=no;',
  "F=no; if [ \"$A\" = no ] && pgrep -f 'apps/runner/src/index.ts' >/dev/null 2>&1; then F=yes; fi;",
  'if bun "$B/apps/runner/src/isolation-check.ts" --verify-wsl >/dev/null 2>&1; then V=pass; else V=fail; fi;',
  `echo "${MARKER}ok systemd=$S service=$A linger=$L foreground=$F verify=$V"`,
].join(' ');

export const WSL_SERVICE_INSTALL = `${LINUX_PATH} buildd service install`;

/** The service is active and its runner answers on its socket. */
export const WSL_SERVICE_CHECK = `${LINUX_PATH} systemctl --user is-active --quiet buildd-runner.service && test -S "$B/runner.sock" && echo ${MARKER}running`;

const WSL_LINGER = 'sudo loginctl enable-linger "$(id -un)"';

export interface MigrateArgs { undo: boolean; distro?: string }

export function parseMigrateArgs(args: string[]): MigrateArgs | null {
  const out: MigrateArgs = { undo: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--undo') out.undo = true;
    else if (args[i] === '--distro' && args[i + 1] && !args[i + 1].startsWith('-')) out.distro = args[++i];
    else return null;
  }
  return out;
}

export const MIGRATE_USAGE = 'Usage: buildd wsl migrate [--distro <name>] [--undo]';

export interface MigrateDeps {
  platform: string;
  paths: ServicePaths;
  run: CommandRunner;
  /** Runs with this terminal attached (sudo asks for a password); returns the exit code. */
  runInteractive: (file: string, args: string[]) => number;
  log: (line: string) => void;
  /** Ask yes/no; null when there is no terminal to ask on. */
  confirm: ((question: string) => Promise<boolean>) | null;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  windows: {
    /** A Windows runner answers on its socket. */
    live: () => Promise<boolean>;
    /** `buildd hold` on the Windows runner (saved for its next start when none runs). */
    hold: () => Promise<{ ok: boolean; message: string }>;
    /** What the Windows runner is running now; [] when no runner answers. */
    activeWork: () => Promise<{ title: string; status: string }[] | { error: string }>;
    /** Pending tasks pinned to the Windows runner; [] when lookup fails or none pinned. */
    pendingPinned: () => Promise<{ title: string }[]>;
  };
}

const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** How often the task re-checks that the distribution is up; a no-op while it is (IgnoreNew). */
export const LOGON_TASK_REPEAT = 'PT5M';

/**
 * The per-distribution task: at logon and every few minutes after, as the user, unelevated, start the
 * distribution and keep it running. The long-lived `wsl.exe` ends when WSL stops; the failure restart and the
 * repeating trigger then start it again, while a running instance makes each repeat a no-op. It runs no runner.
 */
export function generateLogonTaskXml(distro: string, windowsUser: string): string {
  const user = xml(windowsUser);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the WSL distribution with the buildd runner running (buildd wsl migrate). It runs no runner itself.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>${LOGON_TASK_REPEAT}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
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
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wsl.exe</Command>
      <Arguments>${xml(`--distribution "${distro}" --exec sleep infinity`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function logonTaskXmlPath(paths: ServicePaths, distro: string): string {
  return join(dirname(paths.logsDir), 'service', `buildd-wsl-${distro}.xml`);
}

const failure = (r: CommandResult) => (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`;

function logonTaskStatus(name: string, run: CommandRunner): string | null {
  return scheduledTaskStatus(name, run)?.status ?? null;
}

/** The distribution a registered logon task starts, read from its definition; null when unreadable. */
function logonTaskTarget(name: string, run: CommandRunner): string | null {
  const q = run(SCHTASKS, ['/Query', '/TN', name, '/XML']);
  if (q.exitCode !== 0) return null;
  const text = q.stdout.replace(/\0/g, '');
  return text.match(/--distribution\s+(?:&quot;|")([^"&]+)(?:&quot;|")/)?.[1] ?? null;
}

function deleteTask(name: string, run: CommandRunner): CommandResult {
  run(SCHTASKS, ['/End', '/TN', name]);
  return run(SCHTASKS, ['/Delete', '/TN', name, '/F']);
}

interface Preflight { systemd: boolean; service: boolean; linger: boolean; foreground: boolean; verify: boolean }

function parsePreflight(stdout: string): Preflight | 'no-runner' | 'no-login' | null {
  const line = stdout.replace(/\0/g, '').split(/\r?\n/).find(l => l.startsWith(MARKER));
  if (!line) return null;
  const rest = line.slice(MARKER.length).trim();
  if (rest === 'no-runner' || rest === 'no-login') return rest;
  if (!rest.startsWith('ok ')) return null;
  const kv = Object.fromEntries(rest.slice(3).split(/\s+/).map(p => p.split('=') as [string, string]));
  return { systemd: kv.systemd === 'yes', service: kv.service === 'yes', linger: kv.linger === 'yes', foreground: kv.foreground === 'yes', verify: kv.verify === 'pass' };
}

const ACTIVE = (s: string) => s !== 'done' && s !== 'error';

export async function runWslMigrate(args: MigrateArgs, deps: MigrateDeps): Promise<number> {
  const { log, run } = deps;
  const pollMs = deps.pollMs ?? 15_000;

  if (deps.platform !== 'win32') {
    log('buildd wsl migrate runs on Windows, from PowerShell: it hands over from the Windows runner to the one inside WSL. Nothing changed.');
    return 1;
  }
  if (args.distro !== undefined && !DISTRO_NAME.test(args.distro)) {
    log(`"${args.distro}" is not a distribution name this command accepts (letters, digits, . _ -). Nothing changed.`);
    return 1;
  }

  if (args.undo) {
    let target = args.distro;
    if (!target) {
      const list = run('wsl.exe', ['--list', '--verbose']);
      const wsl2 = list.exitCode === 0 ? parseDistributions(list.stdout).filter(d => d.version === 2) : [];
      if (wsl2.length === 1) target = wsl2[0].name;
    }
    if (!target || !DISTRO_NAME.test(target)) {
      log('Say which distribution to undo: buildd wsl migrate --undo --distro <name> (see wsl --list --verbose). Nothing changed.');
      return 1;
    }
    const name = logonTaskName(target);
    const legacyHere = logonTaskStatus(LEGACY_LOGON_TASK_NAME, run) && logonTaskTarget(LEGACY_LOGON_TASK_NAME, run) === target;
    if (!logonTaskStatus(name, run) && !legacyHere) {
      log(`No '${name}' logon task is registered. Nothing changed.`);
      return 0;
    }
    for (const n of [name, ...(legacyHere ? [LEGACY_LOGON_TASK_NAME] : [])]) {
      if (n === name && !logonTaskStatus(n, run)) continue;
      const del = deleteTask(n, run);
      if (del.exitCode !== 0) { log(`Could not remove the '${n}' logon task: ${failure(del)}`); return 1; }
      log(`Removed the '${n}' logon task: Windows no longer starts ${target} at logon or restarts it.`);
    }
    rmSync(logonTaskXmlPath(deps.paths, target), { force: true });
    log('Other distributions\' tasks and the runner service inside WSL are unchanged; stop the service there with buildd service uninstall.');
    return 0;
  }

  // ── 1. check, changing nothing ────────────────────────────────────────────
  const list = run('wsl.exe', ['--list', '--verbose']);
  if (list.exitCode !== 0) {
    log(`wsl --list --verbose failed: ${failure(list)}. Run it in PowerShell as this Windows user and resolve that first. Nothing changed.`);
    return 1;
  }
  const wsl2 = parseDistributions(list.stdout).filter(d => d.version === 2);
  const distro = args.distro ?? (wsl2.length === 1 ? wsl2[0].name : undefined);
  if (!distro) {
    log(wsl2.length === 0
      ? 'No WSL2 distribution found. Set one up first (apps/runner/WSL2.md). Nothing changed.'
      : 'More than one WSL2 distribution: pass the one with the runner, buildd wsl migrate --distro <name> (see wsl --list --verbose). Nothing changed.');
    return 1;
  }
  if (!wsl2.some(d => d.name === distro)) {
    log(`${distro} is not a WSL2 distribution on this machine (see wsl --list --verbose). Nothing changed.`);
    return 1;
  }
  if (!DISTRO_NAME.test(distro)) {
    log(`Distribution "${distro}" has a name this command cannot pass safely; rename it or run the steps in apps/runner/WSL2.md by hand. Nothing changed.`);
    return 1;
  }
  const inWsl = (script: string) => run('wsl.exe', ['--distribution', distro, '--exec', 'sh', '-lc', script]);

  log(`Checking the runner inside ${distro}...`);
  const pre = inWsl(WSL_MIGRATE_PREFLIGHT);
  const p = pre.exitCode === 0 ? parsePreflight(pre.stdout) : null;
  const refuse = (why: string) => { log(`${why}\nNothing changed: the Windows runner keeps working.`); return 1; };
  if (p === null) return refuse(`Could not check the distribution: ${failure(pre)}. Open wsl --distribution ${distro} and resolve its startup error.`);
  if (p === 'no-runner') return refuse(`No buildd runner is installed inside ${distro}. Inside it run: curl -fsSL https://buildd.dev/install.sh | bash`);
  if (p === 'no-login') return refuse(`The runner inside ${distro} is not logged in. Inside it run: buildd login`);
  if (!p.verify) return refuse(`Claude confinement inside ${distro} did not verify. Inside it run bun ~/.buildd/apps/runner/src/isolation-check.ts --verify-wsl and follow its remedy (apps/runner/WSL2.md step 4).`);
  if (!p.systemd) return refuse(`systemd is not running in ${distro}, so the runner cannot run as a service there. Enable it (${SYSTEMD_DOCS}), run wsl --shutdown once nothing is running, then rerun buildd wsl migrate.`);
  if (p.foreground) return refuse(`A runner is running in the foreground inside ${distro}. Close it (Ctrl+C in its terminal) so the service does not run beside it, then rerun buildd wsl migrate.`);
  log(`  The runner inside ${distro} is installed, logged in and confined (bwrap, linux-wsl).`);

  if (p.linger) {
    log('  Linger is already on: the WSL service runs without a Linux login.');
  } else {
    const q = `Enable linger for your Linux user in ${distro}, so its service runs without a Linux login? It runs ${WSL_LINGER} and asks for your Linux password. [y/N] `;
    if (!deps.confirm || !(await deps.confirm(q))) {
      return refuse(`Linger is needed so the WSL service keeps running. Inside ${distro} run: ${WSL_LINGER}\nthen rerun buildd wsl migrate.`);
    }
    const code = deps.runInteractive('wsl.exe', ['--distribution', distro, '--exec', 'sh', '-lc', WSL_LINGER]);
    if (code !== 0) return refuse(`${WSL_LINGER} failed (exit ${code}). Run it inside ${distro} yourself, then rerun buildd wsl migrate.`);
    log(`  Enabled linger for your Linux user in ${distro}.`);
  }

  // From here a failure leaves the Windows runner on hold with its task present.
  const stuck = (why: string) => {
    log(why);
    log('The Windows runner is on hold and its Scheduled Task is still installed: nothing was removed.');
    log('Fix the above and rerun buildd wsl migrate to continue, or run buildd resume to put the Windows runner back to work.');
    return 1;
  };

  // ── 2. hold the Windows runner, wait for its work ─────────────────────────
  const windowsPresent = !!windowsTaskStatus(deps.paths, run) || await deps.windows.live();
  const drain = async (): Promise<string | null> => {
    let shown = '';
    let errors = 0;
    for (;;) {
      const work = await deps.windows.activeWork();
      if ('error' in work) {
        if (!(await deps.windows.live())) return null;
        if (++errors >= 3) return work.error;
      } else {
        errors = 0;
        const active = work.filter(w => ACTIVE(w.status));
        if (active.length === 0) return null;
        const now = active.map(w => w.title).join(', ');
        if (now !== shown) {
          log(`  Waiting for ${active.length} task${active.length === 1 ? '' : 's'} on the Windows runner to finish: ${now}`);
          if (!shown) log('  Nothing is stopped. Ctrl+C leaves the wait; the Windows runner stays on hold and rerunning continues.');
          shown = now;
        }
      }
      await deps.sleep(pollMs);
    }
  };
  if (windowsPresent) {
    const held = await deps.windows.hold();
    if (!held.ok) return refuse(`Could not hold the Windows runner: ${held.message}`);
    log(`  Windows runner: ${held.message}`);
    const err = await drain();
    if (err) return stuck(`The Windows runner did not say what it is running: ${err}`);
    log('  Nothing is running on the Windows runner.');
  } else {
    log('  Windows runner: already removed.');
  }

  // ── 3. the WSL service ────────────────────────────────────────────────────
  const running = () => inWsl(WSL_SERVICE_CHECK).stdout.includes(`${MARKER}running`);
  if (p.service && running()) {
    log(`  The runner service inside ${distro} is already installed and running.`);
  } else {
    const inst = inWsl(WSL_SERVICE_INSTALL);
    if (inst.exitCode !== 0) return stuck(`buildd service install inside ${distro} failed: ${failure(inst)}`);
    log(`  Installed the runner service inside ${distro} (systemd --user buildd-runner).`);
    let up = false;
    for (let i = 0; i < 12 && !(up = running()); i++) await deps.sleep(5_000);
    if (!up) return stuck(`The runner service inside ${distro} did not come up. Inside it check buildd service status and buildd service logs.`);
    log('  It is running; check its heartbeat on the dashboard (linux-wsl, Claude bwrap).');
  }

  // ── 4. the logon task ─────────────────────────────────────────────────────
  const taskName = logonTaskName(distro);
  if (logonTaskStatus(LEGACY_LOGON_TASK_NAME, run)) {
    // The old fixed-name task is not tied to a distribution we can trust: replace it with per-distribution ones.
    const was = logonTaskTarget(LEGACY_LOGON_TASK_NAME, run);
    const del = deleteTask(LEGACY_LOGON_TASK_NAME, run);
    if (del.exitCode !== 0) return stuck(`Could not replace the old '${LEGACY_LOGON_TASK_NAME}' logon task: ${failure(del)}`);
    log(`  Replaced the old '${LEGACY_LOGON_TASK_NAME}' logon task with '${taskName}'.` +
      (was && was !== distro ? ` It started ${was}: run buildd wsl migrate --distro ${was} to register that distribution's own task.` : ''));
  }
  const status = logonTaskStatus(taskName, run);
  const registeredFor = status ? logonTaskTarget(taskName, run) : null;
  if (status && registeredFor !== distro) {
    return stuck(`The '${taskName}' logon task already exists and ${registeredFor ? `starts ${registeredFor}, not ${distro}` : 'its target cannot be read'}. Remove it (schtasks /Delete /TN "${taskName}") or run buildd wsl migrate --undo for that distribution, then rerun.`);
  }
  if (status === 'Running') {
    log(`  The '${taskName}' logon task is already registered and running.`);
  } else {
    if (!status) {
      const file = logonTaskXmlPath(deps.paths, distro);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(`﻿${generateLogonTaskXml(distro, deps.paths.windowsUser)}`, 'utf16le'));
      const create = run(SCHTASKS, ['/Create', '/TN', taskName, '/XML', file, '/F']);
      if (create.exitCode !== 0) return stuck(`Could not register the '${taskName}' logon task: ${failure(create)}`);
      log(`  Registered the '${taskName}' logon task: at each logon, and again every few minutes if WSL has stopped, it starts ${distro}.`);
    }
    const start = run(SCHTASKS, ['/Run', '/TN', taskName]);
    if (start.exitCode !== 0) return stuck(`Could not start the '${taskName}' logon task: ${failure(start)}`);
    log(`  Started it now, so ${distro} stays running after this window closes.`);
  }

  // ── 5. remove the Windows runner ──────────────────────────────────────────
  if (windowsPresent) {
    // A person may start work on a held runner (claims they make still run): wait for it too.
    const err = await drain();
    if (err) return stuck(`The Windows runner did not say what it is running: ${err}`);
    // List pending tasks pinned to the Windows runner before removing it.
    let pending: { title: string }[] = [];
    try {
      pending = await deps.windows.pendingPinned();
    } catch {
      // Lookup errors don't crash the migration; just skip listing
    }
    for (const task of pending) {
      log(`  ${task.title} waits for the Windows runner until re-filed or unpinned.`);
    }
    const removed = uninstallService(deps.paths, 'win32', run);
    if (!removed.ok) return stuck(`Could not remove the Windows runner's Scheduled Task: ${removed.message}`);
    log(`  Windows runner: ${removed.message}`);
    let named = false;
    while (await deps.windows.live()) {
      if (!named) {
        log('  A Windows runner is still running in a terminal. Close it (Ctrl+C in its window); waiting for it to exit...');
        named = true;
      }
      await deps.sleep(pollMs);
    }
  }

  log(`Done. The runner inside ${distro} now does this machine's work and starts at each Windows logon.`);
  log(`buildd wsl migrate --undo --distro ${distro} removes the '${taskName}' logon task.`);
  return 0;
}

// ── real machine ────────────────────────────────────────────────────────────

/** wsl.exe writes UTF-16 for its own messages and UTF-8 for Linux output; schtasks writes the console code page. */
export const realRun: CommandRunner = (file, args) => {
  const r = spawnSync(file, args, { timeout: 180_000, windowsHide: true });
  const decode = (b: Buffer | null) => !b ? '' : b.includes(0) ? b.toString('utf16le') : b.toString('utf8');
  return { exitCode: r.status ?? 1, stdout: decode(r.stdout), stderr: decode(r.stderr) + (r.error ? r.error.message : '') };
};

export async function main(argv: string[]): Promise<number> {
  const args = parseMigrateArgs(argv);
  if (!args) { console.error(MIGRATE_USAGE); return 64; }
  const { resolveBuilddHome } = await import('./buildd-home');
  const { runnerSocketPath, probeRunnerSocket } = await import('./runner-socket');
  const { runHoldCommand, listAgents, terminalConfirm } = await import('./runner-hold');
  const builddHome = resolveBuilddHome();
  const socketPath = runnerSocketPath(builddHome);
  const configFile = process.env.BUILDD_CONFIG || join(builddHome, 'config.json');
  return runWslMigrate(args, {
    platform: process.platform,
    paths: resolveServicePaths(),
    run: realRun,
    runInteractive: (file, a) => spawnSync(file, a, { stdio: 'inherit' }).status ?? 1,
    log: (line) => console.log(line),
    confirm: terminalConfirm(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    windows: {
      live: async () => (await probeRunnerSocket(socketPath)).state === 'live',
      hold: async () => {
        const r = await runHoldCommand({ kind: 'hold', forArg: null }, { configFile, socketPath });
        return { ok: r.code === 0, message: (r.code === 0 ? r.stdout : r.stderr).trim() };
      },
      activeWork: async () => {
        if ((await probeRunnerSocket(socketPath)).state !== 'live') return [];
        const agents = await listAgents({ socketPath });
        return 'error' in agents ? agents : agents.map(a => ({ title: a.title, status: a.status }));
      },
      pendingPinned: async () => {
        try {
          // Read config to get API key and base URL
          let config: { apiKey?: string; builddServer?: string } = {};
          try {
            const configContent = readFileSync(configFile, 'utf8');
            config = JSON.parse(configContent);
          } catch {
            // Config not readable; API key must come from env var
          }

          const apiKey = config.apiKey || process.env.BUILDD_API_KEY;
          if (!apiKey) return [];

          const baseUrl = (process.env.BUILDD_CLIENT_URL || config.builddServer || 'https://buildd.dev').replace(/\/+$/, '');
          const runnerId = headlessRunnerKey({ hostname: undefined, platform: 'windows' });
          const runnerCapability = `runner:${runnerId}`;

          // Query pending tasks from the API
          const response = await fetch(`${baseUrl}/api/tasks?status=pending`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });

          if (!response.ok) return [];

          const data = await response.json() as { tasks: Array<{ title: string; requiredCapabilities?: string[] }> };

          // Filter for tasks pinned to this Windows runner
          return data.tasks
            .filter(task => task.requiredCapabilities?.includes(runnerCapability))
            .map(task => ({ title: task.title }));
        } catch {
          // Handle any errors gracefully - don't crash the migration
          return [];
        }
      },
    },
  });
}
