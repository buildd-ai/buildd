import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  gitForWindowsShCandidates,
  killProcessTree,
  posixShell,
  PosixShellMissingError,
  resolvePosixShell,
  type PosixShellDeps,
  windowsExecutablePath,
} from '../../src/posix-shell';

function deps(over: Partial<PosixShellDeps>): PosixShellDeps {
  return { platform: 'linux', env: {}, gitExecPath: () => null, exists: () => false, ...over };
}

describe('resolvePosixShell', () => {
  test('POSIX hosts keep /bin/sh and never ask git', () => {
    let asked = false;
    expect(resolvePosixShell(deps({ platform: 'linux', gitExecPath: () => { asked = true; return null; } }))).toBe('/bin/sh');
    expect(resolvePosixShell(deps({ platform: 'darwin' }))).toBe('/bin/sh');
    expect(asked).toBe(false);
  });

  test('BUILDD_POSIX_SHELL wins on any platform', () => {
    expect(resolvePosixShell(deps({ platform: 'linux', env: { BUILDD_POSIX_SHELL: '/usr/bin/dash' } }))).toBe('/usr/bin/dash');
    expect(resolvePosixShell(deps({ platform: 'win32', env: { BUILDD_POSIX_SHELL: 'D:/msys64/usr/bin/sh.exe' } }))).toBe('D:/msys64/usr/bin/sh.exe');
  });

  test('win32 uses the sh.exe Git for Windows installs next to git', () => {
    const execPath = 'C:/Program Files (x86)/Git/mingw64/libexec/git-core';
    const shell = resolvePosixShell(deps({
      platform: 'win32',
      gitExecPath: () => execPath,
      exists: (p) => p === 'C:/Program Files (x86)/Git/usr/bin/sh.exe',
    }));
    expect(shell).toBe('C:/Program Files (x86)/Git/usr/bin/sh.exe');
  });

  test('win32 falls back to <git>/bin/sh.exe', () => {
    const shell = resolvePosixShell(deps({
      platform: 'win32',
      gitExecPath: () => 'C:\\Git\\mingw64\\libexec\\git-core',
      exists: (p) => p === 'C:\\Git/bin/sh.exe',
    }));
    expect(shell).toBe('C:\\Git/bin/sh.exe');
  });

  test('win32 without git says what to install instead of an ENOENT on /bin/sh', () => {
    expect(() => resolvePosixShell(deps({ platform: 'win32' }))).toThrow(PosixShellMissingError);
    expect(() => resolvePosixShell(deps({ platform: 'win32' }))).toThrow(/Git for Windows/);
  });

  test('win32 with a git that ships no sh names the git it found', () => {
    expect(() => resolvePosixShell(deps({ platform: 'win32', gitExecPath: () => 'C:/Git/mingw64/libexec/git-core' })))
      .toThrow(/no sh\.exe found next to git \(C:\/Git\/mingw64\/libexec\/git-core\)/);
  });
});

describe('gitForWindowsShCandidates', () => {
  test('strips the libexec/git-core suffix for each MSYS2 environment', () => {
    for (const env of ['mingw64', 'mingw32', 'clangarm64', 'ucrt64']) {
      expect(gitForWindowsShCandidates(`C:/Git/${env}/libexec/git-core/`)).toEqual(['C:/Git/usr/bin/sh.exe', 'C:/Git/bin/sh.exe']);
    }
  });

  test('an exec path of another layout (a POSIX git) yields nothing', () => {
    expect(gitForWindowsShCandidates('/usr/lib/git-core')).toEqual([]);
  });
});

describe('posixShell on this host', () => {
  test('runs the sh command lines the runner builds, unchanged', () => {
    const r = spawnSync(posixShell(), ['-c', 'git --version 2>/dev/null || true; command -v git >/dev/null && echo "$(echo found)"'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git version');
    expect(r.stdout).toContain('found');
  });
});

describe('killProcessTree', () => {
  test('POSIX signals the process group', () => {
    const calls: Array<[number, string]> = [];
    killProcessTree(42, 'SIGTERM', { platform: 'linux', killGroup: (pid, sig) => calls.push([pid, sig]), killWindowsTree: () => { throw new Error('no'); } });
    expect(calls).toEqual([[42, 'SIGTERM']]);
  });

  test('win32 never calls kill(-pid), which has no process group to reach there', () => {
    const calls: Array<[number, string]> = [];
    killProcessTree(42, 'SIGTERM', { platform: 'win32', killGroup: () => { throw new Error('ESRCH'); }, killWindowsTree: (pid, sig) => calls.push([pid, sig]) });
    expect(calls).toEqual([[42, 'SIGTERM']]);
  });

  test('POSIX propagates a missing group so the caller can fall back to the child', () => {
    expect(() => killProcessTree(42, 'SIGKILL', { platform: 'linux', killGroup: () => { throw new Error('ESRCH'); }, killWindowsTree: () => {} })).toThrow('ESRCH');
  });
});

describe('windowsExecutablePath', () => {
  test('answers a forward-slash path that sh and execFile both accept', () => {
    expect(windowsExecutablePath('mergiraf', () => 'C:\\Users\\a\\.cargo\\bin\\mergiraf.exe')).toBe('C:/Users/a/.cargo/bin/mergiraf.exe');
  });

  test('null when nothing is on PATH', () => {
    expect(windowsExecutablePath('mergiraf', () => null)).toBeNull();
  });
});

describe('env-verify default runner', () => {
  test('runs manifest steps as POSIX sh on every host (cmd.exe has no `command -v`)', async () => {
    const { defaultRunCommand } = await import('../../src/env-verify');
    const out = await defaultRunCommand('command -v git >/dev/null && echo "$(echo tool-ok)" 2>/dev/null', { cwd: process.cwd(), timeoutMs: 10_000, env: process.env as Record<string, string> });
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe('tool-ok');
  });
});
