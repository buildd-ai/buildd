import { describe, expect, test } from 'bun:test';
import { acpStatus, acpSnippets } from './acp-config';

const cap = { shimPath: '/home/a/.local/bin/buildd-acp', target: '/home/a/.buildd/apps/runner/src/acp/main.ts', pointsHere: true, version: '1.4.0', platform: 'linux', bunPath: '/usr/bin/bun', mainPath: '/home/a/.buildd/apps/runner/src/acp/main.ts' };

describe('acpStatus', () => {
  test('older runner reports nothing: unknown, never "no"', () => {
    const s = acpStatus(undefined);
    expect(s.state).toBe('unknown');
    expect(s.label).toBe('Unknown, update the runner');
  });
  test('shim for this install: ready', () => {
    expect(acpStatus(cap)).toMatchObject({ state: 'ready', label: 'Ready' });
  });
  test('shim for another checkout: names the path', () => {
    const s = acpStatus({ ...cap, pointsHere: false, target: '/tmp/buildd-ci/main.ts' });
    expect(s.state).toBe('elsewhere');
    expect(s.label).toBe('Shim points elsewhere');
    expect(s.detail).toContain('/tmp/buildd-ci/main.ts');
  });
  test('no shim yet on a host that writes one: shim points elsewhere is wrong, say unknown-update', () => {
    expect(acpStatus({ ...cap, shimPath: null, target: null, pointsHere: false }).state).toBe('unknown');
  });
});

describe('acpSnippets', () => {
  test('three setups, each with a command, none carrying a secret', () => {
    const sn = acpSnippets(cap, 'devbox');
    expect(sn.map(s => s.id)).toEqual(['local', 'ssh', 'on-host']);
    expect(sn[0].text).toBe('/home/a/.local/bin/buildd-acp');
    expect(sn[1].text).toBe('ssh -T -o BatchMode=yes user@devbox buildd acp');
    expect(sn[1].note).toContain('PATH');
    expect(sn[2].note).toContain('/mnt/c/');
    for (const s of sn) expect(s.text).not.toMatch(/bld_|token|key/i);
  });
  test('without a reported shim the local command is buildd-acp', () => {
    expect(acpSnippets(undefined, 'devbox')[0].text).toBe('buildd-acp');
  });
  test('Windows runner uses the direct bun command', () => {
    const sn = acpSnippets({ ...cap, platform: 'win32', shimPath: null, target: null, pointsHere: true, bunPath: 'C:\\bun\\bun.exe', mainPath: 'C:\\b\\main.ts' }, 'pc');
    expect(sn[0].text).toBe('"C:\\bun\\bun.exe" run "C:\\b\\main.ts"');
  });
});
