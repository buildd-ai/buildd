/**
 * Windows DACL assertions for the runner's secret files. Mode bits say nothing
 * there (chmod is a no-op and statSync reports 0666), so these read the real
 * ACL with icacls. Only meaningful when process.platform === 'win32'.
 */
import { expect } from 'bun:test';
import { statSync } from 'fs';
import { join } from 'path';

export const IS_WINDOWS = process.platform === 'win32';

const system32 = (exe: string) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);

function run(argv: string[]): { exitCode: number; out: string } {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: r.exitCode ?? -1, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

/** Make `dir` behave like a folder on C:\: BUILTIN\Users may modify what is created in it. */
export function openToAllUsers(dir: string): void {
  const r = run([system32('icacls.exe'), dir, '/grant', '*S-1-5-32-545:(OI)(CI)(M)']);
  expect(r.exitCode).toBe(0);
}

/** The current user's account name as icacls prints it (`HOST\name`). */
export function currentAccountName(): string {
  const r = run([system32('whoami.exe'), '/user', '/fo', 'csv', '/nh']);
  return (r.out.trim().split(',')[0] ?? '').replace(/^"|"$/g, '');
}

/** The ACEs icacls lists for `path`, without the path prefix. */
export function aclEntries(path: string): string[] {
  const r = run([system32('icacls.exe'), path]);
  expect(r.exitCode).toBe(0);
  return r.out.split(/\r?\n/)
    .map(l => (l.startsWith(path) ? l.slice(path.length) : l).trim())
    .filter(l => /:\(/.test(l));
}

/**
 * `path` grants exactly one ACE, to the current user. `inherited: false` (an
 * explicit owner-only DACL) also requires that nothing is inherited; `true`
 * allows that one ACE to come from an owner-only directory above it.
 */
export function expectOwnerOnly(path: string, opts: { inherited?: boolean } = {}): void {
  const aces = aclEntries(path);
  const me = currentAccountName().toLowerCase();
  expect(aces).toHaveLength(1);
  expect(aces[0].toLowerCase().startsWith(`${me}:`)).toBe(true);
  expect(aces[0]).toContain('(F)');
  if (!opts.inherited) expect(aces[0]).not.toContain('(I)');
}

/** Owner-only, per platform: mode `posixMode` on POSIX, one owner ACE on Windows. */
export function expectOwnerOnlyPath(path: string, posixMode: number, opts: { inherited?: boolean } = {}): void {
  if (IS_WINDOWS) expectOwnerOnly(path, opts);
  else expect(statSync(path).mode & 0o777).toBe(posixMode);
}
