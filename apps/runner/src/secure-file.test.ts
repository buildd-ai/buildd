/**
 * `~/.buildd/config.json` stores a plaintext bld_* API key. It was written with
 * the process umask (commonly 0644 — readable by every account on the host),
 * unlike the runner's other credential writer, codex-auth.ts, which chmods to 0600.
 *
 * The pre-existing-file case is the one worth pinning: writeFileSync keeps the
 * mode of a file that already exists, so a config.json left behind by an older
 * runner would stay world-readable if the mode were only set at create time.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/src/secure-file.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeSecretJsonFile, SECRET_FILE_MODE, SECRET_DIR_MODE } from './secure-file';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'secure-file-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Permission bits only — statSync().mode carries the file type in high bits. */
const mode = (p: string) => statSync(p).mode & 0o777;
// Windows has no POSIX mode bits (the DACL decides); the ACL path is covered by
// __tests__/unit/secure-file.test.ts's real-icacls block.
const posixIt = it.skipIf(process.platform === 'win32');

describe('writeSecretJsonFile', () => {
  posixIt('creates the file owner-read/write only', () => {
    const f = join(root, 'nested', 'config.json');
    writeSecretJsonFile(f, { apiKey: 'bld_example' });
    expect(mode(f)).toBe(SECRET_FILE_MODE);
  });

  posixIt('creates missing parent directories owner-only', () => {
    const dir = join(root, 'nested');
    writeSecretJsonFile(join(dir, 'config.json'), {});
    expect(mode(dir)).toBe(SECRET_DIR_MODE);
  });

  posixIt('tightens a file that already exists with wider permissions', () => {
    const f = join(root, 'config.json');
    writeFileSync(f, '{"stale":true}');
    chmodSync(f, 0o644);
    expect(mode(f)).toBe(0o644); // precondition: the state an older runner left

    writeSecretJsonFile(f, { apiKey: 'bld_example' });
    expect(mode(f)).toBe(SECRET_FILE_MODE);
  });

  posixIt('tightens a directory that already exists with wider permissions', () => {
    const dir = join(root, 'nested');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    writeSecretJsonFile(join(dir, 'config.json'), {});
    expect(mode(dir)).toBe(SECRET_DIR_MODE);
  });

  it('writes readable pretty JSON (the file is user-editable by design)', () => {
    const f = join(root, 'config.json');
    writeSecretJsonFile(f, { apiKey: 'bld_example', builddServer: 'https://buildd.dev' });
    const raw = readFileSync(f, 'utf-8');
    expect(raw).toContain('\n  "apiKey"');
    expect(JSON.parse(raw)).toEqual({ apiKey: 'bld_example', builddServer: 'https://buildd.dev' });
  });

  posixIt('is not group- or world-readable under a permissive umask', () => {
    const prev = process.umask(0o000);
    try {
      const f = join(root, 'umask.json');
      writeSecretJsonFile(f, { apiKey: 'bld_example' });
      expect(mode(f) & 0o077).toBe(0);
    } finally {
      process.umask(prev);
    }
  });
});
