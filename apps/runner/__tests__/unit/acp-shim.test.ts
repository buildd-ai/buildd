import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ACP_SHIM_MARKER, acpShimScript, ensureAcpShim } from '../../src/acp/shim';

function home() {
  return mkdtempSync(join(tmpdir(), 'acp-shim-'));
}

const opts = (h: string) => ({ home: h, bunPath: '/opt/bun/bin/bun', mainPath: '/srv/buildd/apps/runner/src/acp/main.ts', platform: 'linux' });

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
      expect(statSync(p).mode & 0o111).not.toBe(0);
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
});
