import { describe, expect, it } from 'bun:test';
import { UNMERGEABLE_SURFACES, unmergeablePaths, unmergeableSurfaceOf } from '../unmergeable-surfaces';

describe('unmergeable surfaces', () => {
  it.each([
    'packages/core/drizzle/0300_add_column/migration.sql',
    'packages/core/drizzle/meta/_journal.json',
    'packages/core/drizzle/meta/0300_snapshot.json',
    'packages/core/drizzle',
    'packages/core/drizzle/',
    'packages/core/db/schema.ts',
    'bun.lock',
    'apps/web/bun.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'docs/specs/INDEX.md',
    'apps/runner/__tests__/unit/__snapshots__/top-render.test.ts.snap',
    'apps/web/next-env.d.ts',
  ])('%s is unmergeable', (path) => {
    expect(unmergeableSurfaceOf(path)).not.toBeNull();
  });

  it.each([
    'apps/web/src/lib/x.ts',
    'apps/web/src/app/api/workers/claim/route.ts',
    'packages/core/path-overlap.ts',
    'packages/core/db/index.ts',
    'packages/core/drizzle-helpers.ts',
    'docs/specs/claim-overlap-scheduling.md',
    'apps/web/src/lib/',
    'snap.ts',
  ])('%s merges', (path) => {
    expect(unmergeableSurfaceOf(path)).toBeNull();
  });

  it('every entry says why', () => {
    for (const s of UNMERGEABLE_SURFACES) expect(s.why.length).toBeGreaterThan(0);
  });

  it('unmergeablePaths keeps only the listed paths, in order', () => {
    expect(unmergeablePaths(['apps/web/src/lib/x.ts', 'bun.lock', 'packages/core/db/schema.ts'])).toEqual(['bun.lock', 'packages/core/db/schema.ts']);
    expect(unmergeablePaths([])).toEqual([]);
  });
});
