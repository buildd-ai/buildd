/**
 * The decisions client: the request it sends is the shared
 * `VisualReviewDecisionRequest`, the URLs are the S2 routes, errors keep the
 * server's body (a 409 stale carries the fresh model), and the optimistic
 * helpers change exactly the decided cells. Illustrative fixtures only.
 */
import { describe, expect, it, mock } from 'bun:test';
import type { VisualReviewDecisionRequest, VisualReviewModel } from '@buildd/shared';
import { VISUAL_REVIEW_MAX_ARTIFACTS } from '@buildd/shared';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import {
  VisualReviewRequestError,
  applyOptimisticDecision,
  applyOptimisticUndo,
  buildDecisionRequest,
  chunkCells,
  createHttpVisualReviewTransport,
  visualReviewDecisionsUrl,
  visualReviewUndoUrl,
} from './review-transport';

const model = (): VisualReviewModel => buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });
const cell = (m: VisualReviewModel, route: string, viewport: 'mobile' | 'desktop') =>
  m.cells.find(c => c.route === route && c.viewport === viewport)!;

describe('buildDecisionRequest', () => {
  it('sends artifact ids, the decision, the expected agent verdicts and a trimmed note', () => {
    const m = model();
    const a = cell(m, '/app/missions/:id', 'mobile');
    const b = cell(m, '/app/missions/:id', 'desktop');
    const req: VisualReviewDecisionRequest = buildDecisionRequest({ cells: [a, b], decision: 'needs_fix', note: '  Two headings.  ' });
    expect(req).toEqual({
      artifactIds: [a.current.shot.id, b.current.shot.id],
      decision: 'needs_fix',
      note: 'Two headings.',
      expected: { [a.current.shot.id]: 'unsure', [b.current.shot.id]: 'ok' },
    });
    // Only the contract's keys: the client never sends a title or a relation.
    expect(Object.keys(req).sort()).toEqual(['artifactIds', 'decision', 'expected', 'note']);
  });

  it('omits an empty note and de-duplicates artifacts', () => {
    const m = model();
    const a = cell(m, '/app/tasks', 'desktop');
    const req = buildDecisionRequest({ cells: [a, a], decision: 'looks_right', note: '   ' });
    expect(req.artifactIds).toEqual([a.current.shot.id]);
    expect('note' in req).toBe(false);
  });

  it('refuses an empty or oversized request', () => {
    expect(() => buildDecisionRequest({ cells: [], decision: 'looks_right' })).toThrow();
    const m = model();
    const many = Array.from({ length: VISUAL_REVIEW_MAX_ARTIFACTS + 1 }, (_, i) => ({
      ...m.cells[0], current: { ...m.cells[0].current, shot: { ...m.cells[0].current.shot, id: `a${i}` } },
    }));
    expect(() => buildDecisionRequest({ cells: many, decision: 'looks_right' })).toThrow();
    expect(chunkCells(many).map(c => c.length)).toEqual([VISUAL_REVIEW_MAX_ARTIFACTS, 1]);
  });
});

describe('http transport', () => {
  it('POSTs the request to the decisions route and DELETEs the review to undo', async () => {
    const m = model();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ reviews: [], fixTaskId: null, cancelledFixTaskId: null, guidanceTaskId: null, model: m }), { status: 200 });
    });
    const t = createHttpVisualReviewTransport('mission 1', fetchImpl as unknown as typeof fetch);
    const req = buildDecisionRequest({ cells: [m.cells[0]], decision: 'looks_right' });
    const res = await t.decide(req);
    expect(res.model.missionId).toBe(m.missionId);
    expect(calls[0].url).toBe('/api/missions/mission%201/visual-review/decisions');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(req);
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    await t.undo('review/1');
    expect(calls[1].url).toBe('/api/missions/mission%201/visual-review/decisions/review%2F1');
    expect(calls[1].init.method).toBe('DELETE');
    expect(visualReviewDecisionsUrl('m')).toBe('/api/missions/m/visual-review/decisions');
    expect(visualReviewUndoUrl('m', 'r')).toBe('/api/missions/m/visual-review/decisions/r');
  });

  it('throws a typed error that keeps a 409 stale body', async () => {
    const m = model();
    const body = { error: 'stale', stale: true, cells: [m.cells[0]], model: m };
    const t = createHttpVisualReviewTransport('m', (async () => new Response(JSON.stringify(body), { status: 409 })) as unknown as typeof fetch);
    const err = await t.decide(buildDecisionRequest({ cells: [m.cells[0]], decision: 'looks_right' })).catch(e => e);
    expect(err).toBeInstanceOf(VisualReviewRequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('stale');
    expect(err.stale?.model.missionId).toBe(m.missionId);
  });

  it('reports a non-JSON failure without a stale body', async () => {
    const t = createHttpVisualReviewTransport('m', (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch);
    const err = await t.undo('r').catch(e => e);
    expect(err).toBeInstanceOf(VisualReviewRequestError);
    expect(err.status).toBe(500);
    expect(err.stale).toBeNull();
    expect(err.message.length).toBeGreaterThan(0);
  });
});

describe('optimistic apply', () => {
  it('marks the decided cells with a review, marker, effective verdict and counts', () => {
    const m = model();
    const unsure = cell(m, '/app/missions/:id', 'mobile');
    const { model: next, reviewIds } = applyOptimisticDecision(m, { cells: [unsure], decision: 'looks_right' }, 0);
    const after = cell(next, '/app/missions/:id', 'mobile');
    expect(after.current.review?.relation).toBe('waive');
    expect(after.marker).toBe('waived');
    expect(after.needsHuman).toBe(false);
    expect(after.effectiveVerdict).toBe('ok');
    expect(next.summary.awaitingHuman).toBe(m.summary.awaitingHuman - 1);
    expect(next.summary.reviewed).toBe(m.summary.reviewed + 1);
    expect(next.summary.waived).toBe(m.summary.waived + 1);
    expect(reviewIds).toHaveLength(1);
    // Other cells untouched, and the input is not mutated.
    expect(cell(m, '/app/missions/:id', 'mobile').current.review).toBeNull();
    expect(cell(next, '/app/tasks', 'desktop')).toEqual(cell(m, '/app/tasks', 'desktop'));
  });

  it('derives dispute and agree from the agent verdict', () => {
    const m = model();
    const issue = cell(m, '/app/settings', 'desktop');
    const ok = cell(m, '/app/tasks', 'desktop');
    const a = applyOptimisticDecision(m, { cells: [issue], decision: 'looks_right' }, 0).model;
    expect(cell(a, '/app/settings', 'desktop').marker).toBe('disputed');
    const b = applyOptimisticDecision(m, { cells: [ok], decision: 'looks_right' }, 0).model;
    expect(cell(b, '/app/tasks', 'desktop').marker).toBe('confirmed');
    const c = applyOptimisticDecision(m, { cells: [ok], decision: 'needs_fix' }, 0).model;
    expect(cell(c, '/app/tasks', 'desktop').effectiveVerdict).toBe('issue');
  });

  it('undo removes the reviews again', () => {
    const m = model();
    const unsure = cell(m, '/app/missions/:id', 'mobile');
    const { model: next, reviewIds } = applyOptimisticDecision(m, { cells: [unsure], decision: 'needs_fix' }, 0);
    const back = applyOptimisticUndo(next, reviewIds);
    expect(cell(back, '/app/missions/:id', 'mobile').current.review).toBeNull();
    expect(cell(back, '/app/missions/:id', 'mobile').needsHuman).toBe(true);
    expect(back.summary.awaitingHuman).toBe(m.summary.awaitingHuman);
    expect(back.summary.reviewed).toBe(m.summary.reviewed);
  });
});
