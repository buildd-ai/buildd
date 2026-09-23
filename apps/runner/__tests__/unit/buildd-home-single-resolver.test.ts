/**
 * The runner home is resolved in exactly one place: `src/buildd-home.ts`.
 *
 * The test-runtime guard only protects code that goes through
 * `resolveBuilddHome()`. A module that re-derives the home inline
 * (`BUILDD_HOME || ~/.buildd`, or a bare `homedir()/.buildd`) silently opts
 * out of it, and from a raw `bun test` that module reads — or, for the
 * updater, `git reset --hard`s — the operator's real install.
 *
 * Each allowlisted file says why it is not a store under the guard yet. Remove
 * an entry when its file is migrated; do not add one to make this pass.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/buildd-home-single-resolver.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(import.meta.dir, '..', '..', 'src');

const ALLOWLIST: Record<string, string> = {
  'buildd-home.ts': 'the resolver itself',
  // Takes an explicit env and is imported by raw-`bun test` integration
  // files that do not set BUILDD_HOME; it only reads a token file.
  'local-server-auth.ts': 'env-injected token lookup, not a store',
  // Follow-ups: both ignore BUILDD_HOME entirely today, so routing them through
  // the resolver changes where production reads/writes, not just test safety.
  // roles.ts is also owned by an in-flight PR.
  'roles.ts': 'follow-up: role checkouts ignore BUILDD_HOME',
  'login.ts': 'follow-up: login config ignores BUILDD_HOME',
};

// Matches `BUILDD_HOME ||`, `BUILDD_HOME ??`, and `homedir(), '.buildd'`.
const INLINE_HOME = /BUILDD_HOME\s*(\|\||\?\?)|homedir\(\)\s*,\s*['"]\.buildd['"]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('runner home resolution', () => {
  test('no runner module outside the allowlist resolves BUILDD_HOME inline', () => {
    const offenders = walk(SRC)
      .map(p => relative(SRC, p))
      .filter(rel => !(rel in ALLOWLIST))
      .filter(rel => INLINE_HOME.test(readFileSync(join(SRC, rel), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  test('every allowlist entry still exists and still needs its exemption', () => {
    // A stale entry would let a future regression in that file through unseen.
    const stale = Object.keys(ALLOWLIST)
      .filter(rel => rel !== 'buildd-home.ts')
      .filter(rel => {
        try { return !INLINE_HOME.test(readFileSync(join(SRC, rel), 'utf-8')); }
        catch { return true; }
      });
    expect(stale).toEqual([]);
  });

  test('the pattern catches the forms it is meant to catch', () => {
    expect(INLINE_HOME.test("process.env.BUILDD_HOME || join(homedir(), '.buildd')")).toBe(true);
    expect(INLINE_HOME.test("join(homedir(), '.buildd', 'roles')")).toBe(true);
    expect(INLINE_HOME.test('env.BUILDD_HOME ?? x')).toBe(true);
    expect(INLINE_HOME.test('resolveBuilddHome()')).toBe(false);
  });
});
