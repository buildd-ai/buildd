/**
 * Which manifest overlaps may become a stored (hard) dependsOn edge, and which
 * are only scheduling evidence (soft) for the claim-time HOLD/START decision.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/path-overlap-edges.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyManifestOverlap,
  isFileShapedPath,
  isHardOverlapKind,
  isMigrationPath,
  partitionOverlapEdges,
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

  it('the same file on both sides is an exact-file overlap (hard)', () => {
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

  it('isHardOverlapKind is true only for exact files and migrations', () => {
    expect(isHardOverlapKind('exact_file')).toBe(true);
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

describe('partitionOverlapEdges', () => {
  const others = [
    { id: 'dir-owner', pathManifest: ['scripts/'] },
    { id: 'same-file', pathManifest: ['scripts/run-unit-tests.ts'] },
    { id: 'migration', pathManifest: ['packages/core/drizzle/'] },
    { id: 'unrelated', pathManifest: ['docs/x.md'] },
    { id: 'undeclared', pathManifest: ['**'] },
    { id: 'none', pathManifest: null },
  ];

  it('a broad-prefix manifest mints no hard edge: only soft evidence', () => {
    const r = partitionOverlapEdges(['scripts/'], others.filter(o => o.id !== 'dir-owner'));
    expect(r.hard).toEqual([]);
    expect(r.soft).toEqual([{ taskId: 'same-file', paths: ['scripts', 'scripts/run-unit-tests.ts'], kind: 'prefix' }]);
  });

  it('an exact-file overlap with a live or queued writer stays a hard edge', () => {
    const r = partitionOverlapEdges(['scripts/run-unit-tests.ts', 'packages/core/drizzle/0400_y.sql'], others);
    expect([...r.hard].sort()).toEqual(['migration', 'same-file']);
    expect(r.soft).toEqual([{ taskId: 'dir-owner', paths: ['scripts/run-unit-tests.ts', 'scripts'], kind: 'prefix' }]);
  });

  it('a workspace-serialized surface is hard even when the overlap is prefix-only', () => {
    const r = partitionOverlapEdges(['scripts/'], [{ id: 'dir-owner', pathManifest: ['scripts/gen.ts'] }], {
      isSerialized: (paths) => paths.some(p => p.startsWith('scripts')),
    });
    expect(r.hard).toEqual(['dir-owner']);
    expect(r.soft).toEqual([]);
  });

  it('skip() excludes candidates (already declared, or a deadlock veto)', () => {
    const r = partitionOverlapEdges(['scripts/run-unit-tests.ts'], others, { skip: (id) => id === 'same-file' });
    expect(r.hard).toEqual([]);
    expect(r.soft.map(s => s.taskId)).toEqual(['dir-owner']);
  });

  it('an advisory or empty manifest produces nothing', () => {
    expect(partitionOverlapEdges(['**'], others)).toEqual({ hard: [], soft: [] });
    expect(partitionOverlapEdges([], others)).toEqual({ hard: [], soft: [] });
  });

  it('soft evidence is bounded', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, pathManifest: [`lib/f${i}.ts`] }));
    const r = partitionOverlapEdges(['lib/'], many, { maxSoft: 5 });
    expect(r.soft).toHaveLength(5);
  });
});
