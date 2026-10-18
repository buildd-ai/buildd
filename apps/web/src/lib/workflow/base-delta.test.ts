import { describe, expect, test } from 'bun:test';
import { TREADMILL_EXHAUSTED_MAX_BASE_COMMITS, isRiskyLandingPath, judgeBaseDelta, versionBumpManifests } from './base-delta';
import { TREADMILL_EXHAUSTED_MAX_BASE_COMMITS as LEGACY } from '../pr-landing';
import { isGeneratedMigrationPath } from '../migration-safety';

describe('isRiskyLandingPath: where "unrelated" is never a safe assumption', () => {
  test.each([
    'packages/core/drizzle/0300_add_column.sql',
    'packages/core/db/schema.ts',
    'bun.lock', 'bun.lockb', 'apps/web/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'package.json', 'apps/runner/package.json',
    '.github/workflows/build.yml',
    'scripts/no-em-dash-copy.test.ts',
  ])('%s is risky', (p) => expect(isRiskyLandingPath(p)).toBe(true));

  test.each([
    'apps/web/src/lib/foo.ts',
    'packages/core/drizzle/meta/_journal.json.md',
    'docs/specs/workflow-state-kernel.md',
    'scripts/ci/neon-sql-shim.ts',
    'apps/web/src/lib/foo.test.ts',
  ])('%s is not', (p) => expect(isRiskyLandingPath(p)).toBe(false));

  test.each(['packages/core/drizzle/0300_x.sql', 'drizzle/0001_a.sql', 'packages/core/drizzle/meta/0300_snapshot.json', 'drizzle/x.sql', 'packages/core/drizzle/20261012120000_x/migration.sql', 'packages/core/drizzle/20261012120000_x/snapshot.json'])(
    'the migration pattern agrees with migration-safety for %s', (p) => expect(isRiskyLandingPath(p)).toBe(isGeneratedMigrationPath(p)));
});

describe('judgeBaseDelta', () => {
  const fact = { baseCommits: 4, baseFiles: ['src/x.ts'], prFiles: ['src/a.ts'] };

  test('a small, listable, disjoint, risk-free gap is tolerated', () => {
    expect(judgeBaseDelta(fact, 4)).toEqual({ tolerated: true, baseCommits: 4, baseFileCount: 1 });
  });

  test('a gap over the bound or unreadable is refresh_exhausted', () => {
    expect(judgeBaseDelta(fact, 3)).toMatchObject({ tolerated: false, cause: 'refresh_exhausted' });
    expect(judgeBaseDelta({ ...fact, baseCommits: null }, 20)).toMatchObject({ tolerated: false, cause: 'refresh_exhausted' });
    expect(judgeBaseDelta({ ...fact, baseFiles: null }, 20)).toMatchObject({ tolerated: false, cause: 'refresh_exhausted' });
    expect(judgeBaseDelta({ ...fact, prFiles: null }, 20)).toMatchObject({ tolerated: false, cause: 'refresh_exhausted' });
    expect(judgeBaseDelta({ ...fact, requiresUpToDate: true }, 20)).toMatchObject({ tolerated: false, cause: 'refresh_exhausted', reason: expect.stringContaining('up-to-date') });
  });

  test('shared files and risky paths are refresh_unsafe and named, whatever the gap size', () => {
    expect(judgeBaseDelta({ ...fact, baseFiles: ['src/x.ts', 'src/a.ts'] }, 20)).toMatchObject({ tolerated: false, cause: 'refresh_unsafe', files: ['src/a.ts'] });
    expect(judgeBaseDelta({ ...fact, baseCommits: 1, baseFiles: ['packages/core/db/schema.ts'] }, 20)).toMatchObject({ cause: 'refresh_unsafe', files: ['packages/core/db/schema.ts'] });
    expect(judgeBaseDelta({ ...fact, prFiles: ['bun.lock'] }, 20)).toMatchObject({ cause: 'refresh_unsafe', files: ['bun.lock'] });
  });

  test('risky paths and overlap are told apart (basis)', () => {
    expect(judgeBaseDelta({ ...fact, baseFiles: ['src/a.ts'] }, 20)).toMatchObject({ cause: 'refresh_unsafe', basis: 'overlap' });
    expect(judgeBaseDelta({ ...fact, baseFiles: ['bun.lock'] }, 20)).toMatchObject({ cause: 'refresh_unsafe', basis: 'risky_path' });
  });

  // dc4436aa: every release bumps four manifests on dev; that alone made every behind PR's gap unsafe.
  describe('a release version bump in the gap', () => {
    const manifests = ['apps/runner/package.json', 'apps/web/package.json', 'packages/core/package.json'];
    const gap = { baseCommits: 2, baseFiles: ['src/x.ts', ...manifests], prFiles: ['docs/specs/x.md'] };

    test('only version-field manifest changes are tolerated', () => {
      expect(judgeBaseDelta({ ...gap, versionBumpFiles: manifests }, 20)).toEqual({ tolerated: true, baseCommits: 2, baseFileCount: 4 });
    });

    test('a manifest that also changed a dependency stays refresh_unsafe', () => {
      expect(judgeBaseDelta({ ...gap, versionBumpFiles: manifests.slice(1) }, 20))
        .toMatchObject({ tolerated: false, cause: 'refresh_unsafe', basis: 'risky_path', files: ['apps/runner/package.json'] });
    });

    test('the PR\'s own manifest stays risky even when the base only bumped it', () => {
      expect(judgeBaseDelta({ ...gap, prFiles: ['apps/web/package.json'], versionBumpFiles: manifests }, 20))
        .toMatchObject({ tolerated: false, cause: 'refresh_unsafe', files: ['apps/web/package.json'] });
    });
  });

  test('the kernel and the legacy door share one wide bound', () => {
    expect(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS).toBe(20);
    expect(LEGACY).toBe(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS);
  });
});

describe('versionBumpManifests: which compare files are only a version bump', () => {
  const bump = '@@ -1,6 +1,6 @@\n {\n   "name": "@buildd/core",\n-  "version": "0.365.0",\n+  "version": "0.366.0",\n   "type": "module",';
  const f = (o: Record<string, unknown>) => ({ filename: 'packages/core/package.json', status: 'modified', patch: bump, ...o });

  test('a release bump (the real chore: bump version diff)', () => {
    expect(versionBumpManifests([f({}), f({ filename: 'package.json', patch: '@@ -2 +2 @@\n-  "version": "1.0.0"\n+  "version": "1.0.1"' })]))
      .toEqual(['packages/core/package.json', 'package.json']);
  });

  test.each([
    ['a dependency change', { patch: `${bump}\n-    "zod": "3.0.0"\n+    "zod": "4.0.0"` }],
    ['a script change', { patch: '@@ -5 +5 @@\n-    "build": "a"\n+    "build": "b"' }],
    ['no patch (GitHub omits it on big diffs)', { patch: undefined }],
    ['an added manifest', { status: 'added' }],
    ['a renamed manifest', { status: 'renamed' }],
    ['a patch with no changed line', { patch: '@@ -1 +1 @@\n {' }],
    ['not a manifest', { filename: 'src/version.json' }],
  ])('%s is not', (_, o) => expect(versionBumpManifests([f(o)])).toEqual([]));

  test('anything but a list is none', () => expect(versionBumpManifests(null)).toEqual([]));
});
