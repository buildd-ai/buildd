/**
 * Spec similarity has one source, the knowledge store's spec corpus
 * ("Related specs" R-101, R-102; "Duplicates" R-104, R-106). The store is a
 * fake that records what it was asked; real Postgres is in
 * tests/db/spec-similarity.test.ts.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { QueryParams, QueryResult } from '@buildd/core/knowledge-store';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { specCorpusShortlist, specCorpusSimilar, specKnowledgeDeps } = await import('./knowledge');

const realStore = specKnowledgeDeps.store;
afterEach(() => { specKnowledgeDeps.store = realStore; });

const ME = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BODY = '# Cart\n\nThe cart page.\n\n## Totals\n\n- **R-1** Totals are in the shopper currency.\n- **AC-3** GIVEN a basket THEN it shows the empty state.\n';

const chunk = (specId: string, key: string, dense: number, meta: Record<string, unknown> = {}): QueryResult => ({
  id: `living-spec:${specId}@2#${key}`, namespace: 'w:spec', corpus: 'spec', sourceType: 'living_spec', sourcePath: null, sourceUrl: null,
  content: key, score: 0.03, metadata: { specId, revision: 2, draft: false, ...(/^(R|AC)-/.test(key) ? { criterionId: key } : {}), ...meta },
  scoreBreakdown: { dense },
});

function fakeStore(answer: (p: QueryParams) => QueryResult[]) {
  const asked: QueryParams[] = [];
  const embedded: string[][] = [];
  return {
    asked, embedded,
    store: {
      upsert: async () => {},
      query: async (_ns: string, p: QueryParams) => { asked.push(p); return answer(p); },
      embedQueries: async (_ns: string, texts: string[]) => { embedded.push(texts); return texts.map(() => [0, 0, 0, 1]); },
    },
  };
}

describe('similar for an approved spec probes with its own stored chunks (R-101, AC-138)', () => {
  it('makes no embedding call, reads approved text only, and leaves its own chunks out', async () => {
    const f = fakeStore(() => [chunk(B, 'text', 0.7)]);
    specKnowledgeDeps.store = async () => f.store as never;
    const hits = await specCorpusSimilar({ workspaceId: 'w', specId: ME, text: `Cart\n\n${BODY}`, body: BODY, revision: 4 });
    expect(f.embedded).toEqual([]);
    expect(f.asked.map((p) => p.nearChunkId)).toEqual([`living-spec:${ME}@4#text`, `living-spec:${ME}@4#R-1`, `living-spec:${ME}@4#AC-3`, `living-spec:${ME}@4#s1`, `living-spec:${ME}@4#s2`]);
    for (const p of f.asked) {
      expect(p).toMatchObject({ mode: 'hybrid', includeDrafts: false, useGraph: false, trackHits: false });
      expect(p.excludeSourceIdPrefixes).toEqual([`living-spec:${ME}`, `living-spec-draft:${ME}`]);
    }
    expect(hits).toEqual([{ specId: B, score: 0.7, source: 'vector', pair: null, chunkIds: [`living-spec:${B}@2#text`] }]);
  });

  it('AC-139: a criterion closer than either whole text is the reason', async () => {
    const f = fakeStore((p) => (p.nearChunkId?.endsWith('#AC-3') ? [chunk(B, 'R-7', 0.93)] : [chunk(B, 'text', 0.6)]));
    specKnowledgeDeps.store = async () => f.store as never;
    const [hit] = await specCorpusSimilar({ workspaceId: 'w', specId: ME, text: BODY, body: BODY, revision: 4 });
    expect(hit).toMatchObject({ specId: B, score: 0.93, pair: { here: 'AC-3', there: 'R-7' } });
  });

  it('free text (a new spec, a suggested parent) is embedded once, as one batch', async () => {
    const f = fakeStore(() => []);
    specKnowledgeDeps.store = async () => f.store as never;
    await specCorpusSimilar({ workspaceId: 'w', specId: ME, text: BODY });
    expect(f.embedded.length).toBe(1);
    expect(f.asked.every((p) => Array.isArray(p.embedding) && !p.nearChunkId)).toBe(true);
  });
});

describe('the duplicate shortlist (R-104, R-106)', () => {
  it('matches each criterion and section of the new text, drafts included, at most 5 specs', async () => {
    const f = fakeStore(() => Array.from({ length: 8 }, (_, i) => chunk(`${i}${B.slice(1)}`, 'R-2', 0.9 - i / 100)));
    specKnowledgeDeps.store = async () => f.store as never;
    const got = await specCorpusShortlist({ workspaceId: 'w', title: 'Cart', body: BODY, drafts: true });
    expect(got).toHaveLength(5);
    expect(f.asked.map((p) => p.text.split('\n')[0])).toEqual(['R-1: Totals are in the shopper currency.', 'AC-3: GIVEN a basket THEN it shows the empty state.', '# Cart', '## Totals']);
    expect(f.asked.every((p) => p.includeDrafts === true)).toBe(true);
    expect(got[0]!.pairs[0]).toMatchObject({ here: 'R-1', there: 'R-2' });
  });

  it('a revise probes only the criteria it added or changed', async () => {
    const f = fakeStore(() => []);
    specKnowledgeDeps.store = async () => f.store as never;
    await specCorpusShortlist({ workspaceId: 'w', title: 'Cart', body: BODY, criteria: ['AC-3'], excludeSpecId: ME, drafts: true });
    expect(f.asked.map((p) => p.text)).toEqual(['AC-3: GIVEN a basket THEN it shows the empty state.']);
    expect(f.asked[0]!.excludeSourceIdPrefixes).toEqual([`living-spec:${ME}`, `living-spec-draft:${ME}`]);
  });
});
