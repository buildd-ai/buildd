import { describe, expect, test } from 'bun:test';
import { TREADMILL_EXHAUSTED_MAX_BASE_COMMITS, isRiskyLandingPath, judgeBaseDelta } from './base-delta';
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

  test.each(['packages/core/drizzle/0300_x.sql', 'drizzle/0001_a.sql', 'packages/core/drizzle/meta/0300_snapshot.json', 'drizzle/x.sql'])(
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

  test('the kernel and the legacy door share one wide bound', () => {
    expect(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS).toBe(20);
    expect(LEGACY).toBe(TREADMILL_EXHAUSTED_MAX_BASE_COMMITS);
  });
});
