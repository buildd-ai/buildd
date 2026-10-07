/**
 * The candidate rules (./memory-candidates) and how the one read door applies
 * them: a push serves active memories only, whatever the caller asks for.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('../memory-scope', () => ({
  resolveMemoryProjectKey: async (wsId: string | null | undefined) => (wsId ? 'p' : null),
  resolveMemoryHitScope: async () => null,
}));

import {
  decidePromotion,
  failedTaskCandidate,
  isMemoryCandidateWritesEnabled,
  memoryStateOf,
  pullMemoryStates,
  reviewCandidate,
  type PromotionEvidence,
} from '../memory-candidates';
const { retrieveMemory, servedMemoryStates } = await import('../memory-retrieval');

const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000001';
const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';

describe('flag', () => {
  it('is on only for a literal true', () => {
    expect(isMemoryCandidateWritesEnabled({ memoryCandidateWrites: true })).toBe(true);
    for (const v of [undefined, null, {}, { memoryCandidateWrites: 'true' }, { memoryCandidateWrites: 1 }, { memoryCandidateWrites: false }]) {
      expect(isMemoryCandidateWritesEnabled(v)).toBe(false);
    }
  });
});

describe('states', () => {
  it('a row with no or unknown state is active', () => {
    expect(memoryStateOf({})).toBe('active');
    expect(memoryStateOf({ state: null })).toBe('active');
    expect(memoryStateOf({ state: 'weird' })).toBe('active');
    expect(memoryStateOf({ state: 'candidate' })).toBe('candidate');
  });

  it('a pull serves candidates only when asked; a push never does', () => {
    expect(pullMemoryStates(false)).toEqual(['active']);
    expect(pullMemoryStates(true)).toEqual(['active', 'candidate']);
    expect(servedMemoryStates('recall', true)).toEqual(['active', 'candidate']);
    for (const push of ['claim_context', 'claim_recipe', 'mission_planning', 'authoring_prior_work', 'claim_task_reply', 'runner_workspace_memory'] as const) {
      expect(servedMemoryStates(push, true)).toEqual(['active']);
    }
  });
});

describe('decidePromotion', () => {
  const e = (over: Partial<PromotionEvidence> = {}): PromotionEvidence => ({
    external: false, sourcePrMergedPastWindow: false, sourcePrReverted: false, corroborated: false, ...over,
  });

  it('promotes on a merged, unreverted source PR', () => {
    expect(decidePromotion(e({ sourcePrMergedPastWindow: true }))).toEqual({ promote: true, reason: 'verified_outcome' });
  });

  it('promotes on one corroborating episode', () => {
    expect(decidePromotion(e({ corroborated: true }))).toEqual({ promote: true, reason: 'corroborated' });
  });

  it('holds with no verified outcome and no corroboration', () => {
    expect(decidePromotion(e())).toEqual({ promote: false, reason: 'no_evidence' });
  });

  it('holds a reverted source PR', () => {
    expect(decidePromotion(e({ sourcePrMergedPastWindow: true, sourcePrReverted: true }))).toEqual({ promote: false, reason: 'reverted' });
  });

  it('never promotes external content, whatever else is true', () => {
    expect(decidePromotion(e({ external: true, sourcePrMergedPastWindow: true, corroborated: true }))).toEqual({ promote: false, reason: 'external' });
  });

  it('holds a candidate learn tagged not durable, even with a verified outcome or corroboration', () => {
    expect(decidePromotion(e({ sourcePrMergedPastWindow: true, notDurable: true }))).toEqual({ promote: false, reason: 'not_durable' });
    expect(decidePromotion(e({ corroborated: true, notDurable: true }))).toEqual({ promote: false, reason: 'not_durable' });
  });

  it('a pull clears the not-durable hold: the rule promotes as usual', () => {
    expect(decidePromotion(e({ sourcePrMergedPastWindow: true, notDurable: true, pulled: true }))).toEqual({ promote: true, reason: 'verified_outcome' });
  });

  it('the not-durable hold never masks a stronger reason to hold', () => {
    expect(decidePromotion(e({ notDurable: true }))).toEqual({ promote: false, reason: 'no_evidence' });
    expect(decidePromotion(e({ external: true, corroborated: true, notDurable: true }))).toEqual({ promote: false, reason: 'external' });
  });

  it('rollback: with the keep reader off, the tag is ignored', () => {
    expect(decidePromotion(e({ sourcePrMergedPastWindow: true, notDurable: true }), { keepDemotes: false }))
      .toEqual({ promote: true, reason: 'verified_outcome' });
  });
});

describe('extraction candidates', () => {
  it('a failed task becomes an external gotcha with the error and the last summary', () => {
    const c = failedTaskCandidate({ taskId: 't1', title: 'Fix the thing', error: 'boom', summary: 'tried X', files: ['a.ts'] })!;
    expect(c).toMatchObject({ type: 'gotcha', title: 'Failed: Fix the thing', files: ['a.ts'], provenance: { kind: 'failed_task', id: 't1', external: true } });
    expect(c.content).toContain('Error: boom');
    expect(c.content).toContain('Last summary: tried X');
  });

  it('a failed task with nothing to learn from is skipped', () => {
    expect(failedTaskCandidate({ taskId: 't1', title: 'x', error: null, summary: '  ' })).toBeNull();
  });

  it('bounds long text', () => {
    const c = failedTaskCandidate({ taskId: 't1', title: 'x', error: 'e'.repeat(5000), summary: 's'.repeat(5000) })!;
    expect(c.content.length).toBeLessThan(1600);
  });

  it('a review is always external', () => {
    const c = reviewCandidate({ reviewId: 'r1', prNumber: 7, body: 'please do not do X', files: ['b.ts'] })!;
    expect(c.provenance).toEqual({ kind: 'review', id: 'r1', external: true });
    expect(c.content).toContain('please do not do X');
    expect(reviewCandidate({ reviewId: 'r2', prNumber: 7, body: ' ' })).toBeNull();
  });
});

describe('retrieveMemory applies the state rule', () => {
  const rows = [
    { id: 'a1', project: 'p', state: 'active' },
    { id: 'c1', project: 'p', state: 'candidate' },
    { id: 'e1', project: 'p', state: 'expired' },
    { id: 'l1', project: 'p' },
  ];
  const scope = { project: 'p', lookup: async (ids: string[]) => ({ memories: rows.filter(r => ids.includes(r.id)) }) };
  const store = { query: async () => rows.map((r, i) => ({ id: r.id, content: r.id, score: 1 - i / 10, isCurrent: true })) };
  const run = (caller: 'recall' | 'claim_context', includeCandidates?: boolean) => retrieveMemory({
    query: 'q', scope: { teamId: TEAM_ID, workspaceId: WS_ID, memoryScope: scope }, caller, budget: { topK: 10 },
    store: store as any, ledger: false, ...(includeCandidates ? { includeCandidates } : {}),
  });

  it('a push serves active rows even when candidates are asked for', async () => {
    expect((await run('claim_context', true)).results.map(r => r.id)).toEqual(['a1', 'l1']);
  });

  it('a pull serves candidates only when asked', async () => {
    expect((await run('recall')).results.map(r => r.id)).toEqual(['a1', 'l1']);
    expect((await run('recall', true)).results.map(r => r.id)).toEqual(['a1', 'c1', 'l1']);
  });

  for (const caller of ['claim_task_reply', 'runner_workspace_memory'] as const) {
    it(`the store search for ${caller} asks for active rows only`, async () => {
      const calls: any[] = [];
      const searcher = { search: async (p: any) => { calls.push(p); return { results: [], total: 0 }; }, batch: async () => ({ memories: [] }) };
      await retrieveMemory({ strategy: 'store-search', searcher, search: { query: 'q', states: ['candidate'] }, scope: { teamId: TEAM_ID, workspaceId: WS_ID }, caller, ledger: false });
      expect(calls).toEqual([{ query: 'q', project: 'p', states: ['active'] }]);
    });
  }
});
