import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ACP_SHIM_MARKER, acpShimScript, ensureAcpShim } from '../../src/acp/shim';

function home() {
  return mkdtempSync(join(tmpdir(), 'acp-shim-'));
}

const opts = (h: string) => ({ home: h, bunPath: '/opt/bun/bin/bun', mainPath: '/srv/buildd/apps/runner/src/acp/main.ts', installDir: '/srv/buildd', platform: 'linux' });

describe('acpShimScript', () => {
  test('execs the bridge with bun, passes args through, and carries the marker', () => {
    const s = acpShimScript('/opt/bun/bin/bun', '/srv/buildd/apps/runner/src/acp/main.ts');
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain(ACP_SHIM_MARKER);
    expect(s).toContain(`exec '/opt/bun/bin/bun' run '/srv/buildd/apps/runner/src/acp/main.ts' "$@"`);
  });

  test('quotes a path with a single quote safely', () => {
    expect(acpShimScript("/h/o'k/bun", '/m.ts')).toContain(`exec '/h/o'\\''k/bun' run '/m.ts' "$@"`);
  });
});

describe('ensureAcpShim', () => {
  test('writes an executable ~/.local/bin/buildd-acp', () => {
    const h = home();
    try {
      expect(ensureAcpShim(opts(h))).toBe('written');
      const p = join(h, '.local', 'bin', 'buildd-acp');
      expect(readFileSync(p, 'utf8')).toContain('acp/main.ts');
      // Windows has no exec bit; the shim is never written there in practice.
      if (process.platform !== 'win32') expect(statSync(p).mode & 0o111).not.toBe(0);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('leaves an identical shim alone', () => {
    const h = home();
    try {
      ensureAcpShim(opts(h));
      expect(ensureAcpShim(opts(h))).toBe('unchanged');
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('rewrites its own shim when the paths moved', () => {
    const h = home();
    try {
      ensureAcpShim(opts(h));
      expect(ensureAcpShim({ ...opts(h), bunPath: '/usr/local/bin/bun' })).toBe('written');
      expect(readFileSync(join(h, '.local', 'bin', 'buildd-acp'), 'utf8')).toContain('/usr/local/bin/bun');
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('never overwrites a buildd-acp it did not write', () => {
    const h = home();
    try {
      const dir = join(h, '.local', 'bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'buildd-acp'), '#!/bin/sh\necho mine\n');
      chmodSync(join(dir, 'buildd-acp'), 0o755);
      expect(ensureAcpShim(opts(h))).toBe('foreign');
      expect(readFileSync(join(dir, 'buildd-acp'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('writes nothing on Windows, where ACP clients cannot launch a script', () => {
    const h = home();
    try {
      expect(ensureAcpShim({ ...opts(h), platform: 'win32' })).toBe('skipped');
      expect(existsSync(join(h, '.local', 'bin', 'buildd-acp'))).toBe(false);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('leaves the shim alone when this runner is not the installed one', () => {
    // CI's integration job checks buildd out to /tmp/buildd-ci on a machine with
    // a real install and starts a runner there; that runner used to repoint the
    // shim at a checkout that is deleted minutes later.
    const h = home();
    try {
      ensureAcpShim(opts(h));
      const before = readFileSync(join(h, '.local', 'bin', 'buildd-acp'), 'utf8');
      expect(ensureAcpShim({ ...opts(h), mainPath: '/tmp/buildd-ci/apps/runner/src/acp/main.ts' })).toBe('skipped');
      expect(readFileSync(join(h, '.local', 'bin', 'buildd-acp'), 'utf8')).toBe(before);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('a sibling directory sharing the install prefix is not the install', () => {
    const h = home();
    try {
      expect(ensureAcpShim({ ...opts(h), mainPath: '/srv/buildd-ci/apps/runner/src/acp/main.ts' })).toBe('skipped');
      expect(existsSync(join(h, '.local', 'bin', 'buildd-acp'))).toBe(false);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });
});

describe('acpCapability (reported in the environment scan)', () => {
  const base = (h: string) => ({ home: h, bunPath: '/opt/bun/bin/bun', mainPath: '/srv/buildd/apps/runner/src/acp/main.ts', installDir: '/srv/buildd', platform: 'linux', version: '1.2.3' });
  const { acpCapability } = require('../../src/acp/shim');

  test('shim written by this install: points here, reports path and version', () => {
    const h = home();
    try {
      ensureAcpShim(opts(h));
      const cap = acpCapability(base(h));
      expect(cap.shimPath).toBe(join(h, '.local', 'bin', 'buildd-acp'));
      expect(cap.target).toBe('/srv/buildd/apps/runner/src/acp/main.ts');
      expect(cap.pointsHere).toBe(true);
      expect(cap.version).toBe('1.2.3');
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('shim left by another checkout does not point here', () => {
    const h = home();
    try {
      mkdirSync(join(h, '.local', 'bin'), { recursive: true });
      writeFileSync(join(h, '.local', 'bin', 'buildd-acp'), acpShimScript('/opt/bun/bin/bun', '/tmp/buildd-ci/apps/runner/src/acp/main.ts'));
      const cap = acpCapability(base(h));
      expect(cap.pointsHere).toBe(false);
      expect(cap.target).toBe('/tmp/buildd-ci/apps/runner/src/acp/main.ts');
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('a foreign file has no target and no match; a missing shim has no path', () => {
    const h = home();
    try {
      expect(acpCapability(base(h)).shimPath).toBeNull();
      mkdirSync(join(h, '.local', 'bin'), { recursive: true });
      writeFileSync(join(h, '.local', 'bin', 'buildd-acp'), '#!/bin/sh\necho mine\n');
      const cap = acpCapability(base(h));
      expect(cap.target).toBeNull();
      expect(cap.pointsHere).toBe(false);
    } finally { rmSync(h, { recursive: true, force: true }); }
  });

  test('Windows has no shim and uses the direct command', () => {
    const cap = acpCapability({ ...base(home()), platform: 'win32' });
    expect(cap.shimPath).toBeNull();
    expect(cap.pointsHere).toBe(true);
  });
});
