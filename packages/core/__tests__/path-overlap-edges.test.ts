/**
 * How two declared manifests overlap (migration, same file, prefix). Nothing
 * is minted from it at creation any more; the claim's lane check reads it.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/path-overlap-edges.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyManifestOverlap,
  isFileShapedPath,
  isHardOverlapKind,
  isMigrationPath,
  readSoftOverlaps,
} from '../path-overlap';

describe('classifyManifestOverlap', () => {
  it('a declared directory containing another task\'s file is prefix-only (soft)', () => {
    const o = classifyManifestOverlap(['scripts/'], ['scripts/run-unit-tests.ts']);
    expect(o.kind).toBe('prefix');
    expect(o.paths).toContain('scripts');
  });

  it('two tasks declaring the same directory are still prefix-only, not an exact file', () => {
    expect(classifyManifestOverlap(['apps/web/src/lib/'], ['apps/web/src/lib']).kind).toBe('prefix');
  });

  it('the same file on both sides is an exact-file overlap (soft since task 1141e62e)', () => {
    const o = classifyManifestOverlap(
      ['apps/web/src/lib/explain.ts', 'apps/web/src/lib/other.ts'],
      ['apps/web/src/lib/explain.ts'],
    );
    expect(o.kind).toBe('exact_file');
    expect(o.paths).toEqual(['apps/web/src/lib/explain.ts']);
  });

  it('a migration or schema path anywhere in the overlap is hard, even prefix-only', () => {
    expect(classifyManifestOverlap(['packages/core/drizzle/'], ['packages/core/drizzle/0300_x.sql']).kind).toBe('migration');
    expect(classifyManifestOverlap(['packages/core/db/'], ['packages/core/db/schema.ts']).kind).toBe('migration');
  });

  it('disjoint, empty and sentinel manifests do not overlap', () => {
    expect(classifyManifestOverlap(['a/x.ts'], ['b/y.ts']).kind).toBe('none');
    expect(classifyManifestOverlap([], ['b/y.ts']).kind).toBe('none');
    expect(classifyManifestOverlap(null, ['b/y.ts']).kind).toBe('none');
    expect(classifyManifestOverlap(['**'], ['b/y.ts']).kind).toBe('none');
    expect(classifyManifestOverlap(['b/y.ts', '**'], ['b/y.ts']).kind).toBe('none');
  });

  it('isHardOverlapKind is true only for migrations: same-file overlap is decided at claim', () => {
    expect(isHardOverlapKind('exact_file')).toBe(false);
    expect(isHardOverlapKind('migration')).toBe(true);
    expect(isHardOverlapKind('prefix')).toBe(false);
    expect(isHardOverlapKind('none')).toBe(false);
  });
});

describe('isFileShapedPath', () => {
  it.each([
    ['apps/web/src/lib/explain.ts', true],
    ['packages/core/drizzle/meta/_journal.json', true],
    ['scripts', false],
    ['scripts/', false],
    ['.github', false],
    ['apps/web/**', false],
    ['apps/web/*.ts', false],
  ] as const)('%s → %s', (p, want) => {
    expect(isFileShapedPath(p)).toBe(want);
  });
});

describe('isMigrationPath (shared with the claim-hold rails)', () => {
  it('covers drizzle, migrations, .sql and the db schema file', () => {
    expect(isMigrationPath('packages/core/drizzle/0001_x.sql')).toBe(true);
    expect(isMigrationPath('packages/core/db/schema.ts')).toBe(true);
    expect(isMigrationPath('apps/web/src/lib/explain.ts')).toBe(false);
  });
});

describe('readSoftOverlaps', () => {
  it('keeps the same_file kind; anything unknown reads as prefix', () => {
    const decl = { softOverlaps: [
      { taskId: 'a', paths: ['x.ts'], kind: 'same_file' },
      { taskId: 'b', paths: ['lib'], kind: 'legacy_inferred' },
      { taskId: 'c', paths: ['lib'], kind: 'weird' },
    ] };
    expect(readSoftOverlaps(decl).map(e => e.kind)).toEqual(['same_file', 'legacy_inferred', 'prefix']);
  });
});

describe('review findings: the classification sees the whole overlap', () => {
  it('a pair sharing a file still reports its prefix overlap, so a serialized directory is seen', () => {
    // A declares `seq-dir/` + `src/a.ts`; B declares `seq-dir/0042.ts` + `src/a.ts`.
    const o = classifyManifestOverlap(['seq-dir/', 'src/a.ts'], ['seq-dir/0042.ts', 'src/a.ts']);
    expect(o.kind).toBe('exact_file');
    expect(o.paths).toEqual(expect.arrayContaining(['src/a.ts', 'seq-dir', 'seq-dir/0042.ts']));
  });
});
