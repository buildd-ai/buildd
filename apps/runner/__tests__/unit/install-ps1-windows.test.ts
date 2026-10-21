/**
 * install.ps1 is the Windows twin of install.sh. These checks keep it runnable
 * under Windows PowerShell 5.1 and in step with install.sh, which it had
 * drifted from: a runner it installed could not start.
 *
 * Run: cd apps/runner && bun test __tests__/unit/install-ps1-windows.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';

// Bun.file, not fs, so other tests' mock.module('fs') can't intercept the read.
const ps1Bytes = new Uint8Array(
  await Bun.file(join(import.meta.dir, '../../install.ps1')).arrayBuffer(),
);
const ps1 = new TextDecoder().decode(ps1Bytes).replace(/\r\n/g, '\n');
const installSh = await Bun.file(join(import.meta.dir, '../../install.sh')).text();

const lines = (block: string) => block.split('\n').map(l => l.trim()).filter(Boolean);

// The launcher is the single-quoted here-string written to buildd.cmd.
const launcher = ps1.match(/@'\n(@echo off[\s\S]*?)\n'@ \| Set-Content "\$BinDir\\buildd\.cmd"/)?.[1] ?? '';

describe('install.ps1 encoding', () => {
  // Windows PowerShell 5.1 reads a BOM-less script run with -File as ANSI, so
  // a single em dash broke parsing ("The string is missing the terminator").
  test('contains only ASCII characters', () => {
    const offending = ps1
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /[^\x00-\x7F]/.test(text));
    expect(offending).toEqual([]);
  });
});

describe('install.ps1 bun bootstrap', () => {
  test('restores the PATH it had before running the bun installer', () => {
    const save = ps1.indexOf('$SavedPath = $env:Path');
    const bunInstall = ps1.indexOf('irm bun.sh/install.ps1 | iex');
    const restore = ps1.indexOf('$env:Path = "$env:USERPROFILE\\.bun\\bin;$SavedPath"');
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(bunInstall);
    expect(restore).toBeGreaterThan(bunInstall);
  });
});

describe('install.ps1 checks out what install.sh does', () => {
  const shSparse = lines(installSh.match(/<< 'SPARSE'\n([\s\S]*?)\nSPARSE/)?.[1] ?? '');
  const ps1Sparse = [...ps1.matchAll(/@"\n([\s\S]*?)\n"@ \| Set-Content "\.git\\info\\sparse-checkout"/g)].map(m => lines(m[1]));

  test('both sparse-checkout lists (fresh install and update) match install.sh', () => {
    expect(shSparse.length).toBeGreaterThan(0);
    expect(ps1Sparse.length).toBe(2);
    for (const list of ps1Sparse) expect(list).toEqual(shSparse);
  });

});

describe('install.ps1 launcher', () => {
  test('is found in install.ps1', () => {
    expect(launcher.length).toBeGreaterThan(0);
  });

  test('every bun run preloads the server-only stub, as the bash launcher does', () => {
    const runs = launcher.match(/^\s*bun .*$/gm) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toContain('--preload "%BUILDD_PRELOAD%"');
    expect(launcher).toContain('set "BUILDD_PRELOAD=%USERPROFILE%\\.buildd\\scripts\\stub-server-only.ts"');
  });

  test('sends `buildd install` to the agent plugin installer, not the runner', () => {
    const branch = launcher.match(/if \/i "%SUBCMD%"=="install" \(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(branch).toContain('apps\\runner\\src\\agent-plugin-install.ts');
    expect(branch).toContain('exit /b');
    expect(launcher.indexOf('=="install"')).toBeLessThan(launcher.indexOf(':runloop'));
  });

  test('sends `buildd service` to service.ts, as the bash launcher does', () => {
    const branch = launcher.match(/if \/i "%SUBCMD%"=="service" \(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(branch).toContain('apps\\runner\\src\\service.ts" !REST!');
    expect(branch).toContain('exit /b');
    expect(launcher.indexOf('=="service"')).toBeLessThan(launcher.indexOf(':runloop'));
  });

  // The runner rejects these with "Unknown argument", so a launcher that lets
  // them fall through to index.ts breaks commands its own help lists.
  for (const cmd of ['status', 'logout', 'init']) {
    test(`sends \`buildd ${cmd}\` to launcher-commands.ts, not the runner`, () => {
      const branch = launcher.match(new RegExp(`if /i "%SUBCMD%"=="${cmd}" \\(([\\s\\S]*?)\\n\\)`))?.[1] ?? '';
      expect(branch).toContain(`apps\\runner\\src\\launcher-commands.ts" ${cmd} !REST!`);
      expect(branch).toContain('exit /b');
      expect(launcher.indexOf(`=="${cmd}"`)).toBeLessThan(launcher.indexOf(':runloop'));
    });

    test(`install.sh runs the same launcher-commands.ts for \`buildd ${cmd}\``, () => {
      const branch = installSh.match(new RegExp(`\\n  ${cmd}\\)\\n([\\s\\S]*?)\\n    ;;`))?.[1] ?? '';
      expect(branch).toContain(`apps/runner/src/launcher-commands.ts" ${cmd} "$@"`);
    });
  }

  // A bare `exit /b` inside an if (...) block exits 0, whatever bun returned
  // (`buildd init` with no id "succeeded"); %ERRORLEVEL% there is expanded
  // before bun runs. The bash launcher's exec passes the code through.
  test("every subcommand branch exits with bun's exit code", () => {
    const branchExits = launcher.slice(0, launcher.indexOf(':runloop')).match(/^\s*exit \/b.*$/gm) ?? [];
    expect(branchExits.length).toBeGreaterThan(0);
    for (const e of branchExits) expect(e.trim()).toBe('exit /b !ERRORLEVEL!');
  });

  // `set "PROJECTS_ROOT=!ROOTS!"` without delayed expansion set the literal text !ROOTS!.
  test('enables delayed expansion for the !VAR! it uses', () => {
    expect(launcher).toMatch(/!\w+!/);
    expect(launcher).toContain('setlocal EnableDelayedExpansion');
  });
});
