import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm before pg-vector-store loads — same shape as knowledge-hit-tracking.test.ts
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
let contentHashResponder: (text: string) => { rows: Array<Record<string, unknown>> } =
  () => ({ rows: [] });

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
    return Promise.resolve(contentHashResponder(text));
  },
};

mock.module('../db/index', () => ({ db: mockDb }));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');

function makeStore() {
  return new PgVectorStore(null);
}

beforeEach(() => {
  executed = [];
  contentHashResponder = () => ({ rows: [] });
});

function inserts() {
  return executed.filter(e => e.text.includes('INSERT INTO knowledge_chunks'));
}

function contentHashLookups() {
  return executed.filter(e => e.text.includes('content_hash') && e.text.includes('SELECT source_id'));
}

describe('PgVectorStore.upsert — contentDedup', () => {
  it('does NOT skip a chunk when contentDedup is false (default)', async () => {
    const store = makeStore();
    await store.upsert('ws-1:pr', [
      {
        id: 'pr:1#src/foo.ts',
        content: 'diff content here',
        sourceType: 'pr',
      },
    ]);
    expect(inserts()).toHaveLength(1);
    expect(contentHashLookups()).toHaveLength(0);
  });

  it('does NOT skip a chunk when contentDedup is true but no matching hash exists', async () => {
    // Responder returns no rows → content is new → proceed with insert
    contentHashResponder = () => ({ rows: [] });
    const store = makeStore();
    await store.upsert('ws-1:pr', [
      {
        id: 'pr:1#src/foo.ts',
        content: 'diff content here',
        sourceType: 'pr',
        contentDedup: true,
      },
    ]);
    expect(contentHashLookups()).toHaveLength(1);
    expect(inserts()).toHaveLength(1);
  });

  it('skips a chunk when contentDedup is true and content_hash matches a different source_id', async () => {
    // Responder returns a row with a DIFFERENT source_id → duplicate → skip
    contentHashResponder = (text) => {
      if (text.includes('content_hash') && text.includes('SELECT source_id')) {
        return { rows: [{ source_id: 'pr:99#src/foo.ts' }] };
      }
      return { rows: [] };
    };
    const store = makeStore();
    await store.upsert('ws-1:pr', [
      {
        id: 'pr:1#src/foo.ts',
        content: 'diff content here',
        sourceType: 'pr',
        contentDedup: true,
      },
    ]);
    expect(contentHashLookups()).toHaveLength(1);
    // INSERT must NOT have been called (chunk was skipped)
    expect(inserts()).toHaveLength(0);
  });

  it('does NOT skip when the matching content_hash belongs to the SAME source_id (self-update)', async () => {
    // When the only row with that hash is the same source_id, it's an update — proceed
    contentHashResponder = (text) => {
      if (text.includes('content_hash') && text.includes('SELECT source_id')) {
        // The store queries WHERE source_id != $currentId, so return no rows for a self-match
        return { rows: [] };
      }
      return { rows: [] };
    };
    const store = makeStore();
    await store.upsert('ws-1:pr', [
      {
        id: 'pr:1#src/foo.ts',
        content: 'diff content here',
        sourceType: 'pr',
        contentDedup: true,
      },
    ]);
    expect(inserts()).toHaveLength(1);
  });

  it('skips only dedup-marked chunks in a mixed batch', async () => {
    contentHashResponder = (text) => {
      if (text.includes('content_hash') && text.includes('SELECT source_id')) {
        return { rows: [{ source_id: 'pr:99#src/foo.ts' }] };
      }
      return { rows: [] };
    };
    const store = makeStore();
    await store.upsert('ws-1:pr', [
      { id: 'summary:1', content: 'pr summary', sourceType: 'pr' },            // no dedup
      {
        id: 'pr:1#src/foo.ts',
        content: 'diff content here',
        sourceType: 'pr',
        contentDedup: true,  // duplicate — skip
      },
    ]);
    expect(inserts()).toHaveLength(1);
    const insertedId = executed
      .filter(e => e.text.includes('INSERT INTO knowledge_chunks'))
      .flatMap(e => e.values)
      .find(v => typeof v === 'string' && (v as string).startsWith('summary:'));
    expect(insertedId).toBe('summary:1');
  });
});
