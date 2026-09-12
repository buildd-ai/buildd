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
 * THE REGRESSION THIS GUARDS is not someone deleting the patch — bun fails the
 * install loudly if a registered patch cannot be applied. It is a VERSION BUMP:
 * `patchedDependencies` is keyed by exact version, so bumping drizzle-kit
 * silently orphans the patch and restores the old blindness with nothing in the
 * output to say so. Hence the version cross-check below.
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
