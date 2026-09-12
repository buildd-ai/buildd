import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * drizzle-kit detects a forked snapshot chain, refuses to generate anything, and
 * then calls `process.exit(0)`:
 *
 *   const abort = report.malformed.length || collisionEntries.length > 0;
 *   if (abort) { process.exit(0); }
 *
 * A generate that aborts writes nothing, which is indistinguishable from "no
 * changes needed" to `git status --porcelain drizzle/`. That is how CI's
 * migration check reported success while migration generation was blocked
 * outright on the branch — and why a release shipped with a forked chain nobody
 * had been told about.
 *
 * Fixed at the root with a bun patch (`patches/drizzle-kit@<version>.patch`)
 * turning that one call into `process.exit(1)`.
 *
 * THE REGRESSION THIS GUARDS, verified against a pristine tree rather than
 * assumed: `patchedDependencies` is keyed by EXACT version, and when the
 * installed version no longer matches that key, `bun install` applies nothing,
 * prints no warning, and EXITS 0. The dependency comes back unpatched with the
 * abort branch restored to `process.exit(0)` — the original blindness, reachable
 * by a routine version bump, with nothing anywhere to say so.
 *
 * (Do not assume bun validates the patch itself either: it applies hunks with
 * fuzz, so a patch whose removed line no longer exists still applies via its
 * context. A malformed patch is the benign case; a bumped version is not.)
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  patchedDependencies?: Record<string, string>;
};

describe('drizzle-kit exit-code patch', () => {
  it('registers a patch for drizzle-kit', () => {
    const patched = rootPkg.patchedDependencies ?? {};
    const keys = Object.keys(patched).filter((k) => k.startsWith('drizzle-kit@'));
    expect(
      keys,
      'drizzle-kit must stay patched: unpatched, it exits 0 after refusing to ' +
        'generate, so CI cannot tell a blocked generate from "no changes needed".'
    ).toHaveLength(1);
    expect(existsSync(join(ROOT, 'patches'))).toBe(true);
    expect(existsSync(join(ROOT, patched[keys[0]!]!))).toBe(true);
  });

  it('patches the exact version the lockfile resolves — a bump silently orphans it', () => {
    const key = Object.keys(rootPkg.patchedDependencies ?? {}).find((k) =>
      k.startsWith('drizzle-kit@')
    )!;
    const patchedVersion = key.slice('drizzle-kit@'.length);

    const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8');
    const resolved = /"drizzle-kit": \["drizzle-kit@([^"]+)"/.exec(lock)?.[1];

    expect(resolved, 'drizzle-kit not found in bun.lock').toBeDefined();
    expect(
      patchedVersion,
      `bun.lock resolves drizzle-kit@${resolved} but the patch targets ` +
        `${patchedVersion}. patchedDependencies is keyed by exact version, so ` +
        `this bump has silently dropped the exit-code fix. Re-apply it: ` +
        `bun patch drizzle-kit, change the abort branch's process.exit(0) to ` +
        `process.exit(1), bun patch --commit, and re-verify that a forked chain ` +
        `exits 1.`
    ).toBe(resolved);
  });

  it('is actually live in the installed dependency, not merely declared', () => {
    // The declarations above can all be correct while the dependency on disk is
    // unpatched — that is exactly what a version bump produces, silently. This
    // is the only assertion that proves the fix is in effect. `bun run test`
    // always follows an install, so the module is expected to be resolvable.
    const binPath = join(ROOT, 'packages', 'core', 'node_modules', 'drizzle-kit', 'bin.cjs');
    expect(
      existsSync(binPath),
      `drizzle-kit is not installed at ${binPath} — run bun install before the suite`
    ).toBe(true);

    const bin = readFileSync(binPath, 'utf8');
    const idx = bin.indexOf('const abort = report.malformed.length');
    expect(idx, 'the abort branch drizzle-kit patches has moved or vanished').toBeGreaterThan(-1);

    const branch = bin.slice(idx, idx + 160);
    expect(
      branch,
      'drizzle-kit is installed UNPATCHED: its abort branch still calls ' +
        'process.exit(0), so an aborted generate reports success. Most likely a ' +
        'version bump orphaned patches/drizzle-kit@<version>.patch — bun applies ' +
        'nothing and exits 0 when the patch key does not match the installed version.'
    ).toContain('process.exit(1)');
    expect(branch).not.toContain('process.exit(0)');
  });

  it('turns the abort branch from exit 0 into exit 1, and changes nothing else', () => {
    const patchDir = join(ROOT, 'patches');
    const file = readdirSync(patchDir).find((f) => f.startsWith('drizzle-kit@'))!;
    const patch = readFileSync(join(patchDir, file), 'utf8');

    const removed = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));

    expect(removed.every((l) => l.includes('process.exit(0)'))).toBe(true);
    expect(added.every((l) => l.includes('process.exit(1)'))).toBe(true);
    // bin.cjs is what `drizzle-kit generate` runs; utils.{js,mjs} carry the same
    // function for programmatic callers. Anything beyond these is scope creep in
    // a vendored patch and should be justified before this number moves.
    expect(added).toHaveLength(3);
    expect(patch).toContain('const abort = report.malformed.length');
  });
});
