import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// No `db` mock on purpose. This module is a WHERE fragment plus a predicate,
// and mocking `db` makes a predicate unobservable — a mocked query builder
// returns whatever rows it was seeded with regardless of the condition handed
// to it, so a test written that way passes against a fragment that filters
// nothing. The fragment is rendered with the real dialect and asserted as SQL
// text plus params.
import {
  MAX_SCOPE_PATHS,
  memoryFilesMatch,
  normalizeMemoryFileScope,
} from '../memory-file-scope';
import { memoryFilesOverlapSql } from '../memory-file-scope-sql';
import { pathsOverlap, REPO_WIDE_SENTINEL } from '../path-overlap';

const dialect = new PgDialect();
function render(frag: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(frag as never);
  return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

describe('normalizeMemoryFileScope', () => {
  it('keeps concrete paths', () => {
    expect(normalizeMemoryFileScope(['apps/web/src/lib/foo.ts', 'packages/core']))
      .toEqual(['apps/web/src/lib/foo.ts', 'packages/core']);
  });

  // '**' records that the filer never declared a scope. Querying it would match
  // every memory, turning "we know nothing" into "everything is relevant".
  it('drops the repo-wide sentinel rather than matching everything', () => {
    expect(normalizeMemoryFileScope([REPO_WIDE_SENTINEL])).toEqual([]);
    expect(normalizeMemoryFileScope([REPO_WIDE_SENTINEL, 'apps/web'])).toEqual(['apps/web']);
  });

  it('normalises trailing separators and de-duplicates', () => {
    expect(normalizeMemoryFileScope(['apps/web/', 'apps/web', 'apps/web//']))
      .toEqual(['apps/web']);
  });

  // path_manifest is jsonb with only a compile-time $type assertion, so its
  // runtime shape is an assumption about every writer.
  it('survives a column that is not an array of strings', () => {
    expect(normalizeMemoryFileScope(null)).toEqual([]);
    expect(normalizeMemoryFileScope(undefined)).toEqual([]);
    expect(normalizeMemoryFileScope('apps/web' as unknown as unknown[])).toEqual([]);
    expect(normalizeMemoryFileScope([1, null, {}, 'apps/web'])).toEqual(['apps/web']);
    expect(normalizeMemoryFileScope(['', '   '])).toEqual([]);
  });

  it('truncates a pathological manifest instead of unbounding the query', () => {
    const many = Array.from({ length: MAX_SCOPE_PATHS * 3 }, (_, i) => `p/${i}`);
    expect(normalizeMemoryFileScope(many)).toHaveLength(MAX_SCOPE_PATHS);
  });
});

describe('memoryFilesMatch — the executable specification', () => {
  it('matches an exact path', () => {
    expect(memoryFilesMatch(['apps/web/src/a.ts'], ['apps/web/src/a.ts'])).toBe(true);
  });

  it('matches when the task declares a directory containing the memory file', () => {
    expect(memoryFilesMatch(['apps/web/src/a.ts'], ['apps/web'])).toBe(true);
  });

  it('matches when the memory is about a directory containing the task path', () => {
    expect(memoryFilesMatch(['apps/web'], ['apps/web/src/a.ts'])).toBe(true);
  });

  // The bug a naive startsWith() would introduce: sibling directories that
  // share a name prefix are NOT related.
  it('does not match a sibling that merely shares a name prefix', () => {
    expect(memoryFilesMatch(['apps/web-legacy/src/a.ts'], ['apps/web'])).toBe(false);
    expect(memoryFilesMatch(['apps/web'], ['apps/website/src/a.ts'])).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(memoryFilesMatch([], ['apps/web'])).toBe(false);
    expect(memoryFilesMatch(['apps/web'], [])).toBe(false);
    expect(memoryFilesMatch(null, ['apps/web'])).toBe(false);
    expect(memoryFilesMatch(undefined, ['apps/web'])).toBe(false);
  });

  it('tolerates junk inside the memory files column', () => {
    expect(memoryFilesMatch(['', '  ', 'apps/web/src/a.ts'], ['apps/web'])).toBe(true);
  });
});

/**
 * One definition of "these paths overlap" — the same question path claims and
 * dependency inference already ask. Divergence here would mean a memory is
 * considered relevant to a task that the claim layer says cannot collide with
 * it, which is incoherent.
 */
describe('parity with pathsOverlap', () => {
  const cases: Array<[string[], string[]]> = [
    [['apps/web/src/a.ts'], ['apps/web/src/a.ts']],
    [['apps/web/src/a.ts'], ['apps/web']],
    [['apps/web'], ['apps/web/src/a.ts']],
    [['apps/web-legacy/src/a.ts'], ['apps/web']],
    [['apps/web'], ['apps/website/src/a.ts']],
    [['packages/core/db/schema.ts'], ['apps/runner/src/index.ts']],
    [['a/b/c'], ['a/b']],
    [['a/b'], ['a/b/c/d']],
    [['a'], ['b']],
  ];

  it('agrees with pathsOverlap on every non-sentinel case', () => {
    for (const [memFiles, scope] of cases) {
      expect(memoryFilesMatch(memFiles, scope)).toBe(pathsOverlap(memFiles, scope));
    }
  });

  // The one deliberate divergence, documented in the module: pathsOverlap
  // answers a spatial question where an undeclared scope must be "possibly
  // yes"; retrieval answers a relevance question where it must be "unknown".
  it('deliberately differs on the sentinel, which is stripped before matching', () => {
    expect(pathsOverlap(['anything'], [REPO_WIDE_SENTINEL])).toBe(true);
    expect(memoryFilesMatch(['anything'], normalizeMemoryFileScope([REPO_WIDE_SENTINEL]))).toBe(false);
  });
});

describe('memoryFilesOverlapSql', () => {
  // Distinguishes "no path scope declared" from "a path scope matched nothing".
  it('returns null with no paths, so the caller can tell the two outcomes apart', () => {
    expect(memoryFilesOverlapSql([])).toBeNull();
  });

  it('binds the paths as a single array parameter', () => {
    const { params } = render(memoryFilesOverlapSql(['apps/web', 'packages/core']));
    expect(params).toEqual([['apps/web', 'packages/core']]);
  });

  it('keeps one query shape regardless of how many paths were declared', () => {
    const one = render(memoryFilesOverlapSql(['a']));
    const many = render(memoryFilesOverlapSql(Array.from({ length: 20 }, (_, i) => `p/${i}`)));
    expect(many.sql).toBe(one.sql);
    expect(many.params).toHaveLength(1);
  });

  it('implements all three comparison forms the specification requires', () => {
    const { sql: text } = render(memoryFilesOverlapSql(['apps/web']));
    expect(text).toContain('mf.path = sp.path');
    expect(text).toContain(`left(mf.path, length(sp.path) + 1) = sp.path || '/'`);
    expect(text).toContain(`left(sp.path, length(mf.path) + 1) = mf.path || '/'`);
  });

  // A stored path routinely contains '_' (worker_action_events), which LIKE
  // reads as a single-character wildcard — and a pattern built from a column
  // value cannot be escaped. left() has no pattern semantics.
  it('uses exact prefix comparison, never LIKE', () => {
    const { sql: text } = render(memoryFilesOverlapSql(['apps/web']));
    expect(text.toUpperCase()).not.toContain('LIKE');
    expect(text).not.toContain('%');
  });

  it('scopes the existence check to the memories.files column', () => {
    const { sql: text } = render(memoryFilesOverlapSql(['apps/web']));
    expect(text).toContain('EXISTS');
    expect(text).toContain('"files"');
  });
});
