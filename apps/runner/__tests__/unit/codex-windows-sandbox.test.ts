import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { probeCodexWindowsSandbox, probeCodexWindowsModes, verifiedWindowsSandboxConfig, resolveCodexBinary, type CodexSandboxRun } from '../../src/codex-windows-sandbox';

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
    const rel = /> ([^\s)]+)/.exec(command)?.[1];
    const target = rel ? resolve(cwd, rel.replace(/\\/g, '/')) : null;
    if (!target || !allow(target, cwd)) return true;
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
    expect(run.commands.length).toBeGreaterThan(0);
  });

  it('not confined when there is no codex binary, and nothing runs', () => {
    const run = fakeRun(() => true);
    expect(probeCodexWindowsSandbox({ codexBin: () => null, run, probeRoot })).toBe(false);
    expect(run.commands).toHaveLength(0);
  });
});

// Extended from the recovered tests-first draft: command success must be
// independent of the attempted write, including read-only's positive control.
describe('per-mode Windows probes', () => {
  const simulated = (failMxc = false): CodexSandboxRun => (_bin, cwd, _home, command, implementation, mode) => {
    if (failMxc && implementation === 'mxc') return false;
    const rel = /> ([^\s)]+)/.exec(command)?.[1];
    if (rel === 'inside.txt' && mode === 'workspace-write') writeFileSync(join(cwd, rel), 'ok');
    return true;
  };
  it('prefers explicit MXC and checks both permission modes independently', () => {
    const result = probeCodexWindowsModes({ codexBin: () => 'codex.exe', probeRoot, run: simulated() });
    expect(result['workspace-write']).toBe('mxc');
    expect(result['read-only']).toBe('mxc');
  });
  it('falls back only to unelevated, never elevated provisioning', () => {
    const result = probeCodexWindowsModes({ codexBin: () => 'codex.exe', probeRoot, run: simulated(true) });
    expect(result).toEqual({ 'read-only': 'unelevated', 'workspace-write': 'unelevated' });
  });
  it('a failed negative-control command is not proof of confinement', () => {
    const run: CodexSandboxRun = (...args) => args[3].includes('escaped.txt') ? false : simulated()(...args);
    expect(probeCodexWindowsModes({ codexBin: () => 'codex.exe', probeRoot, run }))
      .toEqual({ 'read-only': null, 'workspace-write': null });
  });
  it('does not copy workspace-write capability into read-only', () => {
    const run: CodexSandboxRun = (...args) => args[5] === 'read-only' ? false : simulated()(...args);
    expect(probeCodexWindowsModes({ codexBin: () => 'codex.exe', probeRoot, run }))
      .toEqual({ 'read-only': null, 'workspace-write': 'mxc' });
  });
  it('rejects a sandbox that allows every write in either mode', () => {
    expect(probeCodexWindowsModes({ codexBin: () => 'codex.exe', probeRoot, run: fakeRun(() => true) }))
      .toEqual({ 'read-only': null, 'workspace-write': null });
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

describe('worker configuration binding', () => {
  it('rechecks the exact executable, home, implementation and permission mode', () => {
    const calls: unknown[][] = [];
    const home = probeRoot();
    const config = verifiedWindowsSandboxConfig('worker.exe', home, 'read-only', 'mxc', {
      probeRoot, run: (...args) => { calls.push(args); return true; },
    });
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect([args[0], args[2], args[4], args[5]]).toEqual(['worker.exe', home, 'mxc', 'read-only']);
    }
    expect(config).toEqual({ windows: { sandbox: 'mxc' }, features: { prefer_mxc: false }, sandbox_workspace_write: { network_access: true } });
  });
  it('never falls back after a selected implementation fails at startup', () => {
    const calls: string[] = [];
    expect(() => verifiedWindowsSandboxConfig('worker.exe', probeRoot(), 'workspace-write', 'mxc', {
      probeRoot, run: (_b, _c, _h, _cmd, impl) => { calls.push(impl!); return false; },
    })).toThrow(/sandbox.*failed/i);
    expect(calls).toEqual(['mxc']);
  });
});
