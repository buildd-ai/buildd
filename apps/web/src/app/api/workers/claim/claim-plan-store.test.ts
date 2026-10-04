import { describe, expect, it, mock, beforeEach } from 'bun:test';

const onceCalls: any[] = [];
const repeatCalls: any[] = [];
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
  recordDeferralOnce: (input: any, key: any) => { onceCalls.push({ input, key }); return Promise.resolve('row'); },
  recordOrCoalesceRepeat: (input: any, opts: any) => { repeatCalls.push({ input, opts }); return Promise.resolve('row'); },
}));

let dbShouldThrow = false;
const failing = () => { throw new Error('relation does not exist'); };
const chain: any = new Proxy({}, {
  get: (_t, k) => (k === 'then' ? (r: any, j: any) => (dbShouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve([])).then(r, j) : () => chain),
});
mock.module('@buildd/core/db', () => ({
  db: {
    selectDistinctOn: () => (dbShouldThrow ? failing() : chain),
    select: () => (dbShouldThrow ? failing() : chain),
    execute: () => (dbShouldThrow ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [{ taskId: 't1', dependentCount: 2 }] })),
  },
}));

const { effectiveBackendOf, fireClaimPlanRecord, fireOrderedBehind, loadPlannerSignals } = await import('./claim-plan-store');

const plan = (picks: string[], orientation: any[] = []) => ({
  picks: picks.map((id, order) => ({ id, order, admittedBy: 'greedy' as const, softWeight: 0 })),
  orientation,
  explanations: [],
  hardEdges: [],
  underPressure: false,
});

beforeEach(() => {
  onceCalls.length = 0;
  repeatCalls.length = 0;
  dbShouldThrow = false;
});

describe('fireOrderedBehind', () => {
  it('keys the once-only row on the blocker, under claim_loop_deferral / ordered_behind', () => {
    fireOrderedBehind({ taskId: 't1', workspaceId: 'ws', missionId: null, blockedBy: 't0', edge: 'path_overlap', orientation: 'in_flight' });
    expect(onceCalls).toHaveLength(1);
    expect(onceCalls[0].key).toEqual({ blockedBy: 't0' });
    expect(onceCalls[0].input).toMatchObject({ gate: 'claim_loop_deferral', outcome: 'deferred', reason: 'ordered_behind', taskId: 't1' });
  });
});

describe('fireClaimPlanRecord', () => {
  it('the same plan and picks coalesce on one key; a different outcome does not', () => {
    const base = { mode: 'record' as const, workspaceId: 'ws', candidateCount: 3, capacity: 2, backend: 'claude' as const };
    fireClaimPlanRecord({ ...base, plan: plan(['a', 'c']), actualPicks: ['a', 'b', 'c'] });
    fireClaimPlanRecord({ ...base, plan: plan(['a', 'c']), actualPicks: ['a', 'b', 'c'] });
    fireClaimPlanRecord({ ...base, plan: plan(['a', 'c']), actualPicks: ['a', 'c'] });
    expect(repeatCalls[0].opts.key).toEqual(repeatCalls[1].opts.key);
    expect(repeatCalls[2].opts.key).not.toEqual(repeatCalls[0].opts.key);
    expect(repeatCalls[0].input.detail).toMatchObject({ planned: ['a', 'c'], actual: ['a', 'b', 'c'], agree: false, capacity: 2, backend: 'claude' });
    expect(repeatCalls[2].input.detail.agree).toBe(true);
  });
});

describe('effectiveBackendOf', () => {
  it('is the shared backend when every task agrees', () => {
    expect(effectiveBackendOf([{ backend: 'claude' }, { backend: 'claude' }])).toBe('claude');
    expect(effectiveBackendOf([{ backend: 'codex' }])).toBe('codex');
  });
  it('defaults an unset backend to claude', () => {
    expect(effectiveBackendOf([{}, { backend: undefined }])).toBe('claude');
  });
  it('is "mixed" when the candidates span more than one backend', () => {
    expect(effectiveBackendOf([{ backend: 'claude' }, { backend: 'codex' }])).toBe('mixed');
  });
  it('is "claude" for an empty list (vacuously one backend)', () => {
    expect(effectiveBackendOf([])).toBe('claude');
  });
});

describe('loadPlannerSignals', () => {
  it('fails open to empty signals when the reads fail', async () => {
    dbShouldThrow = true;
    const s = await loadPlannerSignals(['t1'], ['ws']);
    expect(s.predictions.size).toBe(0);
    expect(s.overlapAnswers).toEqual([]);
    expect(s.starvationCredit.size).toBe(0);
    expect(s.dependentCount.size).toBe(0);
  });

  it('reads nothing for no candidates', async () => {
    dbShouldThrow = true;
    const s = await loadPlannerSignals([], []);
    expect(s.predictions.size).toBe(0);
  });

  it('carries direct dependent counts', async () => {
    const s = await loadPlannerSignals(['t1'], ['ws']);
    expect(s.dependentCount.get('t1')).toBe(2);
  });
});
