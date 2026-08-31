import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for finding C33: nothing protected the production migrate step.
 *
 * Migrations reach production exactly one way — the `db:migrate &&` prefix on
 * `apps/web`'s `build` script, which Vercel runs on deploy (migration doctrine
 * Rule 2). Nothing parsed that file. CI builds with `build:only` (no migrate),
 * and the one `db:migrate` step in build.yml is a different invocation against a
 * Neon preview branch. So deleting the prefix shipped green and would surface
 * only as a silent no-migrate production deploy: the code that reads a new
 * column goes live while the column does not exist.
 *
 * These tests are also reachable from `bun run migrations:lint`, which the
 * pre-commit hook runs on every commit regardless of which files changed.
 * That matters because scripts/affected-tests.sh maps changed `.ts` files to
 * tests: a PR that only edits `apps/web/package.json` resolves to SKIP, so a CI
 * unit-test run alone would not see this.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

describe('production build runs migrations', () => {
  const webPkg = readJson('apps/web/package.json');
  const buildScript: string = webPkg.scripts?.build ?? '';

  it('apps/web build script runs db:migrate before next build', () => {
    console.log(`apps/web build script measured as: ${JSON.stringify(buildScript)}`);

    expect(
      buildScript,
      'apps/web/package.json "build" no longer runs db:migrate. This is the ONLY path by ' +
        'which migrations reach production (Vercel runs it on deploy). Restore ' +
        '"bun run db:migrate && next build". If migrations genuinely moved elsewhere, ' +
        'update this test to assert the new carrier — do not delete it.',
    ).toContain('db:migrate');

    const migrateAt = buildScript.indexOf('db:migrate');
    const nextBuildAt = buildScript.indexOf('next build');
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(nextBuildAt).toBeGreaterThan(migrateAt);
    // `&&`, not `;` or `&`: a failed migration must abort the build rather than
    // let a deploy proceed against an un-migrated database.
    expect(buildScript.slice(migrateAt, nextBuildAt)).toContain('&&');
  });

  it('apps/web db:migrate points at a migrate entrypoint that exists', () => {
    const dbMigrate: string = webPkg.scripts?.['db:migrate'] ?? '';
    expect(dbMigrate).toContain('packages/core/db/migrate.ts');

    const target = join(REPO_ROOT, 'packages/core/db/migrate.ts');
    expect(existsSync(target), `${target} does not exist`).toBe(true);
  });

  it('the root build script still delegates to @buildd/web build', () => {
    // Vercel may invoke the root or the app build depending on the project's
    // Root Directory setting; both have to reach the migrating script.
    const rootBuild: string = readJson('package.json').scripts?.build ?? '';
    expect(rootBuild).toContain('@buildd/web');
    expect(rootBuild).toContain('build');
    expect(rootBuild).not.toContain('build:only');
  });

  it('vercel.json does not override the build command', () => {
    // A buildCommand here would bypass package.json entirely and silently
    // un-hook migrations from the deploy.
    const vercel = readJson('vercel.json');
    expect(
      vercel.buildCommand,
      'vercel.json now sets buildCommand, which overrides the package.json build ' +
        'script this test guards. Make sure the new command runs db:migrate, then ' +
        'assert that here instead.',
    ).toBeUndefined();
  });

  it('build:only exists and deliberately does NOT migrate (that is what CI uses)', () => {
    const buildOnly: string = webPkg.scripts?.['build:only'] ?? '';
    expect(buildOnly).toContain('next build');
    expect(buildOnly).not.toContain('db:migrate');
  });
});
