import { describe, it, expect, afterEach } from 'bun:test';
import { fileToChunks, ingestFiles, pruneOrphans } from '../knowledge-store/ingest';
import { chunkCode } from '../knowledge-store/chunker';
import { __setAstGrepLoaderForTests } from '../knowledge-store/symbol-extractor';
import type { KnowledgeStore, UpsertChunk, QueryResult } from '../knowledge-store/types';

afterEach(() => {
  __setAstGrepLoaderForTests(null);
});

// ── Mock store that records calls ────────────────────────────────────────────

function makeRecordingStore() {
  const chunks = new Map<string, UpsertChunk & { namespace: string }>();
  const deletedSources: Array<{ namespace: string; sourcePath?: string }> = [];
  const touchedSources: Array<{ namespace: string; sourcePaths: string[] }> = [];
  const store: KnowledgeStore = {
    async upsert(namespace, cs) {
      for (const c of cs) chunks.set(`${namespace}:${c.id}`, { ...c, namespace });
    },
    async query(): Promise<QueryResult[]> {
      return [];
    },
    async delete(namespace, ids) {
      for (const id of ids) chunks.delete(`${namespace}:${id}`);
    },
    async deleteBySource(namespace, selector) {
      deletedSources.push({ namespace, sourcePath: selector.sourcePath });
      for (const [key, c] of chunks.entries()) {
        if (c.namespace === namespace && c.sourcePath === selector.sourcePath) chunks.delete(key);
      }
    },
    async listNamespaces() {
      return [];
    },
    async getFileHashes(namespace, sourcePaths) {
      const wanted = new Set(sourcePaths);
      const byPath = new Map<string, Set<string>>();
      for (const c of chunks.values()) {
        if (c.namespace !== namespace || !c.sourcePath || !wanted.has(c.sourcePath) || !c.fileHash) continue;
        (byPath.get(c.sourcePath) ?? byPath.set(c.sourcePath, new Set()).get(c.sourcePath)!).add(c.fileHash);
      }
      const out = new Map<string, string>();
      for (const [p, set] of byPath) if (set.size === 1) out.set(p, [...set][0]);
      return out;
    },
    async touchBySource(namespace, sourcePaths) {
      touchedSources.push({ namespace, sourcePaths });
    },
    async listSourcePaths(namespace, prefix) {
      const paths = new Set<string>();
      for (const c of chunks.values()) {
        if (c.namespace !== namespace || !c.sourcePath) continue;
        if (prefix && !(c.sourcePath === prefix || c.sourcePath.startsWith(prefix + '/'))) continue;
        paths.add(c.sourcePath);
      }
      return [...paths];
    },
  };
  return { store, chunks, deletedSources, touchedSources };
}

// ── fileToChunks ─────────────────────────────────────────────────────────────

describe('fileToChunks', () => {
  it('produces one chunk for a small code file with a composite id', async () => {
    const chunks = await fileToChunks(
      { path: 'src/add.ts', content: 'export const add = (a, b) => a + b;' },
      'code',
      {},
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('src/add.ts#1');
    expect(chunks[0].sourcePath).toBe('src/add.ts');
    expect(chunks[0].sourceType).toBe('code');
    expect(chunks[0].metadata?.startLine).toBe(1);
  });

  it('splits a large doc into multiple chunks with distinct ids', async () => {
    const big = Array.from({ length: 60 }, (_, i) => `paragraph line ${i}`).join('\n');
    const md = `# Guide\n${big}`;
    const chunks = await fileToChunks({ path: 'docs/guide.md', content: md }, 'docs', { maxChars: 120, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every(id => id.startsWith('docs/guide.md#'))).toBe(true);
    // doc chunks carry the heading in lexicalText for better BM25 recall
    expect(chunks[0].lexicalText).toContain('Guide');
  });

  it('builds a line-anchored sourceUrl when a base url is given', async () => {
    const chunks = await fileToChunks(
      { path: 'src/x.ts', content: 'line1\nline2', sourceUrl: 'https://gh/x.ts' },
      'code',
      { maxChars: 5, overlap: 0 },
    );
    expect(chunks[0].sourceUrl).toBe('https://gh/x.ts#L1');
  });
});

// ── fileToChunks — symbol-boundary chunking (ast-grep) ──────────────────────

const TS_FILE = {
  path: 'src/lib/auth.ts',
  content: [
    "import { token } from './token';",  // 1
    '',                                  // 2
    'export function login(u: string) {',// 3
    '  return token(u);',                // 4
    '}',                                 // 5
    '',                                  // 6
    'export function logout() {',        // 7
    '  return token(null);',             // 8
    '}',                                 // 9
    '',                                  // 10
    'export class Session {',            // 11
    '  id = 1;',                         // 12
    '}',                                 // 13
  ].join('\n'),
};

describe('fileToChunks — symbol chunking', () => {
  it('aligns code chunks to declaration boundaries and keeps path#startLine ids', async () => {
    // Budget small enough to force multiple, boundary-aligned chunks.
    const chunks = await fileToChunks(TS_FILE, 'code', { maxChars: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.id).toBe(`src/lib/auth.ts#${c.metadata?.startLine}`);
      // No declaration split mid-body: every chunk has balanced braces.
      const opens = (c.content.match(/\{/g) ?? []).length;
      const closes = (c.content.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    // First chunk carries the imports header attached to the first declaration.
    expect(chunks[0].content).toContain("import { token }");
    expect(chunks[0].content).toContain('function login');
  });

  it('attaches defined symbols to each chunk metadata and imports to the first chunk', async () => {
    const chunks = await fileToChunks(TS_FILE, 'code', { maxChars: 100, overlap: 0 });
    const allSymbols = chunks.flatMap(c => (c.metadata?.symbols as Array<{ name: string }> | undefined) ?? []);
    const names = allSymbols.map(s => s.name).sort();
    expect(names).toEqual(['Session', 'login', 'logout']);
    // Each chunk only lists symbols defined within its own line range.
    for (const c of chunks) {
      for (const s of (c.metadata?.symbols as Array<{ startLine: number }> | undefined) ?? []) {
        expect(s.startLine).toBeGreaterThanOrEqual(c.metadata?.startLine as number);
        expect(s.startLine).toBeLessThanOrEqual(c.metadata?.endLine as number);
      }
    }
    // Imports recorded once, on the first chunk.
    const imports = chunks[0].metadata?.imports as Array<{ specifier: string; resolvedPath: string | null }>;
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('./token');
    expect(imports[0].resolvedPath).toBe('src/lib/token');
    expect(chunks.slice(1).every(c => c.metadata?.imports === undefined)).toBe(true);
  });

  it('falls back to the line-window path when ast-grep is unavailable (identical output)', async () => {
    const opts = { maxChars: 80, overlap: 10 };
    __setAstGrepLoaderForTests(() => Promise.reject(new Error('no native binary')));
    const fallback = await fileToChunks(TS_FILE, 'code', opts);

    const expected = chunkCode(TS_FILE.content, opts).map(piece => ({
      id: `${TS_FILE.path}#${piece.startLine}`,
      content: piece.content,
      lexicalText: `${TS_FILE.path}\n\n${piece.content}`,
      sourceType: 'code',
      sourcePath: TS_FILE.path,
      sourceUrl: undefined,
      sourceTs: undefined,
      fileHash: null,
      metadata: { startLine: piece.startLine, endLine: piece.endLine },
    }));
    expect(fallback).toEqual(expected);
  });

  it('uses the line-window path for unsupported languages', async () => {
    const py = { path: 'scripts/run.py', content: 'def main():\n    pass\n' };
    const chunks = await fileToChunks(py, 'code', {});
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata?.symbols).toBeUndefined();
  });
});

// ── ingestFiles ──────────────────────────────────────────────────────────────

describe('ingestFiles', () => {
  it('upserts chunks for all files and returns counts', async () => {
    const { store, chunks } = makeRecordingStore();
    const result = await ingestFiles(store, 'ws-1', 'code', [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.ts', content: 'const b = 2;' },
    ]);
    expect(result.files).toBe(2);
    expect(result.chunks).toBe(2);
    expect(chunks.size).toBe(2);
  });

  it('cleans up prior chunks for a file before re-ingesting (no orphans)', async () => {
    const { store, chunks, deletedSources } = makeRecordingStore();
    const ns = 'ws-1:code';

    // First ingest: a long file -> several chunks
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'f.ts', content: long }], { maxChars: 40, overlap: 0 });
    const firstCount = chunks.size;
    expect(firstCount).toBeGreaterThan(1);

    // Re-ingest the same path with a tiny file -> should not leave orphan tail chunks
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'f.ts', content: 'line 0' }], { maxChars: 40, overlap: 0 });
    expect(deletedSources.some(d => d.namespace === ns && d.sourcePath === 'f.ts')).toBe(true);
    const remaining = [...chunks.values()].filter(c => c.sourcePath === 'f.ts');
    expect(remaining).toHaveLength(1);
  });

  it('skips empty files without error', async () => {
    const { store } = makeRecordingStore();
    const result = await ingestFiles(store, 'ws-1', 'docs', [{ path: 'empty.md', content: '   ' }]);
    expect(result.files).toBe(1);
    expect(result.chunks).toBe(0);
  });

  it('skips re-ingesting an unchanged file (no delete, no upsert, but touches it)', async () => {
    const { store, chunks, deletedSources, touchedSources } = makeRecordingStore();
    const file = { path: 'stable.ts', content: 'const stable = 42;' };

    const first = await ingestFiles(store, 'ws-1', 'code', [{ ...file }]);
    expect(first.chunks).toBe(1);
    expect(first.skippedUnchanged).toBe(0);
    const chunksAfterFirst = chunks.size;
    const deletesAfterFirst = deletedSources.length;

    // Same content → hash matches → fully skipped.
    const second = await ingestFiles(store, 'ws-1', 'code', [{ ...file }]);
    expect(second.skippedUnchanged).toBe(1);
    expect(second.chunks).toBe(0);
    expect(chunks.size).toBe(chunksAfterFirst); // nothing re-written
    expect(deletedSources.length).toBe(deletesAfterFirst); // deleteBySource NOT called
    // But the skipped file is touched so a full-scope sweep won't prune it.
    expect(touchedSources).toEqual([{ namespace: 'ws-1:code', sourcePaths: ['stable.ts'] }]);
  });

  it('re-ingests when a file changes (hash differs)', async () => {
    const { store } = makeRecordingStore();
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'x.ts', content: 'const x = 1;' }]);
    const changed = await ingestFiles(store, 'ws-1', 'code', [{ path: 'x.ts', content: 'const x = 2;' }]);
    expect(changed.skippedUnchanged).toBe(0);
    expect(changed.chunks).toBe(1);
  });
});

// ── pruneOrphans ──────────────────────────────────────────────────────────────

describe('pruneOrphans', () => {
  it('deletes chunks for files no longer in the seen set', async () => {
    const { store, chunks, deletedSources } = makeRecordingStore();
    await ingestFiles(store, 'ws-1', 'code', [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.ts', content: 'const b = 2;' },
    ]);

    // Second walk found only a.ts — b.ts was deleted on disk.
    const orphans = await pruneOrphans(store, 'ws-1', 'code', '', new Set(['a.ts']));

    expect(orphans).toEqual(['b.ts']);
    expect(deletedSources.some(d => d.namespace === 'ws-1:code' && d.sourcePath === 'b.ts')).toBe(true);
    expect([...chunks.values()].some(c => c.sourcePath === 'b.ts')).toBe(false);
    expect([...chunks.values()].some(c => c.sourcePath === 'a.ts')).toBe(true);
  });

  it('scopes pruning to the prefix — a walk of one dir never prunes another', async () => {
    const { store, chunks } = makeRecordingStore();
    // Same namespace populated by two separate directory walks (like the CI
    // code corpus over packages/ then apps/).
    await ingestFiles(store, 'ws-1', 'code', [
      { path: 'packages/core/x.ts', content: 'const x = 1;' },
      { path: 'apps/web/y.ts', content: 'const y = 2;' },
    ]);

    // Walk of apps/ finds nothing (all apps files deleted). Must NOT touch packages/.
    const orphans = await pruneOrphans(store, 'ws-1', 'code', 'apps', new Set());

    expect(orphans).toEqual(['apps/web/y.ts']);
    expect([...chunks.values()].some(c => c.sourcePath === 'packages/core/x.ts')).toBe(true);
    expect([...chunks.values()].some(c => c.sourcePath === 'apps/web/y.ts')).toBe(false);
  });

  it('prunes nothing when every stored file is still seen', async () => {
    const { store, deletedSources } = makeRecordingStore();
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'apps/keep.ts', content: 'const k = 1;' }]);
    const deletesBefore = deletedSources.length;

    const orphans = await pruneOrphans(store, 'ws-1', 'code', 'apps', new Set(['apps/keep.ts']));

    expect(orphans).toEqual([]);
    expect(deletedSources.length).toBe(deletesBefore);
  });

  it('is a no-op when the store lacks listSourcePaths', async () => {
    const minimal: KnowledgeStore = {
      async upsert() {},
      async query() { return []; },
      async delete() {},
      async listNamespaces() { return []; },
    };
    const orphans = await pruneOrphans(minimal, 'ws-1', 'code', 'apps', new Set());
    expect(orphans).toEqual([]);
  });
});
