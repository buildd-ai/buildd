import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveServicePaths, type CommandResult } from '../../src/service';
import {
  LEGACY_LOGON_TASK_NAME,
  WSL_MIGRATE_PREFLIGHT,
  WSL_SERVICE_CHECK,
  WSL_SERVICE_INSTALL,
  generateLogonTaskXml,
  logonTaskName,
  runWslMigrate,
  type MigrateDeps,
} from '../../src/wsl-migrate';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'failed'): CommandResult => ({ exitCode: 1, stdout: '', stderr });
const PREFLIGHT = 'BUILDD_WSL_MIGRATE=ok systemd=yes service=no linger=yes foreground=no verify=pass\n';

/** A machine with two WSL2 distributions and a task table keyed by name -> the distribution it starts. */
function machine(initial: Record<string, string> = {}) {
  const tasks = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  const lines: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'wsl-logon-task-'));
  dirs.push(home);
  const run = (file: string, args: string[]): CommandResult => {
    calls.push([file, ...args].join(' '));
    if (file === 'wsl.exe' && args[0] === '--list') return ok('  NAME STATE VERSION\n* Ubuntu Running 2\n  Debian Running 2\n');
    if (file === 'wsl.exe' && args[0] === '--distribution') {
      const script = args[5];
      if (script === WSL_MIGRATE_PREFLIGHT) return ok(PREFLIGHT);
      if (script === WSL_SERVICE_INSTALL) return ok('Installed');
      if (script === WSL_SERVICE_CHECK) return ok('BUILDD_WSL_MIGRATE=running\n');
    }
    if (file === 'schtasks.exe') {
      const name = args[args.indexOf('/TN') + 1];
      const verb = args[0];
      if (name === 'buildd runner') return fail('not found');
      if (verb === '/Query' && args.includes('/XML')) return tasks.has(name) ? ok(generateLogonTaskXml(tasks.get(name)!, 'PC\\me')) : fail('not found');
      if (verb === '/Query') return tasks.has(name) ? ok(`TaskName: \\${name}\nStatus: Ready\n`) : fail('not found');
      if (verb === '/Create') {
        const xmlFile = args[args.indexOf('/XML') + 1];
        const target = xmlFile.match(/buildd-wsl-(.+)\.xml$/)?.[1] ?? '';
        tasks.set(name, target);
        return ok();
      }
      if (verb === '/Run' || verb === '/End') return ok();
      if (verb === '/Delete') { tasks.delete(name); return ok(); }
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  const deps = (): MigrateDeps => ({
    platform: 'win32',
    paths: resolveServicePaths({ home, builddHome: join(home, '.buildd'), platform: 'win32', windowsUser: 'PC\\me' }),
    run,
    runInteractive: () => 0,
    log: (l) => lines.push(l),
    confirm: null,
    sleep: async () => {},
    pollMs: 1,
    windows: { live: async () => false, hold: async () => ({ ok: true, message: '' }), activeWork: async () => [] },
  });
  return { tasks, calls, deps, out: () => lines.join('\n') };
}

describe('the WSL task definition (R-18, R-19)', () => {
  const xml = generateLogonTaskXml('Ubuntu-22.04', 'PC\\me');

  test('restarts on failure and repeats so a stopped WSL is brought back', () => {
    expect(xml).toMatch(/<RestartOnFailure><Interval>PT\d+M<\/Interval><Count>\d+<\/Count><\/RestartOnFailure>/);
    expect(xml).toContain('<LogonTrigger>');
    const time = xml.match(/<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/)?.[1] ?? '';
    expect(time).toContain('<Repetition>');
    expect(time).toMatch(/<Interval>PT\d+M<\/Interval>/);
    expect(time).not.toContain('<Duration>'); // repeats indefinitely
  });

  test('a repeat is a no-op while the distribution runs; per-user; never the native runner', () => {
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Command>wsl.exe</Command>');
    const action = xml.match(/<Actions[\s\S]*<\/Actions>/)?.[0] ?? '';
    expect(action).not.toMatch(/buildd/);
  });

  test('keeps the distribution name out of a shell string: one escaped wsl.exe argument', () => {
    expect(xml).toContain('--distribution &quot;Ubuntu-22.04&quot; --exec sleep infinity');
    expect(xml).not.toMatch(/cmd(\.exe)?|powershell/i);
  });
});

describe('one task per distribution (R-18)', () => {
  test('names are per distribution', () => {
    expect(logonTaskName('Ubuntu')).toBe('buildd WSL (Ubuntu)');
    expect(logonTaskName('Ubuntu')).not.toBe(logonTaskName('Debian'));
  });

  test('two distributions get two tasks, each starting its own', async () => {
    const t = machine();
    expect(await runWslMigrate({ undo: false, distro: 'Ubuntu' }, t.deps())).toBe(0);
    expect(await runWslMigrate({ undo: false, distro: 'Debian' }, t.deps())).toBe(0);
    expect([...t.tasks.entries()]).toEqual([['buildd WSL (Ubuntu)', 'Ubuntu'], ['buildd WSL (Debian)', 'Debian']]);
  });

  test('reusing a task that targets another distribution is refused', async () => {
    const t = machine({ 'buildd WSL (Debian)': 'Ubuntu' });
    expect(await runWslMigrate({ undo: false, distro: 'Debian' }, t.deps())).toBe(1);
    expect(t.out()).toMatch(/starts Ubuntu, not Debian/);
    expect(t.calls.some(c => /schtasks\.exe \/(Create|Run) /.test(c))).toBe(false);
    expect(t.tasks.get('buildd WSL (Debian)')).toBe('Ubuntu');
  });

  test('--undo removes only its own distribution\'s task', async () => {
    const t = machine({ 'buildd WSL (Ubuntu)': 'Ubuntu', 'buildd WSL (Debian)': 'Debian' });
    expect(await runWslMigrate({ undo: true, distro: 'Debian' }, t.deps())).toBe(0);
    expect([...t.tasks.keys()]).toEqual(['buildd WSL (Ubuntu)']);
    expect(t.calls.filter(c => c.includes('/Delete'))).toEqual(['schtasks.exe /Delete /TN buildd WSL (Debian) /F']);
  });

  test('--undo with several distributions and no --distro asks for one and changes nothing', async () => {
    const t = machine({ 'buildd WSL (Ubuntu)': 'Ubuntu' });
    expect(await runWslMigrate({ undo: true }, t.deps())).toBe(1);
    expect(t.out()).toContain('--distro');
    expect(t.tasks.size).toBe(1);
  });
});

describe('the old fixed-name task', () => {
  test('migrate replaces it, says so, and registers the per-distribution task', async () => {
    const t = machine({ [LEGACY_LOGON_TASK_NAME]: 'Ubuntu' });
    expect(await runWslMigrate({ undo: false, distro: 'Ubuntu' }, t.deps())).toBe(0);
    expect([...t.tasks.keys()]).toEqual(['buildd WSL (Ubuntu)']);
    expect(t.out()).toContain(`Replaced the old '${LEGACY_LOGON_TASK_NAME}' logon task`);
  });

  test('when the old task started another distribution, migrate tells you to migrate that one too', async () => {
    const t = machine({ [LEGACY_LOGON_TASK_NAME]: 'Debian' });
    expect(await runWslMigrate({ undo: false, distro: 'Ubuntu' }, t.deps())).toBe(0);
    expect(t.out()).toContain('--distro Debian');
  });

  test('--undo removes the old task only when it targets that distribution', async () => {
    const other = machine({ [LEGACY_LOGON_TASK_NAME]: 'Debian' });
    expect(await runWslMigrate({ undo: true, distro: 'Ubuntu' }, other.deps())).toBe(0);
    expect(other.tasks.has(LEGACY_LOGON_TASK_NAME)).toBe(true);
    const mine = machine({ [LEGACY_LOGON_TASK_NAME]: 'Ubuntu' });
    expect(await runWslMigrate({ undo: true, distro: 'Ubuntu' }, mine.deps())).toBe(0);
    expect(mine.tasks.size).toBe(0);
  });
});
