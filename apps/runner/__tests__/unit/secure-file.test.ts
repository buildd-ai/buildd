import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _resetOwnerAclCache,
  ownerOnlyAclCommand,
  restrictDirToOwnerOnce,
  restrictToOwnerAcl,
  tryRestrictToOwnerAcl,
  writeSecretJsonFile,
} from '../../src/secure-file';
import { IS_WINDOWS, aclEntries, expectOwnerOnly, openToAllUsers } from '../windows-acl';

const SID = 'S-1-5-21-1-2-3-1001';

beforeEach(() => _resetOwnerAclCache());

// chmod and writeFileSync({ mode }) do nothing to who may read a file on
// Windows: the DACL does, and a new file inherits its directory's. These pin
// the icacls argv and the platform dispatch, and run on every platform.
describe('owner-only ACL helper', () => {
  test('a file: drop inheritance, grant the owner alone', () => {
    expect(ownerOnlyAclCommand('C:\\h\\config.json', SID)).toEqual([
      'icacls', 'C:\\h\\config.json', '/inheritance:r', '/grant:r', `*${SID}:(F)`,
    ]);
  });

  test('a directory: the owner grant inherits to files and subdirectories', () => {
    expect(ownerOnlyAclCommand('C:\\h\\gh', SID, { inherit: true })).toEqual([
      'icacls', 'C:\\h\\gh', '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)(F)`,
    ]);
  });

  test('POSIX: nothing runs (the caller keeps its chmod)', () => {
    const calls: string[][] = [];
    const run = (argv: string[]) => { calls.push(argv); return { exitCode: 0, output: '' }; };
    for (const platform of ['linux', 'darwin'] as const) {
      expect(restrictToOwnerAcl('/h/config.json', { platform, run, sid: () => SID })).toBe(false);
      expect(restrictDirToOwnerOnce('/h', { platform, run, sid: () => SID })).toBe(false);
      expect(tryRestrictToOwnerAcl('/h', { platform, run, sid: () => SID, directory: true })).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  test('Windows: a file gets the file ACL', () => {
    const calls: string[][] = [];
    expect(restrictToOwnerAcl('C:\\h\\config.json', {
      platform: 'win32', sid: () => SID,
      run: argv => { calls.push(argv); return { exitCode: 0, output: '' }; },
    })).toBe(true);
    expect(calls).toEqual([ownerOnlyAclCommand('C:\\h\\config.json', SID)]);
  });

  test('Windows: an icacls failure throws, and so does a missing SID', () => {
    expect(() => restrictToOwnerAcl('C:\\h\\config.json', {
      platform: 'win32', sid: () => SID, run: () => ({ exitCode: 5, output: 'Access is denied.' }),
    })).toThrow(/Access is denied/);
    expect(() => restrictToOwnerAcl('C:\\h\\config.json', {
      platform: 'win32', sid: () => null, run: () => ({ exitCode: 0, output: '' }),
    })).toThrow(/SID/);
  });

  test('Windows: a directory is restricted once per process, not on every rewrite', () => {
    const calls: string[][] = [];
    const deps = { platform: 'win32' as const, sid: () => SID, run: (argv: string[]) => { calls.push(argv); return { exitCode: 0, output: '' }; } };
    restrictDirToOwnerOnce('C:\\h\\gh', deps);
    restrictDirToOwnerOnce('C:\\h\\gh', deps);
    restrictDirToOwnerOnce('C:\\H\\GH', deps);
    expect(calls).toEqual([ownerOnlyAclCommand('C:\\h\\gh', SID, { inherit: true })]);
  });

  test('Windows: a directory that failed is tried again next time', () => {
    let exitCode = 5;
    const calls: string[][] = [];
    const deps = { platform: 'win32' as const, sid: () => SID, run: (argv: string[]) => { calls.push(argv); return { exitCode, output: 'denied' }; } };
    expect(() => restrictDirToOwnerOnce('C:\\h\\gh', deps)).toThrow(/denied/);
    exitCode = 0;
    restrictDirToOwnerOnce('C:\\h\\gh', deps);
    expect(calls).toHaveLength(2);
  });

  test('best-effort form: a failure is logged once per path and does not throw', () => {
    const warnings: string[] = [];
    const deps = { platform: 'win32' as const, sid: () => SID, run: () => ({ exitCode: 5, output: 'Access is denied.' }), warn: (m: string) => warnings.push(m) };
    expect(tryRestrictToOwnerAcl('C:\\h', { ...deps, directory: true })).toBe(false);
    expect(tryRestrictToOwnerAcl('C:\\h', { ...deps, directory: true })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Access is denied');
  });
});

describe('writeSecretJsonFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secure-file-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('writes the JSON', () => {
    const file = join(dir, 'home', 'config.json');
    writeSecretJsonFile(file, { apiKey: 'bld_test' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ apiKey: 'bld_test' });
  });

  test.skipIf(IS_WINDOWS)('POSIX: the file is 0600 and its directory 0700', () => {
    const file = join(dir, 'home', 'config.json');
    writeSecretJsonFile(file, { apiKey: 'bld_test' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
  });

  test.skipIf(!IS_WINDOWS)('Windows: in a directory every user may write, config.json grants only its owner', () => {
    openToAllUsers(dir);
    const home = join(dir, 'home');
    mkdirSync(home);
    // Written by an older runner: inherits BUILTIN\Users from the open parent.
    writeFileSync(join(home, 'config.json'), '{}');
    expect(aclEntries(join(home, 'config.json')).length).toBeGreaterThan(1);
    writeSecretJsonFile(join(home, 'config.json'), { apiKey: 'bld_test' });
    expectOwnerOnly(join(home, 'config.json'));
    expectOwnerOnly(home);
  });
});

describe.skipIf(!IS_WINDOWS)('restrictDirToOwnerOnce on Windows (real icacls)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secure-dir-')); openToAllUsers(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('files already there, created later, and renamed in later are all owner-only', () => {
    const d = join(dir, 'scoped');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'sub', 'before'), 'x');
    restrictDirToOwnerOnce(d);
    expectOwnerOnly(d);
    expectOwnerOnly(join(d, 'sub', 'before'), { inherited: true });
    writeFileSync(join(d, 'sub', 'after'), 'x');
    expectOwnerOnly(join(d, 'sub', 'after'), { inherited: true });
    // An atomic rewrite: temp file inside the restricted dir, renamed over the target.
    writeFileSync(join(d, 'sub', 'after.tmp'), 'y');
    renameSync(join(d, 'sub', 'after.tmp'), join(d, 'sub', 'after'));
    expectOwnerOnly(join(d, 'sub', 'after'), { inherited: true });
  });

  test('a temp file made OUTSIDE the restricted dir keeps its open ACL when renamed in (why writers create temps inside)', () => {
    const d = join(dir, 'scoped');
    mkdirSync(d);
    restrictDirToOwnerOnce(d);
    writeFileSync(join(dir, 'outside.tmp'), 'y');
    renameSync(join(dir, 'outside.tmp'), join(d, 'moved'));
    expect(aclEntries(join(d, 'moved')).length).toBeGreaterThan(1);
  });
});
