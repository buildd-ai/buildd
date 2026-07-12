import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE pg-vector-store is loaded — identical
// shape to the mock in knowledge-entity-resolver.test.ts (bun's mock.module is
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
const { CORPUS_AUTHORITY } = await import('../knowledge-store/recency-authority');

function makeStore() {
  // null embedder → lexical-only insert path (no embedding round-trip)
  return new PgVectorStore(null);
}

function updates() {
  return executed.filter(e => e.text.includes('UPDATE knowledge_chunks'));
}

beforeEach(() => {
  executed = [];
  responder = () => ({ rows: [] });
});

// ── Explicit supersession via UpsertChunk.supersedes ─────────────────────────

describe('PgVectorStore.upsert — explicit supersedes', () => {
  it('marks each listed source_id superseded in the same namespace and counts matches', async () => {
    responder = (text) =>
      text.includes('UPDATE knowledge_chunks')
        ? { rows: [{ source_id: 'task:old-1' }, { source_id: 'task:old-2' }] }
        : { rows: [] };

    const store = makeStore();
    const result = await store.upsert('ws-1:task', [
      {
        id: 'task:new',
        content: 'new outcome',
        sourceType: 'task',
        supersedes: ['task:old-1', 'task:old-2'],
      },
    ]);

    const ups = updates();
    expect(ups).toHaveLength(1);
    const upd = ups[0];
    // Marks not-current and points superseded_by at the new chunk
    expect(upd.text).toContain('is_current = false');
    expect(upd.text).toContain('superseded_by');
    // Namespace isolation: the UPDATE is scoped to the upsert namespace
    expect(upd.text).toContain('namespace = ');
    expect(upd.values).toContain('ws-1:task');
    // Targets both listed ids, excludes the new chunk itself
    expect(upd.values).toContain('task:old-1');
    expect(upd.values).toContain('task:old-2');
    expect(upd.text).toContain('source_id != ');
    // Only current chunks are re-marked
    expect(upd.text).toContain('is_current = true');
    // Matched row count is surfaced
    expect(result).toEqual({ superseded: 2 });
  });

  it('ignores ids that do not exist — count reflects matched rows only', async () => {
    responder = (text) =>
      text.includes('UPDATE knowledge_chunks')
        ? { rows: [{ source_id: 'task:old-1' }] }
        : { rows: [] };

    const store = makeStore();
    const result = await store.upsert('ws-1:task', [
      {
        id: 'task:new',
        content: 'new outcome',
        sourceType: 'task',
        supersedes: ['task:old-1', 'task:missing'],
      },
    ]);

    expect(result).toEqual({ superseded: 1 });
  });

  it('skips self-references — a chunk cannot supersede itself', async () => {
    const store = makeStore();
    const result = await store.upsert('ws-1:task', [
      { id: 'task:new', content: 'x', sourceType: 'task', supersedes: ['task:new'] },
    ]);

    expect(updates()).toHaveLength(0);
    expect(result).toEqual({ superseded: 0 });
  });

  it('issues no supersession UPDATE when supersedes is absent or empty', async () => {
    const store = makeStore();
    const r1 = await store.upsert('ws-1:task', [
      { id: 'task:a', content: 'x', sourceType: 'task' },
    ]);
    const r2 = await store.upsert('ws-1:task', [
      { id: 'task:b', content: 'y', sourceType: 'task', supersedes: [] },
    ]);

    expect(updates()).toHaveLength(0);
    expect(r1).toEqual({ superseded: 0 });
    expect(r2).toEqual({ superseded: 0 });
  });

  it('cannot supersede across namespaces — UPDATE binds the upsert namespace', async () => {
    const store = makeStore();
    await store.upsert('ws-A:memory', [
      { id: 'mem-new', content: 'x', sourceType: 'memory', supersedes: ['mem-old'] },
    ]);

    const ups = updates();
    expect(ups).toHaveLength(1);
    expect(ups[0].values).toContain('ws-A:memory');
    // No other namespace appears anywhere in the statement
    const nsValues = ups[0].values.filter(v => typeof v === 'string' && String(v).includes(':'));
    expect(nsValues).toEqual(['ws-A:memory']);
  });

  it('degrades gracefully when the UPDATE fails (missing column pre-migration)', async () => {
    responder = (text) => {
      if (text.includes('UPDATE knowledge_chunks')) throw new Error('column does not exist');
      return { rows: [] };
    };
    const store = makeStore();
    const result = await store.upsert('ws-1:task', [
      { id: 'task:new', content: 'x', sourceType: 'task', supersedes: ['task:old'] },
    ]);
    expect(result).toEqual({ superseded: 0 });
  });
});

// ── Entity-keyed supersession ─────────────────────────────────────────────────

describe('PgVectorStore.markSupersededByEntities', () => {
  it('returns 0 and issues no SQL for an empty defines-set', async () => {
    const store = makeStore();
    const n = await store.markSupersededByEntities('ws-1:task', 'task:new', []);
    expect(n).toBe(0);
    expect(executed).toHaveLength(0);
  });

  it('supersedes chunks with an identical defines-set, older ts, and ≤ authority', async () => {
    responder = (text) =>
      text.includes('UPDATE knowledge_chunks')
        ? { rows: [{ source_id: 'task:old' }, { source_id: 'task:older' }] }
        : { rows: [] };

    const store = makeStore();
    const ts = new Date('2026-07-01T00:00:00.000Z');
    const n = await store.markSupersededByEntities('ws-1:task', 'task:new', ['ent-1', 'ent-2'], {
      sourceTs: ts,
    });

    expect(n).toBe(2);
    const ups = updates();
    expect(ups).toHaveLength(1);
    const upd = ups[0];

    // Strict identical defines-set: candidate has exactly N defines AND all N
    // are in the new chunk's set — disjoint or partial sets never match.
    expect(upd.text).toContain("ce.role = 'defines'");
    expect(upd.text).toMatch(/COUNT\(DISTINCT ce\.entity_id\)\s*=\s*2/);
    expect(upd.text).toContain('FILTER (WHERE ce.entity_id IN');
    expect(upd.values).toContain('ent-1');
    expect(upd.values).toContain('ent-2');

    // Older source_ts only: strict < comparison against the new chunk's ts
    // (a candidate with a NEWER ts is not superseded).
    expect(upd.text).toContain('source_ts IS NULL OR source_ts <');
    expect(upd.text).not.toContain('source_ts <=');
    expect(upd.values).toContain(ts.toISOString());

    // Namespace-scoped, self-excluded, current-only
    expect(upd.values).toContain('ws-1:task');
    expect(upd.text).toContain('source_id != ');
    expect(upd.text).toContain('is_current = true');
    expect(upd.text).toContain('is_current = false');
    expect(upd.values).toContain('task:new');
  });

  it('only allows corpora with authority ≤ the new chunk (memory example)', async () => {
    const store = makeStore();
    await store.markSupersededByEntities('ws-1:memory', 'mem-new', ['ent-1']);

    const upd = updates()[0];
    const memAuthority = CORPUS_AUTHORITY.memory;
    for (const [corpus, authority] of Object.entries(CORPUS_AUTHORITY)) {
      if (authority <= memAuthority) {
        expect(upd.values).toContain(corpus);
      } else {
        expect(upd.values).not.toContain(corpus);
      }
    }
  });

  it('higher-authority corpora are excluded for a task chunk', async () => {
    const store = makeStore();
    await store.markSupersededByEntities('ws-1:task', 'task:new', ['ent-1']);

    const upd = updates()[0];
    // task authority is 0.4 — memory (0.5), plan (0.6), code/docs/spec are all higher
    expect(upd.values).toContain('task');
    expect(upd.values).toContain('artifact');
    expect(upd.values).not.toContain('memory');
    expect(upd.values).not.toContain('plan');
    expect(upd.values).not.toContain('spec');
    expect(upd.values).not.toContain('code');
  });

  it('dedupes entity ids before matching', async () => {
    const store = makeStore();
    await store.markSupersededByEntities('ws-1:task', 'task:new', ['ent-1', 'ent-1', 'ent-2']);

    const upd = updates()[0];
    // Exact-set cardinality uses the DEDUPED count (2, not 3)
    expect(upd.text).toMatch(/COUNT\(DISTINCT ce\.entity_id\)\s*=\s*2/);
  });

  it('degrades gracefully when the tables do not exist', async () => {
    responder = () => {
      throw new Error('relation "chunk_entities" does not exist');
    };
    const store = makeStore();
    const n = await store.markSupersededByEntities('ws-1:task', 'task:new', ['ent-1']);
    expect(n).toBe(0);
  });
});
