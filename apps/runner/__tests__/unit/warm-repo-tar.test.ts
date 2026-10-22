/**
 * The cache tarball's tar calls, run against the real `tar` on PATH.
 *
 * On Windows that is often Git for Windows' GNU tar, which reads an archive
 * argument like `C:\...` as a remote `host:path` ("Cannot connect to C:
 * resolve failed"), and unquotes `-C` operands and `-T` names, so a `\1` or
 * `\t` in a backslashed path turns into a control character. The directories
 * below are named to hit both. On Linux and macOS the same tests are plain
 * round trips.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cacheExtractCommand, createCacheTarball, tarPathArg, writeCacheFileList } from '../../src/warm-repo';

let dir: string;

beforeEach(() => {
  // `1warm` and `t...`/`n...` make `\1`, `\t` and `\n` once joined with backslashes.
  dir = join(mkdtempSync(join(tmpdir(), 'warm-tar-')), '1warm');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

function seedCache(): string {
  const cacheDir = join(dir, 'tcache');
  mkdirSync(join(cacheDir, 'b', 'n'), { recursive: true });
  writeFileSync(join(cacheDir, 'b', 'n', 't.js'), 'module.exports = 1;\n');
  writeFileSync(join(cacheDir, 'top.txt'), 'top\n');
  return cacheDir;
}

describe('tarPathArg', () => {
  test('Windows paths go to tar with forward slashes', () => {
    expect(tarPathArg('C:\\Users\\x\\1warm\\tcache', 'win32')).toBe('C:/Users/x/1warm/tcache');
  });

  test('elsewhere a path is passed through unchanged', () => {
    expect(tarPathArg('/tmp/a\\b', 'linux')).toBe('/tmp/a\\b');
    expect(tarPathArg('/tmp/a\\b', 'darwin')).toBe('/tmp/a\\b');
  });
});

describe('cache tarball against the real tar', () => {
  test('writeCacheFileList names files with forward slashes', () => {
    const cacheDir = seedCache();
    const list = writeCacheFileList(cacheDir, join(dir, 'files.list'))!;
    const names = readFileSync(list, 'utf-8').split('\n').filter(Boolean).sort();
    expect(names).toEqual(['b/n/t.js', 'top.txt']);
  });

  test('createCacheTarball writes an archive at an absolute path', () => {
    const cacheDir = seedCache();
    const out = join(dir, 'tout', 'cache.tar');
    mkdirSync(join(dir, 'tout'), { recursive: true });
    expect(createCacheTarball(cacheDir, out)).toBe(true);
    expect(existsSync(out)).toBe(true);
    const names = execFileSync('tar', ['-tf', 'cache.tar'], { cwd: join(dir, 'tout'), encoding: 'utf-8' })
      .split('\n').filter(Boolean).sort();
    expect(names).toEqual(['b/n/t.js', 'top.txt']);
    expect(existsSync(`${out}.list`)).toBe(false);
  });

  test('the cache extract command restores the archive into an absolute cache dir', () => {
    const cacheDir = seedCache();
    const out = join(dir, 'cache.tar');
    expect(createCacheTarball(cacheDir, out)).toBe(true);

    const restored = join(dir, 'nrestored');
    mkdirSync(restored, { recursive: true });
    const [command, args] = cacheExtractCommand(restored, false);
    const r = spawnSync(command, args, { input: readFileSync(out), encoding: 'utf-8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(join(restored, 'b', 'n', 't.js'), 'utf-8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(restored, 'top.txt'), 'utf-8')).toBe('top\n');
  });

  const hasZstd = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
  test.skipIf(!hasZstd)('the zstd extract command restores an uncompressed archive too', () => {
    const cacheDir = seedCache();
    const out = join(dir, 'cache.tar');
    expect(createCacheTarball(cacheDir, out)).toBe(true);

    const restored = join(dir, 'nrestored');
    mkdirSync(restored, { recursive: true });
    const [command, args] = cacheExtractCommand(restored, true);
    const r = spawnSync(command, args, { input: readFileSync(out), encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(restored, 'b', 'n', 't.js'), 'utf-8')).toBe('module.exports = 1;\n');
  });
});
