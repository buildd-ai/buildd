/**
 * install.sh inside WSL2 (spec a0b82b5d part 2: R-7, R-8, R-9, R-12, R-13;
 * AC-5, AC-6, AC-7, AC-9).
 *
 * The functions between the `# --- wsl setup` markers run for real under bash,
 * with a PATH holding only the commands each case allows, so "missing" and
 * "installed" are what `command -v` sees, and sudo/apt-get are recorders.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();
const BEGIN = '# --- wsl setup: begin ---';
const END = '# --- wsl setup: end ---';
const block = installSh.slice(installSh.indexOf(BEGIN), installSh.indexOf(END) + END.length);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const REAL_TOOLS = ['uname', 'id', 'grep', 'mkdir', 'cat', 'dirname'];
function which(tool: string): string {
  const r = Bun.spawnSync(['bash', '-c', `command -v ${tool}`]);
  return new TextDecoder().decode(r.stdout).trim();
}

interface Run { out: string; code: number; log: string; home: string; rc: string }

/**
 * Runs `script` after the block. `present` are the commands on PATH; `answer`
 * is what the operator says to every question (wsl_ask is replaced, since a
 * test has no terminal: with no terminal the real one answers no).
 */
function run(script: string, opts: { present?: string[]; answer?: 'y' | 'n' | 'no-tty'; env?: Record<string, string>; root?: boolean } = {}): Run {
  const home = temp('buildd-wsl-home-');
  const bin = temp('buildd-wsl-bin-');
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  for (const tool of REAL_TOOLS) { const p = which(tool); if (p && !(opts.root && tool === 'id')) symlinkSync(p, join(bin, tool)); }
  if (opts.root) writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n');
  for (const c of opts.present ?? []) writeFileSync(join(bin, c), '#!/bin/sh\nexit 0\n');
  // Recorders: every sudo/apt-get call lands in calls.log.
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\necho "sudo $*" >> "${log}"\nexec "$@"\n`);
  writeFileSync(join(bin, 'apt-get'), `#!/bin/sh\necho "apt-get $*" >> "${log}"\nexit 0\n`);
  for (const f of ['id', 'sudo', 'apt-get', ...(opts.present ?? [])]) { try { chmodSync(join(bin, f), 0o755); } catch { /* symlink */ } }
  const rc = join(home, '.bashrc');
  writeFileSync(rc, '');
  const ask = opts.answer === 'y' ? 'wsl_ask() { echo "Q: $1"; return 0; }'
    : opts.answer === 'n' ? 'wsl_ask() { echo "Q: $1"; return 1; }' : '';
  const full = `GREEN=''; YELLOW=''; RED=''; NC=''\n${block}\n${ask}\n${script}\n`;
  const r = Bun.spawnSync([which('bash'), '-c', full], { env: { HOME: home, PATH: bin, BUILDD_TTY: '/dev/null', ...(opts.env ?? {}) } });
  return { out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr), code: r.exitCode ?? -1, log: readFileSync(log, 'utf8'), home, rc };
}

describe.skipIf(process.platform === 'win32')('install.sh inside WSL', () => {
  test('the block exists, and its steps run only when is_wsl says so (R-7)', () => {
    expect(installSh).toContain(BEGIN);
    expect(installSh).toContain(END);
    expect(installSh).toMatch(/if \[ "\$CLIENT_MODE" != "1" \] && is_wsl; then\n\s+IN_WSL=1/);
    // Every WSL step after detection is gated on IN_WSL.
    expect(installSh).toContain('[ "$IN_WSL" = "1" ] && wsl_projects_root_check "$SHELL_RC"');
    expect(installSh).toMatch(/if \[ "\$IN_WSL" = "1" \]; then\n\s+wsl_logins "\$BIN_DIR\/buildd"\n\s+wsl_verify "\$INSTALL_DIR" \|\| WSL_VERIFIED=0\nfi/);
    expect(installSh).toContain('[ "$IN_WSL" = "1" ] || bwrap_offer');
  });

  describe('WSL detected vs not', () => {
    const none = { WSL_INTEROP_FILE: '/nonexistent/WSLInterop', WSL_PROC_VERSION: '/nonexistent/version' };
    test('plain Linux: not WSL (AC-6)', () => {
      const procVersion = join(temp('buildd-wsl-proc-'), 'version');
      writeFileSync(procVersion, 'Linux version 6.8.0-generic (buildd@ubuntu) #1 SMP\n');
      expect(run('is_wsl && echo WSL || echo NOT', { env: { ...none, WSL_PROC_VERSION: procVersion } }).out.trim()).toBe('NOT');
    });
    test('WSL_DISTRO_NAME set: WSL', () => {
      expect(run('is_wsl && echo WSL || echo NOT', { env: { ...none, WSL_DISTRO_NAME: 'Ubuntu' } }).out.trim()).toBe('WSL');
    });
    test('/proc/version names Microsoft: WSL', () => {
      const procVersion = join(temp('buildd-wsl-proc-'), 'version');
      writeFileSync(procVersion, 'Linux version 5.15.153.1-microsoft-standard-WSL2\n');
      expect(run('is_wsl && echo WSL || echo NOT', { env: { ...none, WSL_PROC_VERSION: procVersion } }).out.trim()).toBe('WSL');
    });
    test('the WSLInterop binfmt entry: WSL', () => {
      const interop = join(temp('buildd-wsl-proc-'), 'WSLInterop');
      writeFileSync(interop, 'enabled\n');
      expect(run('is_wsl && echo WSL || echo NOT', { env: { ...none, WSL_INTEROP_FILE: interop } }).out.trim()).toBe('WSL');
    });
  });

  describe('prerequisites (R-8)', () => {
    test('lists exactly the missing ones of bubblewrap, socat, git, curl and unzip', () => {
      expect(run('wsl_missing_packages', { present: ['git', 'curl'] }).out.trim()).toBe('bubblewrap socat unzip');
      expect(run('wsl_missing_packages', { present: ['bwrap', 'socat', 'git', 'curl', 'unzip'] }).out.trim()).toBe('');
    });

    test('declined: nothing is installed, and the command is printed (AC-5)', () => {
      const r = run('wsl_packages_offer', { present: ['git', 'curl', 'unzip'], answer: 'n' });
      expect(r.code).toBe(0);
      expect(r.log).toBe('');
      expect(r.out).toContain('Nothing installed');
      expect(r.out).toContain('sudo apt-get install -y bubblewrap socat');
    });

    test('no terminal to ask on: nothing is installed', () => {
      const r = run('wsl_packages_offer', { present: ['git', 'curl', 'unzip'], answer: 'no-tty' });
      expect(r.log).toBe('');
      expect(r.out).toContain('sudo apt-get install -y bubblewrap socat');
    });

    test('accepted: one sudo apt-get install for exactly the missing ones (AC-5)', () => {
      const r = run('wsl_packages_offer', { present: ['git', 'curl', 'unzip'], answer: 'y' });
      expect(r.code).toBe(0);
      const installs = r.log.split('\n').filter(l => l.startsWith('sudo apt-get install'));
      expect(installs).toEqual(['sudo apt-get install -y bubblewrap socat']);
      expect(r.log.split('\n').filter(l => l.startsWith('sudo ')).every(l => /^sudo apt-get (update|install -y bubblewrap socat)$/.test(l))).toBe(true);
      expect(r.out).toContain('asks for your Linux password');
    });

    test('as root it asks too and uses no sudo', () => {
      const r = run('wsl_packages_offer', { present: ['git', 'curl', 'unzip', 'socat'], answer: 'y', root: true });
      expect(r.log).not.toContain('sudo');
      expect(r.log).toContain('apt-get install -y bubblewrap');
    });

    test('nothing missing: no question and nothing run', () => {
      const r = run('wsl_packages_offer', { present: ['bwrap', 'socat', 'git', 'curl', 'unzip'], answer: 'y' });
      expect(r.out).not.toContain('Q:');
      expect(r.log).toBe('');
    });
  });

  describe('project root under /mnt (R-9)', () => {
    test('a /mnt root warns and offers ~/code; yes creates it and configures it, moving nothing (AC-7)', () => {
      const r = run('wsl_projects_root_check "$HOME/.bashrc"; echo "ROOT=$PROJECTS_ROOT"', { answer: 'y', env: { PROJECTS_ROOT: '/mnt/c/Users/me/code' } });
      expect(r.out).toContain('Windows drive (/mnt/c/Users/me/code)');
      expect(r.out).toContain('~/code');
      expect(existsSync(join(r.home, 'code'))).toBe(true);
      expect(r.out).toContain(`ROOT=${r.home}/code`);
      expect(readFileSync(r.rc, 'utf8')).toContain('export PROJECTS_ROOT="$HOME/code"');
      expect(r.log).toBe('');
    });

    test('declined: warned, root unchanged, nothing created', () => {
      const r = run('wsl_projects_root_check "$HOME/.bashrc"; echo "ROOT=$PROJECTS_ROOT"', { answer: 'n', env: { PROJECTS_ROOT: '/home/me/src, /mnt/d/repos' } });
      expect(r.out).toContain('/mnt/d/repos');
      expect(r.out).toContain('ROOT=/home/me/src, /mnt/d/repos');
      expect(existsSync(join(r.home, 'code'))).toBe(false);
      expect(readFileSync(r.rc, 'utf8')).toBe('');
    });

    test('a Linux root: no warning, no question', () => {
      const r = run('wsl_projects_root_check "$HOME/.bashrc"', { answer: 'y', env: { PROJECTS_ROOT: '/home/me/code' } });
      expect(r.out).toBe('');
    });
  });

  describe('logins (R-10)', () => {
    test('in order claude, buildd codex login, buildd login; Codex never through a codex command on PATH', () => {
      const r = run(`buildd_login_source() { :; }\nclaude() { echo "claude $*"; }\nb() { echo "buildd $*"; }\nwsl_logins b`,
        { answer: 'y', present: ['claude'], env: { BROWSER: 'wslview' } });
      const calls = r.out.split('\n').filter(l => /^(claude|buildd) /.test(l));
      expect(calls).toEqual(['claude login', 'buildd codex login', 'buildd login']);
      expect(r.out).not.toMatch(/^codex /m);
    });

    test('already logged in: each is skipped with a note, nothing runs', () => {
      const r = run(`buildd_login_source() { echo config; }\nmkdir -p "$HOME/.claude" "$HOME/.codex"; echo x > "$HOME/.claude/.credentials.json"; echo x > "$HOME/.codex/auth.json"; wsl_logins /nonexistent`, { answer: 'y', present: ['claude'] });
      expect(r.out).toContain('Claude: already logged in');
      expect(r.out).toContain('Codex: already logged in');
      expect(r.out).toContain('buildd: already logged in');
      expect(r.out).not.toContain('Q:');
    });

    test('no browser: buildd login --device is offered', () => {
      const r = run('buildd_login_source() { :; }\nwsl_logins /nonexistent', { answer: 'n' });
      expect(r.out).toContain('buildd login --device');
      expect(r.out).toContain('Later: buildd codex login');
    });

    test('never reads a Windows profile', () => {
      expect(block).not.toMatch(/\/mnt\/c\/Users|USERPROFILE|\.exe/);
    });
  });

  describe('confinement check (R-12, R-13)', () => {
    const fakeRunner = (exit: number) => {
      const dir = temp('buildd-wsl-install-');
      mkdirSync(join(dir, 'apps/runner/src'), { recursive: true });
      writeFileSync(join(dir, 'apps/runner/src/isolation-check.ts'), `if (process.argv.includes('--verify-wsl')) process.exit(${exit}); console.log('  To fix: install bubblewrap');\n`);
      return dir;
    };
    const bunDir = Bun.which('bun')!;
    test('pass: the verdict in words, return 0 (AC-9)', () => {
      const ok = Bun.spawnSync(['bash', '-c', `GREEN=''; YELLOW=''; RED=''; NC=''\n${block}\nwsl_verify "${fakeRunner(0)}"`], { env: { PATH: `${join(bunDir, '..')}:/usr/bin:/bin`, HOME: temp('buildd-wsl-home-') } });
      expect(ok.exitCode).toBe(0);
      expect(new TextDecoder().decode(ok.stdout)).toContain('linux-wsl and Claude runs confined by bwrap');
    });
    test('fail: the remedy, no service, non-zero (AC-9)', () => {
      const bad = Bun.spawnSync(['bash', '-c', `GREEN=''; YELLOW=''; RED=''; NC=''\n${block}\nwsl_verify "${fakeRunner(1)}"`], { env: { PATH: `${join(bunDir, '..')}:/usr/bin:/bin`, HOME: temp('buildd-wsl-home-') } });
      const out = new TextDecoder().decode(bad.stdout);
      expect(bad.exitCode).toBe(1);
      expect(out).toContain('Not verified');
      expect(out).toContain('To fix: install bubblewrap');
      expect(out).toContain('No background service was installed');
    });
    test('the installer gates the service on the check and exits non-zero on failure', () => {
      expect(installSh).toMatch(/if \[ "\$WSL_VERIFIED" != "1" \]; then\n\s+INSTALL_SERVICE=0/);
      expect(installSh).toContain('[ "$WSL_VERIFIED" = "1" ] || exit 1');
      expect(installSh).toContain("buildd wsl migrate");
    });
  });
});
