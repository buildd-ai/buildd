import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveServicePaths, type CommandResult } from '../../src/service';
import {
  LOGON_TASK_NAME,
  WSL_MIGRATE_PREFLIGHT,
  WSL_SERVICE_CHECK,
  WSL_SERVICE_INSTALL,
  generateLogonTaskXml,
  parseMigrateArgs,
  runWslMigrate,
  type MigrateDeps,
} from '../../src/wsl-migrate';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Agent { title: string; status: string }
interface Machine {
  distros: string;
  runner: boolean;
  login: boolean;
  systemd: 'yes' | 'no';
  service: 'yes' | 'no';
  linger: 'yes' | 'no';
  wslForeground: boolean;
  verify: 'pass' | 'fail';
  serviceInstallFails: boolean;
  logonCreateFails: boolean;
  /** The Windows Scheduled Task `buildd runner`. */
  winTask: boolean;
  /** A Windows runner answers on its socket. */
  windowsLive: boolean;
  /** A Windows runner started in a terminal, not by the task: survives /End until `closeForegroundAfter` probes. */
  windowsForeground: boolean;
  closeForegroundAfter: number;
  held: boolean;
  /** What each activeWork() call answers, in order; the last one repeats. */
  active: Agent[][];
  logonTask: 'absent' | 'Ready' | 'Running';
  lingerAnswer: number;
}

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'failed'): CommandResult => ({ exitCode: 1, stdout: '', stderr });

function machine(over: Partial<Machine> = {}) {
  const m: Machine = {
    distros: '  NAME STATE VERSION\n* Ubuntu Running 2\n',
    runner: true, login: true, systemd: 'yes', service: 'no', linger: 'no', wslForeground: false, verify: 'pass',
    serviceInstallFails: false, logonCreateFails: false,
    winTask: true, windowsLive: true, windowsForeground: false, closeForegroundAfter: 0, held: false,
    active: [[]], logonTask: 'absent', lingerAnswer: 0,
    ...over,
  };
  const calls: string[] = [];
  const events: string[] = [];
  const lines: string[] = [];
  let sleeps = 0;
  let foregroundProbes = 0;
  const home = mkdtempSync(join(tmpdir(), 'wsl-migrate-'));
  dirs.push(home);

  const run = (file: string, args: string[]): CommandResult => {
    calls.push([file, ...args].join(' '));
    if (file === 'wsl.exe' && args[0] === '--list') return ok(m.distros);
    if (file === 'wsl.exe' && args[0] === '--distribution') {
      expect(args.slice(2, 5)).toEqual(['--exec', 'sh', '-lc']);
      const script = args[5];
      if (script === WSL_MIGRATE_PREFLIGHT) {
        if (!m.runner) return ok('BUILDD_WSL_MIGRATE=no-runner\n');
        if (!m.login) return ok('BUILDD_WSL_MIGRATE=no-login\n');
        return ok(`BUILDD_WSL_MIGRATE=ok systemd=${m.systemd} service=${m.service} linger=${m.linger} foreground=${m.wslForeground ? 'yes' : 'no'} verify=${m.verify}\n`);
      }
      if (script === WSL_SERVICE_INSTALL) {
        events.push('wsl-service-install');
        if (m.serviceInstallFails) return fail('systemctl --user enable failed');
        m.service = 'yes';
        return ok('Installed systemd --user service');
      }
      if (script === WSL_SERVICE_CHECK) return ok(m.service === 'yes' ? 'BUILDD_WSL_MIGRATE=running\n' : '');
      throw new Error(`unexpected script: ${script}`);
    }
    if (file === 'schtasks.exe') {
      const name = args[args.indexOf('/TN') + 1];
      const verb = args[0];
      if (name === 'buildd runner') {
        if (verb === '/Query') return m.winTask ? ok('TaskName: \\buildd runner\nStatus: Running\n') : fail('not found');
        if (verb === '/End') { events.push('windows-task-end'); if (!m.windowsForeground) m.windowsLive = false; return ok(); }
        if (verb === '/Delete') { events.push('windows-task-delete'); m.winTask = false; return ok(); }
      }
      if (name === LOGON_TASK_NAME) {
        if (verb === '/Query') return m.logonTask === 'absent' ? fail('not found') : ok(`TaskName: \\${LOGON_TASK_NAME}\nStatus: ${m.logonTask}\n`);
        if (verb === '/Create') { events.push('logon-create'); if (m.logonCreateFails) return fail('Access is denied.'); m.logonTask = 'Ready'; return ok(); }
        if (verb === '/Run') { events.push('logon-run'); m.logonTask = 'Running'; return ok(); }
        if (verb === '/End') return ok();
        if (verb === '/Delete') { events.push('logon-delete'); m.logonTask = 'absent'; return ok(); }
      }
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const deps = (confirmAnswer: boolean | null = true): MigrateDeps => ({
    platform: 'win32',
    paths: resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'win32', windowsUser: 'PC\\me' }),
    run,
    runInteractive: (file, args) => {
      calls.push([file, ...args].join(' '));
      expect(file).toBe('wsl.exe');
      events.push('linger');
      if (m.lingerAnswer === 0) m.linger = 'yes';
      return m.lingerAnswer;
    },
    log: (line) => lines.push(line),
    confirm: confirmAnswer === null ? null : async (q) => { lines.push(`? ${q}`); return confirmAnswer; },
    sleep: async () => { sleeps++; },
    pollMs: 1,
    windows: {
      live: async () => {
        if (m.windowsLive && m.windowsForeground && !m.winTask) {
          foregroundProbes++;
          if (foregroundProbes > m.closeForegroundAfter) m.windowsLive = false;
        }
        return m.windowsLive;
      },
      hold: async () => { events.push('hold'); m.held = true; return { ok: true, message: 'Paused: nothing new starts.' }; },
      activeWork: async () => {
        const now = m.active.length > 1 ? m.active.shift()! : m.active[0];
        events.push(`active:${now.length}`);
        return now;
      },
    },
  });
  return { m, calls, events, lines, deps, sleeps: () => sleeps, out: () => lines.join('\n') };
}

const mutating = (calls: string[]) => calls.filter(c =>
  /schtasks\.exe \/(Create|Run|Delete|End)/.test(c) || c.includes(WSL_SERVICE_INSTALL) || c.includes('enable-linger'));

describe('buildd wsl migrate', () => {
  test('active work on the Windows runner blocks the handover until it finishes (R-15, AC-10)', async () => {
    const t = machine({ active: [[{ title: 'Fix the parser', status: 'working' }], [{ title: 'Fix the parser', status: 'working' }], []] });
    const code = await runWslMigrate({ undo: false }, t.deps());
    expect(code).toBe(0);
    // Held first; the Scheduled Task is removed only once nothing is running.
    expect(t.events[0]).toBe('linger');
    expect(t.events[1]).toBe('hold');
    const lastBusy = t.events.lastIndexOf('active:1');
    const end = t.events.indexOf('windows-task-end');
    expect(lastBusy).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(lastBusy);
    expect(t.events.slice(lastBusy + 1, end)).toContain('active:0');
    expect(t.sleeps()).toBeGreaterThanOrEqual(2);
    expect(t.out()).toContain('Fix the parser');
    // Never ends a task: the only /End is the Scheduled Task's, after the drain.
    expect(t.calls.filter(c => c.includes('/End'))).toEqual(['schtasks.exe /End /TN buildd runner']);
    expect(t.m.winTask).toBe(false);
    expect(t.m.logonTask).toBe('Running');
    expect(t.m.service).toBe('yes');
  });

  test('work a person starts while it is held is waited for again before the task is removed', async () => {
    // Drained, WSL set up, then a claim on the held runner (R-34 of the terminal spec) before removal.
    const t = machine({ active: [[], [{ title: 'Started by hand', status: 'working' }], []] });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(0);
    const busy = t.events.indexOf('active:1');
    expect(busy).toBeGreaterThan(t.events.indexOf('logon-run'));
    expect(t.events.indexOf('windows-task-end')).toBeGreaterThan(busy);
    expect(t.out()).toContain('Started by hand');
  });

  test('the WSL service and logon task are running before the Windows task is removed (R-20)', async () => {
    const t = machine();
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(0);
    const order = ['wsl-service-install', 'logon-create', 'logon-run', 'windows-task-end', 'windows-task-delete'].map(e => t.events.indexOf(e));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('an already-migrated machine is a no-op that reports each step as done (R-19, AC-13)', async () => {
    const t = machine({ winTask: false, windowsLive: false, service: 'yes', linger: 'yes', logonTask: 'Running' });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(0);
    expect(mutating(t.calls)).toEqual([]);
    expect(t.events.filter(e => e === 'hold' || e === 'linger')).toEqual([]);
    expect(t.out()).toMatch(/already/i);
    expect(t.out()).not.toContain('?');
  });

  test('a failed WSL service install leaves the Windows runner held, its task in place, and says how to resume (R-20)', async () => {
    const t = machine({ serviceInstallFails: true });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(t.m.held).toBe(true);
    expect(t.m.winTask).toBe(true);
    expect(t.events).not.toContain('windows-task-end');
    expect(t.out()).toContain('systemctl --user enable failed');
    expect(t.out()).toContain('buildd wsl migrate');
    expect(t.out()).toContain('buildd resume');
  });

  test('a failed logon task registration leaves the Windows runner held with its task in place', async () => {
    const t = machine({ logonCreateFails: true });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(t.m.held).toBe(true);
    expect(t.m.winTask).toBe(true);
    expect(t.out()).toContain('Access is denied.');
    expect(t.out()).toContain('buildd wsl migrate');
  });

  test('a WSL runner that fails --verify-wsl is refused before anything changes (R-14, AC-11)', async () => {
    const t = machine({ verify: 'fail' });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(t.m.held).toBe(false);
    expect(t.m.winTask).toBe(true);
    expect(mutating(t.calls)).toEqual([]);
    expect(t.out()).toContain('--verify-wsl');
  });

  test('no runner or no login inside WSL is refused with the step to take, changing nothing (R-14)', async () => {
    for (const [over, words] of [[{ runner: false }, 'install.sh'], [{ login: false }, 'buildd login']] as const) {
      const t = machine(over);
      expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
      expect(t.m.held).toBe(false);
      expect(mutating(t.calls)).toEqual([]);
      expect(t.out()).toContain(words);
    }
  });

  test('a distribution without systemd stops with the enable-systemd step; the Windows task stays (R-17, AC-14)', async () => {
    const t = machine({ systemd: 'no' });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(t.m.winTask).toBe(true);
    expect(mutating(t.calls)).toEqual([]);
    expect(t.out()).toContain('learn.microsoft.com/windows/wsl/systemd');
  });

  test('a foreground runner inside WSL is never joined by the service (R-19)', async () => {
    const t = machine({ wslForeground: true });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(mutating(t.calls)).toEqual([]);
    expect(t.out()).toMatch(/foreground/i);
  });

  test('linger is enabled only after a yes; a no or no terminal changes nothing and prints the command', async () => {
    for (const answer of [false, null] as const) {
      const t = machine();
      expect(await runWslMigrate({ undo: false }, t.deps(answer))).toBe(1);
      expect(t.events).not.toContain('linger');
      expect(t.m.held).toBe(false);
      expect(mutating(t.calls)).toEqual([]);
      expect(t.out()).toContain('sudo loginctl enable-linger');
    }
  });

  test('a Windows runner started in a terminal is named and waited for after the task is removed (R-16)', async () => {
    const t = machine({ windowsForeground: true, closeForegroundAfter: 2 });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(0);
    expect(t.out()).toMatch(/still running in a terminal/i);
    expect(t.m.windowsLive).toBe(false);
  });

  test('refuses off Windows and runs nothing (R-1 pattern)', async () => {
    const t = machine();
    expect(await runWslMigrate({ undo: false }, { ...t.deps(), platform: 'linux' })).toBe(1);
    expect(t.calls).toEqual([]);
    expect(t.out()).toContain('PowerShell');
  });

  test('two WSL2 distributions without --distro asks for one', async () => {
    const t = machine({ distros: '  NAME STATE VERSION\n* Ubuntu Running 2\n  Debian Stopped 2\n' });
    expect(await runWslMigrate({ undo: false }, t.deps())).toBe(1);
    expect(t.out()).toContain('--distro');
    expect(mutating(t.calls)).toEqual([]);
  });

  test('--undo removes only the logon task (R-18)', async () => {
    const t = machine({ logonTask: 'Running' });
    expect(await runWslMigrate({ undo: true }, t.deps())).toBe(0);
    expect(t.events).toEqual(['logon-delete']);
    expect(t.m.winTask).toBe(true);
    const again = machine();
    expect(await runWslMigrate({ undo: true }, again.deps())).toBe(0);
    expect(again.out()).toMatch(/no .*logon task/i);
  });
});

describe('the logon task (R-18)', () => {
  test('starts the distribution and keeps it running, never the Windows runner', () => {
    const xml = generateLogonTaskXml('Ubuntu-22.04', 'PC\\me');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Command>wsl.exe</Command>');
    expect(xml).toContain('--distribution &quot;Ubuntu-22.04&quot; --exec sleep infinity');
    expect(xml).not.toContain('buildd.cmd');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(LOGON_TASK_NAME).not.toBe('buildd runner');
  });

  test('distribution names that are not plain words are refused before any command', async () => {
    const t = machine();
    expect(await runWslMigrate({ undo: false, distro: 'a" & calc' }, t.deps())).toBe(1);
    expect(t.calls).toEqual([]);
  });
});

describe('arguments', () => {
  test('parses --distro and --undo, refuses anything else', () => {
    expect(parseMigrateArgs([])).toEqual({ undo: false });
    expect(parseMigrateArgs(['--distro', 'Ubuntu'])).toEqual({ undo: false, distro: 'Ubuntu' });
    expect(parseMigrateArgs(['--undo'])).toEqual({ undo: true });
    expect(parseMigrateArgs(['--distro'])).toBeNull();
    expect(parseMigrateArgs(['--force'])).toBeNull();
  });
});

describe('the Windows launcher', () => {
  test('buildd.cmd sends `buildd wsl` to wsl.ts before the runner loop', () => {
    const launcher = readFileSync(join(import.meta.dir, '..', '..', 'install.ps1'), 'utf8');
    const branch = launcher.match(/if \/i "%SUBCMD%"=="wsl" \(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(branch).toContain('apps\\runner\\src\\wsl.ts" !REST!');
    expect(launcher.indexOf('=="wsl"')).toBeLessThan(launcher.indexOf(':runloop'));
  });
});
