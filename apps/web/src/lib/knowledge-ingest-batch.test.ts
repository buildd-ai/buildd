/**
 * ingestFileBatch and the plan knowledge-base cap: refused new docs are not
 * written, code is never capped, nothing stored is deleted for the cap, and
 * the batch result carries the refusal so the caller can show it.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

let refuseDocs = new Set<string>();
const admitCalls: string[][] = [];
mock.module('@buildd/core/billing-limits', () => ({
  admitDocsWithinCap: async (_ws: string, paths: string[]) => {
    admitCalls.push(paths);
    const refused = paths.filter(p => refuseDocs.has(p));
    return {
      admitted: paths.filter(p => !refuseDocs.has(p)),
      refused,
      cap: refused.length > 0 ? 50 : null,
      message: refused.length > 0 ? 'cap reached — Settings → Billing' : null,
    };
  },
}));

mock.module('@buildd/core/db', () => ({ db: { execute: async () => ({ rows: [] }) } }));

const written: Array<{ corpus: string; paths: string[] }> = [];
const deleted: string[] = [];
mock.module('@buildd/core/knowledge-store', () => ({
  PgVectorStore: class { async deleteBySource(_ns: string, sel: { sourcePath: string }) { deleted.push(sel.sourcePath); } },
  getVoyageEmbedder: () => null,
  buildNamespace: (ws: string, corpus: string) => `${ws}:${corpus}`,
  ingestFiles: async (_store: any, _ws: string, corpus: string, files: Array<{ path: string }>) => {
    written.push({ corpus, paths: files.map(f => f.path) });
    return { files: files.length, chunks: files.length };
  },
}));

const { ingestFileBatch } = await import('./knowledge-ingest-batch');

beforeEach(() => {
  refuseDocs = new Set();
  admitCalls.length = 0;
  written.length = 0;
  deleted.length = 0;
});

const files = [
  { path: 'src/app.ts', content: 'export const a = 1;' },
  { path: 'docs/kept.md', content: '# Kept' },
  { path: 'docs/new.md', content: '# New' },
];

describe('ingestFileBatch — plan knowledge-base cap', () => {
  it('asks the gate about docs only, never code', async () => {
    await ingestFileBatch('ws-1', files);
    expect(admitCalls).toEqual([['docs/kept.md', 'docs/new.md']]);
  });

  it('nothing refused: everything written, no message', async () => {
    const res = await ingestFileBatch('ws-1', files);
    expect(res.filesIngested).toBe(3);
    expect(res.filesRefusedByPlan).toBe(0);
    expect(res.planLimitMessage).toBeUndefined();
  });

  it('refused docs are not written; code and admitted docs are; nothing is deleted', async () => {
    refuseDocs = new Set(['docs/new.md']);
    const res = await ingestFileBatch('ws-1', files);
    expect(written).toEqual([
      { corpus: 'code', paths: ['src/app.ts'] },
      { corpus: 'docs', paths: ['docs/kept.md'] },
    ]);
    expect(deleted).toEqual([]);
    expect(res.filesIngested).toBe(2);
    expect(res.filesRefusedByPlan).toBe(1);
    expect(res.planLimitMessage).toContain('Settings → Billing');
  });
});
