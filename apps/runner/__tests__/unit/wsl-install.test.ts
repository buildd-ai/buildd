import { describe, expect, test } from 'bun:test';
import { installWsl, inspectWsl, parseWindowsBuild, LINUX_INSTALLER, type WslInstallDeps, type CommandResult } from '../../src/wsl-setup';
import { classifyCliArgs, RUNNER_USAGE } from '../../src/cli-args';

/**
 * `buildd wsl install` (Living Spec a0b82b5d "Windows runner through WSL2",
 * part 1: R-1..R-6, AC-1..AC-4). The fakes record every wsl.exe call so each
 * test can say exactly what ran, and that nothing installing ran on a no.
 */
const ok = (stdout: string): CommandResult => ({ code: 0, stdout });
const ubuntu2 = '  NAME STATE VERSION\n* Ubuntu Stopped 2\n';
const INSTALL = ['--install', '-d', 'Ubuntu', '--no-launch'];

interface Fake extends WslInstallDeps { calls: string[][]; interactive: string[][]; lines: string[]; asked: string[] }
function fake(opts: {
  platform?: string; release?: string;
  lists?: CommandResult[]; uids?: string[];
  answer?: boolean | null; installCode?: number; installerCode?: number;
}): Fake {
  const lists = [...(opts.lists ?? [ok(ubuntu2)])];
  const uids = [...(opts.uids ?? ['1000'])];
  const f: Fake = {
    calls: [], interactive: [], lines: [], asked: [],
    platform: opts.platform ?? 'win32',
    release: opts.release ?? '10.0.22631',
    run: (file, args) => {
      f.calls.push([file, ...args]);
      if (args[0] === '--list') return lists.length > 1 ? lists.shift()! : lists[0];
      if (args.includes('id')) return ok((uids.length > 1 ? uids.shift()! : uids[0]) + '\n');
      throw Error(`unexpected command ${args.join(' ')}`);
    },
    runInteractive: (file, args) => {
      f.interactive.push([file, ...args]);
      if (args[0] === '--install') return opts.installCode ?? 0;
      if (args.includes(LINUX_INSTALLER)) return opts.installerCode ?? 0;
      return 0;
    },
    confirm: opts.answer === null ? null : async q => { f.asked.push(q); return opts.answer ?? false; },
    out: l => f.lines.push(l),
  };
  return f;
}
const text = (f: Fake) => f.lines.join('\n');
const installed = (f: Fake) => f.interactive.some(c => c[1] === '--install') || f.calls.some(c => c[1] === '--install');

describe('buildd wsl install: version gate (R-2, AC-1)', () => {
  test('parses the Windows build from os.release()', () => {
    expect(parseWindowsBuild('10.0.19045')).toBe(19045);
    expect(parseWindowsBuild('10.0.22631')).toBe(22631);
    expect(parseWindowsBuild('weird')).toBeNull();
  });

  test('an unsupported Windows build stops with the reason before touching WSL', async () => {
    const f = fake({ release: '10.0.18363', answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('18363');
    expect(text(f)).toContain('19041');
    expect(f.calls).toEqual([]);
    expect(f.interactive).toEqual([]);
    expect(f.asked).toEqual([]);
  });

  test('an unknown build stops too: it never guesses', async () => {
    const f = fake({ release: '', answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  test('says native Windows Claude stays unsupported', async () => {
    const f = fake({});
    await installWsl(undefined, f);
    expect(text(f)).toContain('Native Windows Claude remains unsupported');
  });
});

describe('buildd wsl install: only on Windows (R-1)', () => {
  test('refuses elsewhere with exit 1 and runs nothing', async () => {
    const f = fake({ platform: 'linux', answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('PowerShell');
    expect(f.calls).toEqual([]);
    expect(f.interactive).toEqual([]);
  });
});

describe('buildd wsl install: asks before installing (R-3, AC-2, AC-3)', () => {
  test('declining the prompt installs nothing and prints the command', async () => {
    const f = fake({ lists: [ok('')], answer: false });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toContain('wsl --install -d Ubuntu --no-launch');
    expect(installed(f)).toBe(false);
    expect(f.interactive).toEqual([]);
    expect(text(f)).toContain('wsl --install -d Ubuntu --no-launch');
  });

  test('no terminal to ask on installs nothing', async () => {
    const f = fake({ lists: [ok('')], answer: null });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(installed(f)).toBe(false);
    expect(text(f)).toContain('wsl --install -d Ubuntu --no-launch');
  });

  test('missing wsl.exe is offered the same install, and a no still installs nothing', async () => {
    const f = fake({ lists: [{ code: 1, stdout: '', missing: true }], answer: false });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.asked).toHaveLength(1);
    expect(installed(f)).toBe(false);
  });

  test('WSL feature present with no distributions (WSL_E_DEFAULT_DISTRO_NOT_FOUND) is offered the install', async () => {
    const f = fake({ lists: [{ code: 1, stdout: 'Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND' }], answer: false });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.asked).toHaveLength(1);
  });

  test('a yes runs the install once, then opens Ubuntu and runs the Linux installer', async () => {
    const f = fake({ lists: [ok(''), ok(ubuntu2)], uids: ['0', '1000'], answer: true });
    expect(await installWsl(undefined, f)).toBe(0);
    const installs = f.interactive.filter(c => c[1] === '--install');
    expect(installs).toEqual([['wsl.exe', ...INSTALL]]);
    // Opened interactively for the operator to create the Linux user, then the installer.
    expect(f.interactive.slice(1)).toEqual([
      ['wsl.exe', '--distribution', 'Ubuntu'],
      ['wsl.exe', '--distribution', 'Ubuntu', '--exec', 'bash', '-lc', LINUX_INSTALLER],
    ]);
  });

  test('when Windows needs a reboot it says so and stops; rerunning continues with the distribution', async () => {
    const first = fake({ lists: [ok(''), ok('')], answer: true });
    expect(await installWsl(undefined, first)).toBe(1);
    expect(text(first)).toMatch(/restart/i);
    expect(text(first)).toContain('buildd wsl install');
    expect(first.interactive.some(c => c.includes(LINUX_INSTALLER))).toBe(false);

    const rerun = fake({ lists: [ok(ubuntu2)], answer: true });
    expect(await installWsl(undefined, rerun)).toBe(0);
    expect(installed(rerun)).toBe(false);
    expect(rerun.asked).toEqual([]);
  });

  test('a failed install says so and does not go on', async () => {
    const f = fake({ lists: [ok('')], answer: true, installCode: 1 });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.interactive).toHaveLength(1);
  });
});

describe('buildd wsl install: never a second distribution (R-4, AC-4)', () => {
  test('an existing distribution is reused: no question, no install', async () => {
    const f = fake({ lists: [ok(ubuntu2)], answer: true });
    expect(await installWsl(undefined, f)).toBe(0);
    expect(f.asked).toEqual([]);
    expect(installed(f)).toBe(false);
    expect(text(f)).toContain('Ubuntu');
    expect(f.interactive).toEqual([['wsl.exe', '--distribution', 'Ubuntu', '--exec', 'bash', '-lc', LINUX_INSTALLER]]);
  });

  test('an existing non-Ubuntu WSL2 distribution is reused too', async () => {
    const f = fake({ lists: [ok('  NAME STATE VERSION\n* Debian Running 2\n')], answer: true });
    expect(await installWsl(undefined, f)).toBe(0);
    expect(installed(f)).toBe(false);
    expect(f.interactive.at(-1)!.slice(0, 3)).toEqual(['wsl.exe', '--distribution', 'Debian']);
  });

  test('enumeration refused (access denied) installs nothing and asks nothing', async () => {
    const f = fake({ lists: [{ code: 1, stdout: 'E_ACCESSDENIED' }], answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.asked).toEqual([]);
    expect(installed(f)).toBe(false);
    expect(text(f)).toContain('same Windows user');
  });

  test('WSL1 only is reported with the conversion command, never converted', async () => {
    const f = fake({ lists: [ok('  NAME STATE VERSION\n* Ubuntu Stopped 1\n')], answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('wsl --set-version "Ubuntu" 2');
    expect(installed(f)).toBe(false);
    expect(f.calls.every(c => c[1] === '--list')).toBe(true);
    expect(f.interactive).toEqual([]);
  });

  test('two WSL2 distributions ask for --distro; --distro picks one', async () => {
    const two = ok(ubuntu2 + '  Debian Stopped 2\n');
    const f = fake({ lists: [two], answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('--distro');
    expect(installed(f)).toBe(false);

    const g = fake({ lists: [two], answer: true });
    expect(await installWsl('Debian', g)).toBe(0);
    expect(g.interactive.at(-1)!.slice(0, 3)).toEqual(['wsl.exe', '--distribution', 'Debian']);
  });

  test('an unknown --distro installs nothing', async () => {
    const f = fake({ lists: [ok(ubuntu2)], answer: true });
    expect(await installWsl('Arch', f)).toBe(1);
    expect(text(f)).toContain('not found');
    expect(installed(f)).toBe(false);
  });
});

describe('buildd wsl install: the Linux user and the installer (R-5, R-6)', () => {
  test('a root default user opens the distribution for the operator, and stops if it is still root', async () => {
    const f = fake({ lists: [ok(ubuntu2)], uids: ['0', '0'] });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(f.interactive).toEqual([['wsl.exe', '--distribution', 'Ubuntu']]);
    expect(text(f)).toContain('root');
    expect(f.interactive.some(c => c.includes(LINUX_INSTALLER))).toBe(false);
  });

  test('the user probe and installer get the distribution only as an argument, never in a shell string', async () => {
    const name = 'Ubuntu "x"; rm -rf ~';
    const f = fake({ lists: [ok(`  NAME STATE VERSION\n* ${name} Stopped 2\n`)] });
    expect(await installWsl(undefined, f)).toBe(0);
    for (const c of [...f.calls, ...f.interactive].filter(c => c[1] === '--distribution')) {
      expect(c[2]).toBe(name);
      expect(c.slice(3).join(' ')).not.toContain(name);
    }
    expect(LINUX_INSTALLER).toContain('https://buildd.dev/install.sh');
    expect(LINUX_INSTALLER).not.toMatch(/sudo/);
  });

  test("the installer's failure is the command's failure", async () => {
    const f = fake({ lists: [ok(ubuntu2)], installerCode: 3 });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('Linux installer');
  });

  test('success names the next steps inside Linux', async () => {
    const f = fake({ lists: [ok(ubuntu2)] });
    expect(await installWsl(undefined, f)).toBe(0);
    expect(text(f)).toContain('--verify-wsl');
  });
});

describe('buildd wsl install: command line', () => {
  const argv = (...a: string[]) => ['bun', 'index.ts', ...a];
  test('classifies wsl install with an optional --distro', () => {
    expect(classifyCliArgs(argv('wsl', 'install'))).toEqual({ kind: 'wsl-install', distro: null });
    expect(classifyCliArgs(argv('wsl', 'install', '--distro', 'Ubuntu'))).toEqual({ kind: 'wsl-install', distro: 'Ubuntu' });
    expect(classifyCliArgs(argv('wsl', 'install', '--distro=Debian'))).toEqual({ kind: 'wsl-install', distro: 'Debian' });
  });
  test('anything else under wsl is refused by name', () => {
    expect(classifyCliArgs(argv('wsl'))).toEqual({ kind: 'unknown', arg: 'wsl' });
    expect(classifyCliArgs(argv('wsl', 'setup'))).toEqual({ kind: 'unknown', arg: 'setup' });
    expect(classifyCliArgs(argv('wsl', 'install', '--distro'))).toEqual({ kind: 'unknown', arg: '--distro' });
    expect(classifyCliArgs(argv('wsl', 'install', '--yes'))).toEqual({ kind: 'unknown', arg: '--yes' });
  });
  test('usage lists buildd wsl install', () => {
    expect(RUNNER_USAGE).toContain('buildd wsl install');
  });
});

// Acceptance criteria (Living Spec a0b82b5d, part 1): one test per check id,
// named so grading can find it. The scenarios above already exercise the
// same code paths in more detail; these are the direct GIVEN/WHEN/THEN.
describe('acceptance criteria', () => {
  test('AC-1: an unsupported Windows build exits 1 before any wsl.exe call, naming both builds', async () => {
    const f = fake({ release: '10.0.18363', answer: true });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(text(f)).toContain('18363');
    expect(text(f)).toContain('19041 or later');
    expect(f.calls).toEqual([]);
    expect(f.interactive).toEqual([]);
  });

  test('AC-2: declining the install question changes nothing and prints the exact operator command', async () => {
    const f = fake({ lists: [ok('')], answer: false });
    expect(await installWsl(undefined, f)).toBe(1);
    expect(installed(f)).toBe(false);
    expect(f.interactive).toEqual([]);
    expect(text(f)).toContain('wsl --install -d Ubuntu --no-launch');
  });

  test('AC-3: a yes runs the install once; a reboot stops it, and rerunning continues to the Linux user and installer', async () => {
    const first = fake({ lists: [ok(''), ok('')], answer: true });
    expect(await installWsl(undefined, first)).toBe(1);
    expect(first.interactive.filter(c => c[1] === '--install')).toEqual([['wsl.exe', ...INSTALL]]);
    expect(text(first)).toMatch(/restart/i);
    expect(first.interactive.some(c => c.includes(LINUX_INSTALLER))).toBe(false);

    const rerun = fake({ lists: [ok(ubuntu2)], uids: ['0', '1000'], answer: true });
    expect(await installWsl(undefined, rerun)).toBe(0);
    expect(rerun.asked).toEqual([]);
    expect(rerun.interactive).toEqual([
      ['wsl.exe', '--distribution', 'Ubuntu'],
      ['wsl.exe', '--distribution', 'Ubuntu', '--exec', 'bash', '-lc', LINUX_INSTALLER],
    ]);
  });

  test('AC-4: a WSL1-only machine or a refused listing installs or converts nothing, naming the operator step; the probe stays read-only', async () => {
    const wsl1 = fake({ lists: [ok('  NAME STATE VERSION\n* Ubuntu Stopped 1\n')], answer: true });
    expect(await installWsl(undefined, wsl1)).toBe(1);
    expect(text(wsl1)).toContain('wsl --set-version "Ubuntu" 2');
    expect(installed(wsl1)).toBe(false);
    expect(wsl1.interactive).toEqual([]);

    const denied = fake({ lists: [{ code: 1, stdout: 'E_ACCESSDENIED' }], answer: true });
    expect(await installWsl(undefined, denied)).toBe(1);
    expect(text(denied)).toContain('same Windows user');
    expect(installed(denied)).toBe(false);

    // bun run wsl:setup (inspectWsl) stays a probe: it never issues --install,
    // whatever it finds.
    const probeCalls: string[][] = [];
    inspectWsl('win32', undefined, (file, args) => {
      probeCalls.push([file, ...args]);
      return args[0] === '--list' ? ok(ubuntu2) : { code: 1, stdout: '', missing: true };
    });
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls.some(c => c[1] === '--install')).toBe(false);
  });
});
