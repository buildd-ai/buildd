import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { probeCodexWindowsSandbox, resolveCodexBinary, type CodexSandboxRun } from '../../src/codex-windows-sandbox';

/**
 * The Windows Codex sandbox probe (Living Spec "Runner isolation", R-1): confined
 * only when a write inside the workspace lands and a write outside it does not.
 * The fake `run` stands in for `codex sandbox`, writing the file the command
 * names when the fake sandbox allows it.
 */

function fakeRun(allow: (target: string, cwd: string) => boolean): CodexSandboxRun & { commands: string[] } {
  const commands: string[] = [];
  const run = ((_bin: string, cwd: string, _home: string, command: string) => {
    commands.push(command);
    const rel = /> (\S+)$/.exec(command)?.[1];
    const target = rel ? resolve(cwd, rel.replace(/\\/g, '/')) : null;
    if (!target || !allow(target, cwd)) return false;
    writeFileSync(target, 'x');
    return true;
  }) as CodexSandboxRun & { commands: string[] };
  run.commands = commands;
  return run;
}

const probeRoot = () => mkdtempSync(join(tmpdir(), 'codex-sbx-probe-root-'));

describe('probeCodexWindowsSandbox', () => {
  it('confined: inside write lands, outside write is refused', () => {
    const run = fakeRun((target, cwd) => target.startsWith(cwd));
    expect(probeCodexWindowsSandbox({ codexBin: () => 'codex.exe', run, probeRoot })).toBe(true);
    expect(run.commands).toHaveLength(2);
  });

  it('not confined when the outside write lands (the sandbox did nothing)', () => {
    expect(probeCodexWindowsSandbox({ codexBin: () => 'codex.exe', run: fakeRun(() => true), probeRoot })).toBe(false);
  });

  it('not confined when even the workspace write fails (read-only downgrade or no sandbox)', () => {
    const run = fakeRun(() => false);
    expect(probeCodexWindowsSandbox({ codexBin: () => 'codex.exe', run, probeRoot })).toBe(false);
    expect(run.commands).toHaveLength(1);
  });

  it('not confined when there is no codex binary, and nothing runs', () => {
    const run = fakeRun(() => true);
    expect(probeCodexWindowsSandbox({ codexBin: () => null, run, probeRoot })).toBe(false);
    expect(run.commands).toHaveLength(0);
  });
});

describe('resolveCodexBinary', () => {
  it('prefers CODEX_PATH_OVERRIDE, as the backend does', () => {
    expect(resolveCodexBinary({ CODEX_PATH_OVERRIDE: 'C:\\tools\\codex.exe' })).toBe('C:\\tools\\codex.exe');
  });

  it('knows no binary for an unknown arch', () => {
    expect(resolveCodexBinary({}, 'ia32')).toBeNull();
  });
});
