import { describe, it, expect, afterEach } from 'bun:test';
import { fileToChunks, ingestFiles } from '../knowledge-store/ingest';
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
  };
  return { store, chunks, deletedSources };
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
});
