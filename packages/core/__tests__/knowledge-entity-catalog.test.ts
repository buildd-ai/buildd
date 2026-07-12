import { describe, it, expect, mock } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE entity-catalog is loaded.
// The worktree lacks its own node_modules; the mock lets tests run without
// a real DB connection while entity-catalog.ts uses the sql tag at module level.
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

// Dynamic import runs AFTER mock.module — entity-catalog picks up the mock sql.
const { extractFilePaths, fetchEntityCatalog, renderEntityCatalog } =
  await import('../knowledge-store/entity-catalog');

// ── Mock DB factory ───────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

/**
 * Returns a mock DB whose execute() cycles through the given response queue.
 * Entries may be a row set or an Error (call rejects). Out-of-bounds calls
 * return { rows: [] }.
 */
function makeMockDb(responses: Array<{ rows: MockRow[] } | Error> = []) {
  let callIdx = 0;
  const executeFn = mock((_sql: unknown) => {
    const resp = responses[callIdx] ?? { rows: [] };
    callIdx++;
    if (resp instanceof Error) return Promise.reject(resp);
    return Promise.resolve(resp);
  });
  return { execute: executeFn };
}

// ── extractFilePaths ──────────────────────────────────────────────────────────

describe('extractFilePaths', () => {
  it('extracts a backtick-quoted path', () => {
    expect(extractFilePaths('Update `apps/web/src/lib/pusher.ts` to add events'))
      .toEqual(['apps/web/src/lib/pusher.ts']);
  });

  it('extracts a bare path token from prose', () => {
    expect(extractFilePaths('The bug is in packages/core/db/schema.ts somewhere'))
      .toEqual(['packages/core/db/schema.ts']);
  });

  it('strips trailing sentence punctuation and wrapping parens', () => {
    expect(extractFilePaths('see apps/web/src/app/page.tsx.')).toEqual(['apps/web/src/app/page.tsx']);
    expect(extractFilePaths('regression (packages/core/index.ts)')).toEqual(['packages/core/index.ts']);
    expect(extractFilePaths('fix apps/web/route.ts, then ship')).toEqual(['apps/web/route.ts']);
  });

  it('strips :line and :line:col suffixes', () => {
    expect(extractFilePaths('error at `apps/web/route.ts:120:5`')).toEqual(['apps/web/route.ts']);
    expect(extractFilePaths('see packages/core/x.ts:42')).toEqual(['packages/core/x.ts']);
  });

  it('strips a #fragment suffix (symbol refs)', () => {
    expect(extractFilePaths('`apps/web/src/lib/knowledge-context.ts#buildKnowledgeContext`'))
      .toEqual(['apps/web/src/lib/knowledge-context.ts']);
  });

  it('normalizes a leading ./', () => {
    expect(extractFilePaths('run ./scripts/release.sh first')).toEqual(['scripts/release.sh']);
  });

  it('ignores URLs', () => {
    expect(extractFilePaths('docs at https://example.com/docs/page.html')).toEqual([]);
  });

  it('accepts bare filenames only when backticked', () => {
    expect(extractFilePaths('Update `schema.ts` and regenerate')).toEqual(['schema.ts']);
    // bare filename without a directory and without backticks is too noisy
    expect(extractFilePaths('Update schema.ts and regenerate')).toEqual([]);
  });

  it('ignores backticked identifiers and commands that are not paths', () => {
    expect(extractFilePaths('call `buildKnowledgeContext` then run `bun db:generate`')).toEqual([]);
  });

  it('handles Next.js dynamic segments and route groups', () => {
    expect(extractFilePaths('edit apps/web/src/app/api/workers/[id]/route.ts'))
      .toEqual(['apps/web/src/app/api/workers/[id]/route.ts']);
    expect(extractFilePaths('see apps/web/src/app/app/(protected)/team/page.tsx'))
      .toEqual(['apps/web/src/app/app/(protected)/team/page.tsx']);
  });

  it('ignores slashed tokens without a file extension', () => {
    expect(extractFilePaths('the apps/runner directory and feat/some-branch')).toEqual([]);
  });

  it('dedupes repeated paths', () => {
    expect(extractFilePaths('`a/b.ts` then a/b.ts again')).toEqual(['a/b.ts']);
  });

  it('caps the number of extracted paths', () => {
    const text = Array.from({ length: 12 }, (_, i) => `pkg/mod${i}/file${i}.ts`).join(' ');
    expect(extractFilePaths(text)).toHaveLength(8);
    expect(extractFilePaths(text, 3)).toHaveLength(3);
  });

  it('returns [] for empty or path-free text', () => {
    expect(extractFilePaths('')).toEqual([]);
    expect(extractFilePaths('improve onboarding flow copy')).toEqual([]);
  });
});

// ── fetchEntityCatalog ────────────────────────────────────────────────────────

describe('fetchEntityCatalog', () => {
  it('fetches file, symbol, and top-connected entities in order', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'f1', kind: 'file', key: 'apps/web/a.ts', canonical_name: 'a.ts' }] },
      { rows: [{ id: 's1', kind: 'symbol', key: 'apps/web/a.ts#foo', canonical_name: 'foo' }] },
      { rows: [{ id: 'c1', kind: 'concept', key: 'auth-flow', canonical_name: 'Auth Flow' }] },
    ]);

    const result = await fetchEntityCatalog(db as any, {
      workspaceId: 'ws-1',
      paths: ['apps/web/a.ts'],
    });

    expect(result).toEqual([
      { kind: 'file', key: 'apps/web/a.ts', canonicalName: 'a.ts' },
      { kind: 'symbol', key: 'apps/web/a.ts#foo', canonicalName: 'foo' },
      { kind: 'concept', key: 'auth-flow', canonicalName: 'Auth Flow' },
    ]);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it('skips file and symbol queries when no paths are given', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'c1', kind: 'concept', key: 'billing', canonical_name: 'Billing' }] },
    ]);

    const result = await fetchEntityCatalog(db as any, { workspaceId: 'ws-1', paths: [] });

    expect(result).toEqual([{ kind: 'concept', key: 'billing', canonicalName: 'Billing' }]);
    expect(db.execute).toHaveBeenCalledTimes(1); // only top-connected
  });

  it('skips the symbol query when no file entities match', async () => {
    const db = makeMockDb([
      { rows: [] }, // file query: no matches
      { rows: [] }, // top-connected
    ]);

    const result = await fetchEntityCatalog(db as any, {
      workspaceId: 'ws-1',
      paths: ['unknown/path.ts'],
    });

    expect(result).toEqual([]);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('returns [] when the first query fails (store unavailable)', async () => {
    const db = makeMockDb([new Error('connection refused')]);

    const result = await fetchEntityCatalog(db as any, {
      workspaceId: 'ws-1',
      paths: ['a/b.ts'],
    });

    expect(result).toEqual([]);
  });

  it('returns partial results when a later query fails', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'f1', kind: 'file', key: 'a/b.ts', canonical_name: 'b.ts' }] },
      new Error('timeout'), // symbol query fails
    ]);

    const result = await fetchEntityCatalog(db as any, { workspaceId: 'ws-1', paths: ['a/b.ts'] });

    expect(result).toEqual([{ kind: 'file', key: 'a/b.ts', canonicalName: 'b.ts' }]);
  });

  it('dedupes entities and respects maxEntities', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'f1', kind: 'file', key: 'a/b.ts', canonical_name: 'b.ts' }] },
      {
        rows: [
          { id: 's1', kind: 'symbol', key: 'a/b.ts#x', canonical_name: 'x' },
          { id: 's1', kind: 'symbol', key: 'a/b.ts#x', canonical_name: 'x' }, // dup
          { id: 's2', kind: 'symbol', key: 'a/b.ts#y', canonical_name: 'y' },
        ],
      },
      { rows: [{ id: 'c1', kind: 'concept', key: 'auth', canonical_name: 'Auth' }] },
    ]);

    const result = await fetchEntityCatalog(db as any, {
      workspaceId: 'ws-1',
      paths: ['a/b.ts'],
      maxEntities: 3,
    });

    expect(result).toHaveLength(3);
    expect(result.map(e => e.key)).toEqual(['a/b.ts', 'a/b.ts#x', 'a/b.ts#y']);
  });

  it('skips malformed rows missing kind or key', async () => {
    const db = makeMockDb([
      { rows: [{ id: 'junk', task_id: 't1' }] }, // top-connected returns junk shape
    ]);

    const result = await fetchEntityCatalog(db as any, { workspaceId: 'ws-1', paths: [] });

    expect(result).toEqual([]);
  });
});

// ── renderEntityCatalog ───────────────────────────────────────────────────────

describe('renderEntityCatalog', () => {
  const entities = [
    { kind: 'file', key: 'apps/web/a.ts', canonicalName: 'a.ts' },
    { kind: 'symbol', key: 'apps/web/a.ts#foo', canonicalName: 'foo' },
    { kind: 'concept', key: 'auth-flow', canonicalName: 'Auth Flow' },
  ];

  it('returns an empty string for an empty catalog', () => {
    expect(renderEntityCatalog([])).toBe('');
  });

  it('renders a Known entities header with an exact-name instruction', () => {
    const out = renderEntityCatalog(entities);
    expect(out).toContain('## Known entities');
    expect(out).toContain('exact names');
  });

  it('lists each entity with kind and canonical key', () => {
    const out = renderEntityCatalog(entities);
    expect(out).toContain('file: apps/web/a.ts');
    expect(out).toContain('symbol: foo (apps/web/a.ts#foo)');
    expect(out).toContain('concept: Auth Flow (auth-flow)');
  });

  it('shows only the key when it equals the canonical name', () => {
    const out = renderEntityCatalog([{ kind: 'concept', key: 'billing', canonicalName: 'billing' }]);
    expect(out).toContain('concept: billing');
    expect(out).not.toContain('(billing)');
  });

  it('caps the number of listed entities', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: 'symbol', key: `a/b.ts#sym${i}`, canonicalName: `sym${i}`,
    }));
    const out = renderEntityCatalog(many, { maxEntities: 5 });
    expect(out.split('\n').filter(l => l.startsWith('- ')).length).toBe(5);
  });

  it('caps total block size in characters', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'file',
      key: `packages/very/long/nested/directory/structure/module-${i}/implementation-file-${i}.ts`,
      canonicalName: `implementation-file-${i}.ts`,
    }));
    const out = renderEntityCatalog(many);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.split('\n').filter(l => l.startsWith('- ')).length).toBeGreaterThan(0);
  });
});
