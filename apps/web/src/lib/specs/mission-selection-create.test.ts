import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * resolveCreateSelections (POST /api/missions outcomeSpec, Living Specs D-41):
 * the pin and the revision's change list are stubbed; the scope rule is real.
 */

const SPEC = '11111111-1111-4111-8111-111111111111';
let pinnedRevision = 4;
let body = '';
let reviewLines: unknown[] | null = [];
const reviewCalls: Array<{ from: number; to: number }> = [];

mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: SPEC, bodyArtifactId: 'body-1' }] }) }) }) },
}));
mock.module('./pin', () => ({
  pinSpecSource: async () => ({ ok: true, context: { specSource: { specRevisionId: `rev-${pinnedRevision}`, revision: pinnedRevision, contentHash: 'h' } } }),
  readPinnedSpecRevision: async () => ({ ok: true, body, title: 'Navigation' }),
}));
mock.module('./revision-changes', () => ({
  revisionReview: async (_spec: unknown, from: number, to: number) => { reviewCalls.push({ from, to }); return reviewLines ? { lines: reviewLines } : null; },
}));
mock.module('./mission-acceptance-tests', () => ({ ensureAcceptanceTests: async () => ({ kind: 'filed' }) }));

const { resolveCreateSelections } = await import('./mission-selection');

const bodyWith = (ids: string[]) => ids.map((id) => `- ${id}: The page does ${id}.`).join('\n');

describe('resolveCreateSelections', () => {
  beforeEach(() => { reviewCalls.length = 0; pinnedRevision = 4; reviewLines = []; });

  it('scopes to the criteria the selected revision adds or changes, with the reason recorded', async () => {
    body = bodyWith(['R-1', 'R-2', 'R-17', 'AC-11']);
    reviewLines = [{ kind: 'added', id: 'R-17', text: 'x', section: 'V' }, { kind: 'changed', id: 'AC-11', text: 'x', oldText: 'y', words: [], section: 'AC' }, { kind: 'removed', id: 'R-9', oldText: 'z', section: 'V' }];
    const r = await resolveCreateSelections('ws-1', [{ specId: SPEC }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(reviewCalls).toEqual([{ from: 3, to: 4 }]);
    expect(r.selections[0].criterion).toMatchObject({ type: 'living_spec', specId: SPEC, revision: 4, criteria: ['R-17', 'AC-11'], narrowedReason: 'The criteria revision 4 adds or changes' });
    expect(r.selections[0].inScope).toEqual(['R-17', 'AC-11']);
  });

  it('keeps the whole spec in scope for a first revision, or when the revision changes every criterion', async () => {
    body = bodyWith(['R-1', 'R-2']);
    pinnedRevision = 1;
    let r = await resolveCreateSelections('ws-1', [{ specId: SPEC }]);
    expect(r.ok && r.selections[0].criterion.criteria).toBeUndefined();
    expect(reviewCalls).toEqual([]);
    pinnedRevision = 2;
    reviewLines = [{ kind: 'changed', id: 'R-1', text: 'x', oldText: 'y', words: [], section: 'M' }, { kind: 'changed', id: 'R-2', text: 'x', oldText: 'y', words: [], section: 'M' }];
    r = await resolveCreateSelections('ws-1', [{ specId: SPEC }]);
    expect(r.ok && r.selections[0].criterion.criteria).toBeUndefined();
    expect(r.ok && r.selections[0].inScope).toEqual(['R-1', 'R-2']);
  });

  it('takes named criteria over the default', async () => {
    body = bodyWith(['R-1', 'R-2', 'R-3']);
    const r = await resolveCreateSelections('ws-1', [{ specId: SPEC, criteria: ['R-2'], narrowedReason: 'Only the list ordering rule' }]);
    expect(r.ok && r.selections[0].criterion.criteria).toEqual(['R-2']);
    expect(reviewCalls).toEqual([]);
  });

  it('refuses a revision that adds or changes no criterion, or whose change list cannot be read', async () => {
    body = bodyWith(['R-1', 'R-2']);
    reviewLines = [{ kind: 'removed', id: 'R-9', oldText: 'z', section: 'V' }];
    let r = await resolveCreateSelections('ws-1', [{ specId: SPEC }]);
    expect(r).toMatchObject({ ok: false, status: 400 });
    reviewLines = null;
    r = await resolveCreateSelections('ws-1', [{ specId: SPEC }]);
    expect(r).toMatchObject({ ok: false, status: 409 });
  });
});
