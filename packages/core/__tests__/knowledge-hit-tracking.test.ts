import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE pg-vector-store is loaded — identical
// shape to the mock in knowledge-supersession.test.ts (bun's mock.module is
// process-global; keeping the shape identical makes full-suite and standalone
// runs behave the same).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

// ── Recording DB mock ─────────────────────────────────────────────────────────

interface Executed {
  text: string;
  values: unknown[];
}

let executed: Executed[] = [];
let responder: (text: string) => { rows: Array<Record<string, unknown>> } = () => ({ rows: [] });

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

/** Recursively collect scalar bind values from a mocked sql fragment. */
function collectValues(q: any, acc: unknown[] = []): unknown[] {
  if (q === null || q === undefined || typeof q !== 'object') {
    acc.push(q);
    return acc;
  }
  if (Array.isArray(q.parts)) {
    for (const p of q.parts) collectValues(p, acc);
    return acc;
  }
  if (q.strings) {
    for (const v of q.values ?? []) collectValues(v, acc);
    return acc;
  }
  acc.push(q);
  return acc;
}

const mockDb = {
  execute: (q: unknown) => {
    const text = flattenSql(q);
    executed.push({ text, values: collectValues(q) });
    return Promise.resolve(responder(text));
  },
};

mock.module('../db/index', () => ({ db: mockDb }));

// Dynamic import runs AFTER mock.module — pg-vector-store picks up the mocks.
const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');

function makeStore() {
  // null embedder → lexical-only query path (no embedding round-trip)
  return new PgVectorStore(null);
}

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

/** Default responder: lexical rank query returns two hits; fetch returns rows. */
function lexicalResponder(text: string): { rows: Array<Record<string, unknown>> } {
  if (text.includes('ts_rank') && text.includes('AS score')) {
    return { rows: [{ id: 'chunk-a', score: 0.9 }, { id: 'chunk-b', score: 0.4 }] };
  }
  if (text.includes('SELECT source_id, namespace, corpus')) {
    return { rows: [chunkRow('chunk-a'), chunkRow('chunk-b')] };
  }
  return { rows: [] };
}

function hitUpdates() {
  return executed.filter(e => e.text.includes('hit_count'));
}

/** The hit UPDATE is fire-and-forget — flush pending microtasks/timers. */
async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  executed = [];
  responder = lexicalResponder;
});

describe('PgVectorStore.query — retrieval hit tracking', () => {
  it('fires a single hit UPDATE for the returned chunk ids', async () => {
    const store = makeStore();
    const results = await store.query('ws-1:task', { text: 'auth', useGraph: false });
    await flush();

    expect(results.map(r => r.id)).toEqual(['chunk-a', 'chunk-b']);

    const ups = hitUpdates();
    expect(ups).toHaveLength(1);
    const upd = ups[0];
    expect(upd.text).toContain('UPDATE knowledge_chunks');
    expect(upd.text).toContain('hit_count = hit_count + 1');
    expect(upd.text).toContain('last_hit_at');
    // Namespace-scoped and targets exactly the returned ids
    expect(upd.values).toContain('ws-1:task');
    expect(upd.values).toContain('chunk-a');
    expect(upd.values).toContain('chunk-b');
  });

  it('skips hit tracking when trackHits is false (eval/assessment runs)', async () => {
    const store = makeStore();
    const results = await store.query('ws-1:task', { text: 'auth', useGraph: false, trackHits: false });
    await flush();

    expect(results).toHaveLength(2);
    expect(hitUpdates()).toHaveLength(0);
  });

  it('records no hits for an empty result set', async () => {
    responder = () => ({ rows: [] });
    const store = makeStore();
    const results = await store.query('ws-1:task', { text: 'nothing', useGraph: false });
    await flush();

    expect(results).toEqual([]);
    expect(hitUpdates()).toHaveLength(0);
  });

  it('never fails the query when the hit UPDATE throws', async () => {
    responder = (text) => {
      if (text.includes('hit_count')) throw new Error('column "hit_count" does not exist');
      return lexicalResponder(text);
    };
    const store = makeStore();
    const results = await store.query('ws-1:task', { text: 'auth', useGraph: false });
    await flush();

    expect(results).toHaveLength(2);
  });

  it('does not block the query on the hit UPDATE (results return before it settles)', async () => {
    let resolveHit: (() => void) | null = null;
    const original = mockDb.execute;
    mockDb.execute = (q: unknown) => {
      const text = flattenSql(q);
      executed.push({ text, values: collectValues(q) });
      if (text.includes('hit_count')) {
        return new Promise(resolve => {
          resolveHit = () => resolve({ rows: [] });
        }) as Promise<{ rows: Array<Record<string, unknown>> }>;
      }
      return Promise.resolve(responder(text));
    };

    try {
      const store = makeStore();
      // Resolves even though the hit UPDATE promise is still pending
      const results = await store.query('ws-1:task', { text: 'auth', useGraph: false });
      expect(results).toHaveLength(2);
      expect(hitUpdates()).toHaveLength(1);
    } finally {
      resolveHit?.();
      mockDb.execute = original;
    }
  });
});
