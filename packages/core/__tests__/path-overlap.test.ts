import { describe, it, expect } from 'bun:test';
import { pathsOverlap, serializeBatchByManifest, findBlockingPr } from '../path-overlap';

describe('pathsOverlap', () => {
  it('returns false for empty arrays', () => {
    expect(pathsOverlap([], ['a.ts'])).toBe(false);
    expect(pathsOverlap(['a.ts'], [])).toBe(false);
    expect(pathsOverlap([], [])).toBe(false);
  });

  it('detects exact path matches', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);
  });

  it('returns false for non-overlapping files', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib/bar.ts'],
    )).toBe(false);
  });

  it('detects overlap when one path is a prefix (directory) of the other', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);

    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src'],
    )).toBe(true);
  });

  it('does not false-positive on similar directory names', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib-extra/foo.ts'],
      ['apps/web/src/lib'],
    )).toBe(false);
  });

  it('strips trailing slashes before comparing', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);
  });

  it('handles many-to-many overlap: only one pair needs to match', () => {
    expect(pathsOverlap(
      ['a.ts', 'b.ts', 'apps/web/src/lib/mcp-oauth.ts'],
      ['c.ts', 'd.ts', 'apps/web/src/lib/mcp-oauth.ts'],
    )).toBe(true);
  });

  it('returns false when lists share no files', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts', 'apps/web/src/lib/bar.ts'],
      ['apps/runner/index.ts', 'packages/core/db/schema.ts'],
    )).toBe(false);
  });
});

describe('serializeBatchByManifest', () => {
  it('returns empty array when batch has no overlaps', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'b', pathManifest: ['apps/web/src/lib/bar.ts'] },
    ];
    expect(serializeBatchByManifest(tasks)).toEqual([]);
  });

  it('adds dependsOn edge for two overlapping tasks', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/mcp-oauth.ts'] },
      { id: 'b', pathManifest: ['apps/web/src/lib/mcp-oauth.ts'] },
    ];
    const result = serializeBatchByManifest(tasks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ taskId: 'b', addDependsOn: ['a'] });
  });

  it('chains three overlapping tasks into a sequence', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/shared.ts'] },
      { id: 'b', pathManifest: ['apps/web/src/lib/shared.ts'] },
      { id: 'c', pathManifest: ['apps/web/src/lib/shared.ts'] },
    ];
    const result = serializeBatchByManifest(tasks);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ taskId: 'b', addDependsOn: ['a'] });
    expect(result[1]).toEqual({ taskId: 'c', addDependsOn: ['a', 'b'] });
  });

  it('skips tasks without pathManifest', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'b' }, // no manifest
      { id: 'c', pathManifest: ['apps/web/src/lib/foo.ts'] },
    ];
    const result = serializeBatchByManifest(tasks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ taskId: 'c', addDependsOn: ['a'] });
  });

  it('does not duplicate edges already in dependsOn', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/foo.ts'] },
      { id: 'b', pathManifest: ['apps/web/src/lib/foo.ts'], dependsOn: ['a'] },
    ];
    const result = serializeBatchByManifest(tasks);
    expect(result).toHaveLength(0);
  });

  it('handles mixed overlapping and non-overlapping tasks', () => {
    const tasks = [
      { id: 'a', pathManifest: ['apps/web/src/lib/mcp-oauth.ts'] },
      { id: 'b', pathManifest: ['packages/core/db/schema.ts'] },
      { id: 'c', pathManifest: ['apps/web/src/lib/mcp-oauth.ts', 'packages/core/db/schema.ts'] },
    ];
    const result = serializeBatchByManifest(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('c');
    expect(result[0].addDependsOn).toContain('a');
    expect(result[0].addDependsOn).toContain('b');
  });

  it('returns empty array for single-task batch', () => {
    const tasks = [{ id: 'a', pathManifest: ['foo.ts'] }];
    expect(serializeBatchByManifest(tasks)).toEqual([]);
  });
});

describe('findBlockingPr', () => {
  it('returns null when candidate has no manifest', () => {
    const result = findBlockingPr([], [
      { pathManifest: ['foo.ts'], prNumber: 1, prUrl: 'https://github.com/org/repo/pull/1' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when no open PR overlaps', () => {
    const result = findBlockingPr(['apps/web/src/lib/foo.ts'], [
      { pathManifest: ['apps/web/src/lib/bar.ts'], prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' },
    ]);
    expect(result).toBeNull();
  });

  it('returns the blocking PR info when an open PR overlaps', () => {
    const result = findBlockingPr(
      ['apps/web/src/lib/mcp-oauth.ts'],
      [
        { pathManifest: ['apps/web/src/lib/bar.ts'], prNumber: 1, prUrl: 'url1' },
        { pathManifest: ['apps/web/src/lib/mcp-oauth.ts'], prNumber: 1126, prUrl: 'url1126' },
      ],
    );
    expect(result).toEqual({ prNumber: 1126, prUrl: 'url1126' });
  });

  it('returns null when open PR tasks have no pathManifest', () => {
    const result = findBlockingPr(['foo.ts'], [
      { pathManifest: null, prNumber: 1, prUrl: 'url' },
      { pathManifest: [], prNumber: 2, prUrl: 'url2' },
    ]);
    expect(result).toBeNull();
  });
});
