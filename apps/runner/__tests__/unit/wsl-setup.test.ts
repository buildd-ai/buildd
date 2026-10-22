import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { WSL_RUNTIME_PROBE, inspectWsl, parseDistributions, type CommandResult } from '../../src/wsl-setup';
const ok = (stdout: string): CommandResult => ({ code: 0, stdout });
const listing = '  NAME STATE VERSION\n* Ubuntu Running 2\n  Debian Stopped 1\n';
describe('WSL setup preflight', () => {
  test('decodes Windows UTF-16 output and selects WSL2 only', () => {
    expect(parseDistributions(listing.split('').join('\0'))).toEqual([{ name: 'Ubuntu', version: 2 }, { name: 'Debian', version: 1 }]);
  });
  test('does not invoke WSL on other platforms', () => {
    expect(inspectWsl('linux', undefined, () => { throw Error('called'); }).code).toBe(1);
  });
  test('access denied is not reported as no distributions', () => {
    const r = inspectWsl('win32', undefined, () => ({ code: 1, stdout: 'E_ACCESSDENIED' }));
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('same Windows user');
    expect(r.lines.join('\n')).not.toContain('wsl --install');
  });
  test('missing WSL gives an explicit installation step', () => {
    const r = inspectWsl('win32', undefined, () => ({ code: 1, stdout: '', missing: true }));
    expect(r.lines.join('\n')).toContain('wsl --install -d Ubuntu');
  });
  test('WSL1 selection requires conversion and does not launch it', () => {
    let calls = 0;
    const r = inspectWsl('win32', 'Debian', () => { calls++; return ok(listing); });
    expect(calls).toBe(1);
    expect(r.lines.join('\n')).toContain('wsl --set-version "Debian" 2');
  });
  test('ambiguous WSL2 selection asks for a distribution', () => {
    const r = inspectWsl('win32', undefined, () => ok(listing + '  Other Stopped 2\n'));
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('--distro');
  });
  test('runs only fixed probes with distribution passed as an argument', () => {
    const calls: string[][] = [];
    const r = inspectWsl('win32', 'Ubuntu', (_file, args) => {
      calls.push(args);
      return calls.length === 1 ? ok(listing) : ok('BUILDD_WSL_SETUP=git,curl,bun,bwrap,socat,claude,runner\n');
    });
    expect(r.code).toBe(0);
    expect(calls[1].slice(0, 5)).toEqual(['--distribution', 'Ubuntu', '--exec', 'sh', '-lc']);
    expect(calls[1][5]).not.toMatch(/apt|install|sysctl|firewall/);
    expect(r.lines.join('\n')).toContain('not confinement verification');
  });
  test('missing runtimes and failed distro execution remain blocked', () => {
    const run = (result: CommandResult) => { let n = 0; return inspectWsl('win32', 'Ubuntu', () => ++n === 1 ? ok(listing) : result); };
    expect(run(ok('BUILDD_WSL_SETUP=git,curl\n')).code).toBe(1);
    expect(run({ code: 1, stdout: 'failed' }).code).toBe(1);
    expect(run(ok('unexpected')).code).toBe(1);
  });
  test('no distributions and unknown selection produce distinct guidance', () => {
    expect(inspectWsl('win32', undefined, () => ok('')).lines.join('\n')).toContain('wsl --install');
    expect(inspectWsl('win32', 'Unknown', () => ok(listing)).lines.join('\n')).toContain('not found');
  });
  test('probe finds tools in standard user bin dirs with a minimal PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'wsl-probe-'));
    try {
      for (const [dir, tools] of [['.bun/bin', ['bun']], ['.local/bin', ['claude']], ['sysbin', ['git', 'curl', 'bwrap', 'socat']]] as const) {
        mkdirSync(join(home, dir), { recursive: true });
        for (const t of tools) { writeFileSync(join(home, dir, t), '#!/bin/sh\n'); chmodSync(join(home, dir, t), 0o755); }
      }
      const run = (path: string) => spawnSync('sh', ['-c', WSL_RUNTIME_PROBE], { env: { HOME: home, PATH: path }, encoding: 'utf8' }).stdout;
      const found = run(`${join(home, 'sysbin')}:/usr/bin:/bin`);
      expect(found).toContain('bun,');
      expect(found).toContain('claude,');
      // Windows-mounted executables stay rejected
      mkdirSync(join(home, 'mnt'));
      writeFileSync(join(home, 'mnt', 'bun.exe'), '#!/bin/sh\n'); chmodSync(join(home, 'mnt', 'bun.exe'), 0o755);
      expect(run(`${join(home, 'sysbin')}:/usr/bin:/bin`)).not.toContain('bun.exe');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
