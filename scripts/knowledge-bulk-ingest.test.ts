import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runBulkIngest, BulkIngestRefusal, type BulkIngestDeps } from './knowledge-bulk-ingest';
import type { EmbeddingConfig } from '../packages/core/knowledge-store/embedding-config';
import type { KnowledgeStore, UpsertChunk } from '../packages/core/knowledge-store/types';

const WS = '11111111-1111-4111-8111-111111111111';

const localCfg: EmbeddingConfig = {
  provider: 'openai_compat', baseUrl: 'http://gpu.tailnet:11434/v1', model: 'qwen3-embedding', apiKey: null,
  queryPrefix: '', docPrefix: '', matryoshka: false, pricePerMTokens: null, unmetered: true,
  timeoutMs: null, maxBatch: null, source: 'env',
};
const voyageCfg: EmbeddingConfig = { ...localCfg, provider: 'voyage', baseUrl: null, model: null, unmetered: false };

let repo: string;
let dir: string;

function fakeStore() {
  const upserts: UpsertChunk[][] = [];
  const hashes = new Map<string, string>();
  let failAfterUpserts = Infinity;
  const store: KnowledgeStore = {
    upsert: async (_ns: string, chunks: UpsertChunk[]) => {
      if (upserts.length >= failAfterUpserts) throw new Error('killed');
      upserts.push(chunks);
      for (const c of chunks) if (c.sourcePath && c.fileHash) hashes.set(c.sourcePath, c.fileHash);
      return { superseded: 0 };
    },
    getFileHashes: async (_ns: string, paths: string[]) => {
      const m = new Map<string, string>();
      for (const p of paths) if (hashes.has(p)) m.set(p, hashes.get(p)!);
      return m;
    },
    deleteBySource: async () => {},
  } as unknown as KnowledgeStore;
  return { store, upserts, hashes, killAfter: (n: number) => { failAfterUpserts = n; } };
}

function deps(store: KnowledgeStore, over: Partial<BulkIngestDeps> = {}): BulkIngestDeps {
  return {
    resolveConfig: async () => localCfg,
    isIngestEnabled: async () => true,
    makeStore: () => store,
    log: () => {},
    ...over,
  };
}

function put(rel: string, content: string) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

const opts = () => ({ repoPath: repo, workspaceId: WS, checkpointPath: join(dir, 'cp.json'), dryRun: false, batchSize: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bulk-ingest-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  put('src/a.ts', 'export const a = 1;\n');
  put('src/b.ts', 'export const b = 2;\n');
  put('README.md', '# hi\n\nthere\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('knowledge-bulk-ingest', () => {
  it('dry-run writes nothing and reports files, tokens and $0 when unmetered', async () => {
    const f = fakeStore();
    const res = await runBulkIngest({ ...opts(), dryRun: true }, deps(f.store));
    expect(f.upserts.length).toBe(0);
    expect(existsSync(join(dir, 'cp.json'))).toBe(false);
    expect(res.files).toBe(3);
    expect(res.estimatedTokens).toBeGreaterThan(0);
    expect(res.estimatedCostUsd).toBe(0);
  });

  it('dry-run prices tokens with the configured price', async () => {
    const f = fakeStore();
    const res = await runBulkIngest({ ...opts(), dryRun: true },
      deps(f.store, { resolveConfig: async () => ({ ...localCfg, unmetered: false, pricePerMTokens: 2 }) }));
    expect(res.estimatedCostUsd).toBeCloseTo((res.estimatedTokens * 2) / 1_000_000, 9);
  });

  it('excludes files the ingest filter rejects', async () => {
    put('node_modules/x/index.ts', 'x');
    put('src/a.test.ts', 'test');
    put('bun.lock', 'lock');
    put('image.png', 'png');
    const f = fakeStore();
    const res = await runBulkIngest(opts(), deps(f.store));
    const paths = f.upserts.flat().map(c => c.sourcePath);
    expect(new Set(paths)).toEqual(new Set(['src/a.ts', 'src/b.ts', 'README.md']));
    expect(res.files).toBe(3);
  });

  it('resumes after a kill without re-embedding completed files', async () => {
    const f = fakeStore();
    f.killAfter(2);
    await expect(runBulkIngest(opts(), deps(f.store))).rejects.toThrow('killed');
    const done = f.upserts.flat().map(c => c.sourcePath);
    expect(done.length).toBe(2);

    // A store that forgot every hash: only the checkpoint can prevent re-embedding.
    const g = fakeStore();
    const res = await runBulkIngest(opts(), deps(g.store));
    const again = g.upserts.flat().map(c => c.sourcePath);
    for (const p of done) expect(again).not.toContain(p);
    expect(again.length).toBe(1);
    expect(res.skippedCheckpoint).toBe(2);
  });

  it('skips a file whose hash is unchanged and re-embeds one that changed', async () => {
    const f = fakeStore();
    await runBulkIngest(opts(), deps(f.store));
    const first = f.upserts.length;
    rmSync(join(dir, 'cp.json'));
    const res = await runBulkIngest(opts(), deps(f.store));
    expect(f.upserts.length).toBe(first);
    expect(res.skippedUnchanged).toBe(3);

    put('src/a.ts', 'export const a = 99;\n');
    rmSync(join(dir, 'cp.json'));
    await runBulkIngest(opts(), deps(f.store));
    expect(f.upserts.slice(first).flat().map(c => c.sourcePath)).toEqual(['src/a.ts']);
  });

  it('ignores a checkpoint written for another model', async () => {
    const f = fakeStore();
    await runBulkIngest(opts(), deps(f.store));
    const cp = JSON.parse(readFileSync(join(dir, 'cp.json'), 'utf8'));
    expect(cp.embeddingModel).toBe('qwen3-embedding');
    const g = fakeStore();
    await runBulkIngest(opts(), deps(g.store, { resolveConfig: async () => ({ ...localCfg, model: 'other' }) }));
    expect(g.upserts.flat().length).toBeGreaterThan(0);
  });

  it('refuses the platform Voyage key', async () => {
    const f = fakeStore();
    await expect(runBulkIngest(opts(), deps(f.store, { resolveConfig: async () => voyageCfg })))
      .rejects.toBeInstanceOf(BulkIngestRefusal);
    expect(f.upserts.length).toBe(0);
  });

  it('refuses an openai_compat config missing its endpoint', async () => {
    const f = fakeStore();
    await expect(runBulkIngest(opts(), deps(f.store, { resolveConfig: async () => ({ ...localCfg, baseUrl: null }) })))
      .rejects.toBeInstanceOf(BulkIngestRefusal);
  });

  it('refuses when the workspace has ingest switched off, even on dry-run', async () => {
    const f = fakeStore();
    const off = deps(f.store, { isIngestEnabled: async () => false });
    await expect(runBulkIngest(opts(), off)).rejects.toThrow(/ingest.*off|disabled/i);
    await expect(runBulkIngest({ ...opts(), dryRun: true }, off)).rejects.toBeInstanceOf(BulkIngestRefusal);
    expect(f.upserts.length).toBe(0);
  });
});
