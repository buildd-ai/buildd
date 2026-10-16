import { describe, expect, it } from 'bun:test';
import { cardReadsVisualReview, loadCardVisualReviews } from './mission-card-visual-reviews';

const m = (id: string, tasks: Array<{ title: string; status: string }>, status = 'active') => ({ id, status, tasks });

describe('cardReadsVisualReview (b4ea396b follow-up 2)', () => {
  it('reads it while an audit or a fix from one is open', () => {
    expect(cardReadsVisualReview(m('a', [{ title: '[surface audit] X', status: 'pending' }]))).toBe(true);
    expect(cardReadsVisualReview(m('b', [{ title: '[surface audit] X', status: 'completed' }, { title: '[surface fix] /app: y', status: 'in_progress' }]))).toBe(true);
  });
  it('skips a mission whose audit rounds are finished, or one that is closed', () => {
    expect(cardReadsVisualReview(m('c', [{ title: '[surface audit] X', status: 'completed' }, { title: '[surface audit] round 2: X', status: 'cancelled' }]))).toBe(false);
    expect(cardReadsVisualReview(m('d', [{ title: '[surface audit] X', status: 'pending' }], 'completed'))).toBe(false);
    expect(cardReadsVisualReview(m('e', [{ title: 'feat: x', status: 'pending' }]))).toBe(false);
  });
  it('loads only the missions that need it, and a failed load reads as no state', async () => {
    const seen: string[] = [];
    const out = await loadCardVisualReviews([
      m('open', [{ title: '[surface audit] X', status: 'pending' }]),
      m('done', [{ title: '[surface audit] X', status: 'completed' }]),
      m('broken', [{ title: '[surface audit] X', status: 'pending' }]),
    ], async (id) => { seen.push(id); if (id === 'broken') throw new Error('x'); return null; });
    expect(seen.sort()).toEqual(['broken', 'open']);
    expect([...out.keys()].sort()).toEqual(['broken', 'open']);
    expect(out.get('broken')).toBeNull();
  });
});
