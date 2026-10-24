/**
 * Acceptance checks for Living Spec fc80b5a4 "Living Specs: finding and
 * organising specs", revision 6: related specs and the duplicate shortlist read
 * the knowledge store's spec corpus (R-101 to R-106). Written before the build:
 * each test fails on the starting commit and passes once it is built. A check
 * named here is listed in the spec's metadata `verified_by`, keyed by its id.
 *
 * The one seam the tests fix is the one the code already has: the knowledge
 * store a spec reads and writes through is `specKnowledgeDeps.store()`. They
 * put a fake store behind it and watch what the neighbour and duplicate code
 * ask it, so nothing here names a function the build is free to add. A build
 * that routes spec-corpus reads some other way updates `corpusStore` below.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const knowledge = await import('../../src/lib/specs/knowledge');
const neighbours = await import('../../src/lib/specs/neighbours');
const decision = await import('../../src/lib/spec-duplicate-decision');
const { buildLivingSpecChunks } = await import('@buildd/core/knowledge-store');

const WS = '33333333-3333-4333-8333-333333333333';
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** A fake spec corpus: `answer` maps the text of one query to the chunks it returns. */
function fakeStore(answer: (text: string) => Array<{ specId: string; revision: number; criterionId?: string; score: number; content?: string; draft?: boolean }>) {
  const queries: Array<{ namespace: string; text: string; params: Record<string, unknown> }> = [];
  const store = {
    upsert: async () => undefined,
    deleteBySource: async () => undefined,
    delete: async () => undefined,
    listNamespaces: async () => [],
    query: async (namespace: string, params: { text: string } & Record<string, unknown>) => {
      queries.push({ namespace, text: params.text, params });
      return answer(params.text).map((h) => ({
        id: h.criterionId ? `living-spec:${h.specId}@${h.revision}#${h.criterionId}` : `living-spec:${h.specId}#1`,
        namespace, corpus: 'spec', sourceType: 'living_spec', sourcePath: null, sourceUrl: null,
        content: h.content ?? `${h.criterionId ?? 'text'}`,
        metadata: { specId: h.specId, revision: h.revision, ...(h.criterionId ? { criterionId: h.criterionId, criterion: h.criterionId } : {}), ...(h.draft ? { draft: true } : {}) },
        score: h.score, scoreBreakdown: { dense: h.score },
      }));
    },
  };
  return { store, queries };
}

const realStore = knowledge.specKnowledgeDeps.store;
const realFetch = globalThis.fetch;
let fetches: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => { fetches.push(String((input as { url?: string })?.url ?? input)); throw new Error('network is off in this test'); }) as typeof fetch;
});
afterAll(() => {
  knowledge.specKnowledgeDeps.store = realStore;
  globalThis.fetch = realFetch;
});
const corpusStore = (s: unknown) => { knowledge.specKnowledgeDeps.store = async () => s as never; };

describe('R-101: similarity has one source, the spec corpus', () => {
  it('AC-138: `similar` ranks a spec from the spec corpus chunks and makes no embedding request of its own', async () => {
    fetches = [];
    const { store, queries } = fakeStore(() => [{ specId: OTHER, revision: 1, score: 0.8 }]);
    corpusStore(store);
    const hits = await knowledge.specCorpusSimilar({ workspaceId: WS, specId: ME, text: 'Checkout\n\n- R-1: Totals are in the shopper currency.' });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.namespace === `${WS}:spec`)).toBe(true);
    expect(hits.map((h) => h.specId)).toContain(OTHER);
    expect(fetches).toEqual([]);
  });

  it('R-101: the neighbour code holds no embedder or key of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dir, '../../src/lib/specs/neighbours.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Voyage|embedder|embedding|API_KEY/i);
    const similar = readFileSync(join(import.meta.dir, '../../src/lib/specs/knowledge.ts'), 'utf8')
      .split('specCorpusSimilar')[1]!.split('installSpecSimilarity')[0]!;
    expect(similar).not.toMatch(/getVoyageEmbedder|new ks\.PgVectorStore|new PgVectorStore/);
  });
});

describe('R-102: criteria are indexed one per chunk, and the reason names them', () => {
  const body = [
    '# Basket', '', '## Totals', '', '- R-7: Totals are shown in the shopper currency.', '- AC-3: A zero total reads as free.', '',
    '## Empty state', '', '- AC-4: An empty basket shows a friendly message.', '',
  ].join('\n');

  it('R-102: an approved revision is one chunk per criterion, keyed living-spec:<specId>@<revision>#<id>, carrying its id and section', async () => {
    const chunks = await buildLivingSpecChunks({
      specId: ME, workspaceId: WS, title: 'Basket', body, revision: 2, contentHash: 'h', parentSpecId: null, scope: 'feature',
      approvedAt: new Date('2026-10-11T12:00:00Z'), sourceUrl: 'https://example.test/s',
    });
    const byId = new Map(chunks.map((c) => [c.id, c]));
    for (const id of ['R-7', 'AC-3', 'AC-4']) expect(byId.has(`living-spec:${ME}@2#${id}`)).toBe(true);
    const ac4 = byId.get(`living-spec:${ME}@2#AC-4`)!;
    expect(ac4.content).toContain('friendly message');
    expect(JSON.stringify(ac4.metadata)).toContain('AC-4');
    expect(JSON.stringify(ac4.metadata)).toContain('Empty state');
    // The sections and the whole text stay indexed beside the criteria.
    expect(chunks.length).toBeGreaterThan(3);
  });

  it('AC-139: a criterion that matches another spec\'s criterion is named on both sides in the reason', async () => {
    fetches = [];
    // Only AC-3's own words reach the other spec's R-7; nothing else matches.
    const { store } = fakeStore((text) => (text.includes('A zero total reads as free') && !text.includes('shopper currency')
      ? [{ specId: OTHER, revision: 1, criterionId: 'R-7', score: 0.82, content: 'R-7: A zero basket is shown as free.' }]
      : []));
    corpusStore(store);
    const text = `Basket\n\n${body}`;
    const hits = await knowledge.specCorpusSimilar({ workspaceId: WS, specId: ME, text });
    const rows = neighbours.pickSimilar(hits, new Set([ME]));
    expect(rows.map((r) => r.neighborSpecId)).toEqual([OTHER]);
    const reason = neighbours.neighbourReason('similar', rows[0]!.detail);
    expect(reason).toContain('AC-3');
    expect(reason).toContain('R-7');
  });
});

describe('R-103: nothing the reader sees mentions embeddings, keys or providers', () => {
  const FORBIDDEN = /embed|\bkeys?\b|provider|voyage|vector/i;

  it('AC-140: a neighbour\'s reason is in words, for every kind', () => {
    const details: Array<Record<string, unknown> | null> = [null, { files: 1 }, { files: 4 }, { relation: 'duplicate' }, { relation: 'overlap' },
      { pairs: [{ here: 'AC-3', there: 'R-7' }] }, { pairs: [{ here: 'AC-3', there: 'R-7' }, { here: 'AC-4', there: 'R-8' }] }];
    for (const kind of neighbours.NEIGHBOUR_KINDS) for (const d of details) expect(neighbours.neighbourReason(kind, d)).not.toMatch(FORBIDDEN);
  });

  it('AC-140: a duplicate check that cannot run says so without naming a key or a provider', async () => {
    const { store } = fakeStore(() => [{ specId: OTHER, revision: 1, criterionId: 'AC-4', score: 0.8 }]);
    corpusStore(store);
    const pool = [{ specId: OTHER, title: 'Basket', card: decision.specCard('Basket', '# Basket\n- AC-4: An empty basket shows a friendly message.') },
      { specId: ME, title: 'Sign in', card: decision.specCard('Sign in', '# Sign in\n- AC-1: A wrong password says so.') }];
    for (const cause of ['no_provider', 'disabled', 'error']) {
      const out = await decision.checkSpecDuplicates(
        { workspaceId: WS, title: 'Cart', body: '# Basket\n- AC-4: An empty basket shows a friendly message.' },
        { teamOf: async () => 'team', approved: async () => pool, judge: async () => ({ response: { decision: 'distinct', confidence: null, source: 'fallback', fallbackCause: cause } as never, recordId: null }) },
      );
      expect(out.ran).toBe(false);
      expect((out as { reason: string }).reason).not.toMatch(FORBIDDEN);
    }
  });
});

describe('R-104: the duplicate shortlist reads the corpus by criterion', () => {
  const OLD = '# Basket\n\n- AC-4: An empty basket shows a friendly message.\n- AC-5: Quantities cannot go below one.\n';
  const NEW = '# Cart\n\n- R-1: Quantities cannot be lowered past a single unit.\n- R-2: No items: display the zero-state notice.\n';
  const pool = [{ specId: OTHER, title: 'Basket', card: decision.specCard('Basket', OLD) }];

  it('R-104: the separate TF-IDF pass is removed from the duplicate check', () => {
    expect((decision as Record<string, unknown>).tfidfShortlist).toBeUndefined();
  });

  it('AC-141: a paraphrase that shares no words is shortlisted, with AC-4 and R-2 as the matched pair', async () => {
    // The corpus answers for R-2's words only, returning the other spec's AC-4.
    const { store, queries } = fakeStore((text) => (text.includes('zero-state notice')
      ? [{ specId: OTHER, revision: 3, criterionId: 'AC-4', score: 0.86, content: 'AC-4: An empty basket shows a friendly message.' }]
      : []));
    corpusStore(store);
    const seen: unknown[] = [];
    const out = await decision.checkSpecDuplicates(
      { workspaceId: WS, title: 'Cart', body: NEW },
      {
        teamOf: async () => 'team', approved: async () => pool,
        judge: async (pair) => { seen.push(pair); return { response: { decision: 'duplicate', confidence: 0.97, source: 'model', fallbackCause: null } as never, recordId: null }; },
      },
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(out.ran).toBe(true);
    const blocking = (out as { blocking: unknown[] }).blocking;
    expect(blocking).toHaveLength(1);
    const named = JSON.stringify(blocking[0]);
    expect(named).toContain(OTHER);
    expect(named).toContain('AC-4');
    expect(named).toContain('R-2');
    // The model reads the matched criteria side by side, not only the whole specs.
    expect(JSON.stringify(seen)).toContain('friendly message');
  });

  it('R-104: at most five specs are shortlisted, aggregated by spec', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const { store } = fakeStore(() => ids.flatMap((specId, i) => [
      { specId, revision: 1, criterionId: 'AC-1', score: 0.9 - i / 100 }, { specId, revision: 1, criterionId: 'AC-2', score: 0.8 - i / 100 },
    ]));
    corpusStore(store);
    const bigPool = ids.map((specId, i) => ({ specId, title: `S${i}`, card: decision.specCard(`S${i}`, `# S${i}\n- AC-1: x${i}\n`) }));
    let judged = 0;
    await decision.checkSpecDuplicates(
      { workspaceId: WS, title: 'Cart', body: NEW },
      { teamOf: async () => 'team', approved: async () => bigPool, judge: async () => { judged++; return { response: { decision: 'distinct', confidence: 0.9, source: 'model', fallbackCause: null } as never, recordId: null }; } },
    );
    expect(judged).toBe(5);
  });
});
