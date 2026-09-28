import { describe, it, expect, mock } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE pg-vector-store is loaded — identical
// shape to the mock in knowledge-hit-tracking.test.ts (bun's mock.module is
// process-global; keeping the shape identical makes full-suite and standalone
// runs behave the same).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

/** Flatten a mocked sql fragment (strings/values or join parts) into text. */
function flattenSql(q: any): string {
  if (q === null || q === undefined) return '';
  if (typeof q !== 'object') return JSON.stringify(q);
  if (Array.isArray(q.parts)) return q.parts.map(flattenSql).join(', ');
  if (q.strings) {
    let out = '';
    const strings: string[] = Array.from(q.strings);
    const values: unknown[] = q.values ?? [];
    strings.forEach((s, i) => {
      out += s;
      if (i < values.length) {
        const v: any = values[i];
        out += v && typeof v === 'object' && (v.strings || v.parts) ? flattenSql(v) : JSON.stringify(v);
      }
    });
    return out;
  }
  return '';
}

interface PendingCall {
  text: string;
  resolve: (v: { rows: Array<Record<string, unknown>> }) => void;
}

let pending: PendingCall[] = [];
let autoResolveRows: Array<Record<string, unknown>> = [];

const mockDb = {
  execute: (q: unknown) => {
    const text = flattenSql(q);
    // Once the vector AND lexical queries have both been issued, resolve any
    // further call (the source-id fetch) immediately — the test only needs
    // to observe that the first two were issued concurrently.
    if (pending.length >= 2) {
      return Promise.resolve({ rows: autoResolveRows });
    }
    return new Promise(resolve => {
      pending.push({ text, resolve });
    });
  },
};

mock.module('../db/index', () => ({ db: mockDb }));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');

function chunkRow(id: string) {
  return {
    source_id: id,
    namespace: 'ws-1:task',
    corpus: 'task',
    source_type: 'task',
    source_path: null,
    source_url: null,
    content: `content of ${id}`,
    metadata: {},
  };
}

function mockEmbedder() {
  return {
    model: 'mock-model',
    dimensions: 4,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('PgVectorStore.query — hybrid mode runs vector + lexical concurrently', () => {
  it('issues the vector and lexical queries together — neither waits for the other to resolve first', async () => {
    pending = [];
    autoResolveRows = [chunkRow('a')];

    const store = new PgVectorStore(mockEmbedder() as any);
    const queryPromise = store.query('ws-1:task', {
      text: 'auth flow',
      useGraph: false,
      trackHits: false,
      recencyAuthority: false,
    });

    // Let the embed() call resolve and the Promise.all fire off both queries.
    await flush();
    await flush();

    const vectorCall = pending.find(p => p.text.includes('embedding <=>'));
    const lexicalCall = pending.find(p => p.text.includes('lexical_tsv'));

    // Both must have been ISSUED (db.execute called) before either resolved —
    // proving they run concurrently, not one after the other.
    expect(vectorCall).toBeDefined();
    expect(lexicalCall).toBeDefined();

    vectorCall!.resolve({ rows: [{ id: 'a', score: 0.9 }] });
    lexicalCall!.resolve({ rows: [{ id: 'a', score: 0.5 }] });

    const results = await queryPromise;
    expect(results.map(r => r.id)).toEqual(['a']);
  });
});
