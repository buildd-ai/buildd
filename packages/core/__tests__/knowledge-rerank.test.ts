import { describe, it, expect } from 'bun:test';
import { applyRerank } from '../knowledge-store/reranker';
import type { Reranker, QueryResult } from '../knowledge-store/types';

function makeResult(id: string, content: string): QueryResult {
  return {
    id,
    namespace: 'ws-1:memory',
    corpus: 'memory',
    sourceType: 'memory',
    sourcePath: null,
    sourceUrl: null,
    content,
    metadata: {},
    score: 0,
  };
}

// A mock reranker that scores by how many query terms appear in the document.
function termOverlapReranker(): Reranker {
  return {
    model: 'mock-rerank',
    async rerank(query, documents, topK) {
      const terms = query.toLowerCase().split(/\s+/);
      const scored = documents.map((doc, index) => {
        const lc = doc.toLowerCase();
        const score = terms.filter(t => lc.includes(t)).length;
        return { index, score };
      });
      scored.sort((a, b) => b.score - a.score);
      return topK ? scored.slice(0, topK) : scored;
    },
  };
}

describe('applyRerank', () => {
  it('reorders candidates by reranker relevance', async () => {
    const candidates = [
      makeResult('a', 'the cat sat on the mat'),
      makeResult('b', 'codex backend worker agent engine'),
      makeResult('c', 'something unrelated entirely'),
    ];
    const reranked = await applyRerank(termOverlapReranker(), 'codex backend agent', candidates);
    expect(reranked[0].id).toBe('b'); // most query-term overlap rises to the top
  });

  it('rewrites scores from the reranker', async () => {
    const candidates = [makeResult('a', 'codex agent'), makeResult('b', 'nothing')];
    const reranked = await applyRerank(termOverlapReranker(), 'codex agent', candidates);
    expect(reranked[0].score).toBeGreaterThan(reranked[1].score);
  });

  it('respects topK by trimming the candidate set', async () => {
    const candidates = [
      makeResult('a', 'codex one'),
      makeResult('b', 'codex two'),
      makeResult('c', 'codex three'),
    ];
    const reranked = await applyRerank(termOverlapReranker(), 'codex', candidates, 2);
    expect(reranked).toHaveLength(2);
  });

  it('returns the input unchanged when there are no candidates', async () => {
    const reranked = await applyRerank(termOverlapReranker(), 'q', []);
    expect(reranked).toEqual([]);
  });

  it('preserves the original result objects (content, metadata, source)', async () => {
    const candidates = [makeResult('a', 'codex agent backend')];
    candidates[0].sourceUrl = '/app/memory/a';
    candidates[0].metadata = { type: 'gotcha' };
    const reranked = await applyRerank(termOverlapReranker(), 'codex', candidates);
    expect(reranked[0].sourceUrl).toBe('/app/memory/a');
    expect(reranked[0].metadata).toEqual({ type: 'gotcha' });
  });
});
