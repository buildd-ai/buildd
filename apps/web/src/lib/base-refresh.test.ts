import { describe, it, expect, beforeEach, mock } from 'bun:test';

const gateEvents: any[] = [];
mock.module('@/lib/gate-ledger', () => ({
  GATE_SLUGS: { BASE_REFRESH: 'base_refresh' },
  fireGateEvent: (e: any) => { gateEvents.push(e); return 'id'; },
  fireDeferralEvent: (e: any) => { gateEvents.push(e); },
}));
// The default (DB-bound) state store and diagnostic are injected below; the
// module must still import without a live database.
mock.module('@buildd/core/db', () => ({ db: {} }));

import {
  refreshBehindPr,
  MAX_REFRESH_FAILURES,
  MAX_SEMANTIC_RECHECKS,
  REFRESH_LEASE_MS,
  type BaseRefreshState,
  type BaseRefreshDeps,
} from './base-refresh';
import type { SemanticAssessment } from './semantic-refresh';

const HEAD = 'h'.repeat(40);
const TIP = 't'.repeat(40);
const PARAMS = {
  installationId: 1,
  repoFullName: 'acme/app',
  prNumber: 7,
  headSha: HEAD,
  workspaceId: 'ws-1',
  taskId: 'task-1',
  workerId: 'w-1',
  missionId: 'm-1',
  gitConfig: null as any,
};

function harness(opts: {
  update?: Array<{ updated: boolean; reason?: string; failure?: any }>;
  assessment?: SemanticAssessment;
  initial?: BaseRefreshState | null;
  loseCas?: boolean;
  now?: number;
} = {}) {
  let state: BaseRefreshState | null = opts.initial ?? null;
  const updates = [...(opts.update ?? [{ updated: true }])];
  const calls = { update: 0, assess: 0, diagnose: [] as any[], writes: 0 };
  const deps: BaseRefreshDeps = {
    now: () => opts.now ?? 1_000_000,
    update: async () => { calls.update++; return updates.shift() ?? { updated: true }; },
    assess: async () => { calls.assess++; return opts.assessment ?? { verdict: 'disjoint_paths', reason: 'x', baseSha: TIP }; },
    readState: async () => state,
    writeState: async (_taskId, priorRev, next) => {
      calls.writes++;
      if (opts.loseCas) return false;
      if ((state?.rev ?? 0) !== priorRev) return false;
      state = next;
      return true;
    },
    diagnose: async (input) => { calls.diagnose.push(input); },
  };
  return { deps, calls, get state() { return state; } };
}

beforeEach(() => { gateEvents.length = 0; });

describe('refreshBehindPr — clean path', () => {
  it('merges the base in via GitHub with no agent, no symbol lookup when off', async () => {
    const h = harness();
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('updated');
    expect(h.calls.update).toBe(1);
    expect(h.calls.assess).toBe(0);
    expect(h.state?.inFlightUntil).toBeNull();
    expect(gateEvents.find((e) => e.outcome === 'accepted')).toBeTruthy();
  });

  it('makes no model or other network call on the clean path', async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; throw new Error('no network'); }) as any;
    try {
      const h = harness({ assessment: { verdict: 'disjoint_paths', reason: 'x', baseSha: TIP } });
      const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
      expect(r.kind).toBe('updated');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
  });

  it('a disjoint enforcing check refreshes', async () => {
    const h = harness({ assessment: { verdict: 'disjoint_paths', reason: 'x', baseSha: TIP } });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(r.kind).toBe('updated');
    expect(h.calls.assess).toBe(1);
  });
});

describe('refreshBehindPr — failure classification', () => {
  it('a verified textual conflict goes to the conflict agent', async () => {
    const h = harness({ update: [{ updated: false, failure: 'conflict', reason: '422 merge conflict' }] });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('conflict');
  });

  it('a moved head is a re-read: no agent, no attempt counted', async () => {
    const h = harness({ update: [{ updated: false, failure: 'head_changed', reason: '422 expected head sha' }] });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('head_changed');
    expect(h.state?.failures ?? 0).toBe(0);
  });

  it.each([['transient'], ['rate_limit'], ['auth'], ['unknown']])('%s defers with a bounded attempt count, never a conflict', async (failure) => {
    const h = harness({ update: [{ updated: false, failure, reason: 'boom' }] });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r).toMatchObject({ kind: 'deferred', failure, attempts: 1 });
    expect(h.state?.failures).toBe(1);
    expect(h.state?.inFlightUntil).toBeNull();
    expect(h.calls.diagnose).toHaveLength(0);
  });

  it('repeated operational failures on one head exhaust and post one diagnostic', async () => {
    const h = harness({ update: Array.from({ length: MAX_REFRESH_FAILURES + 2 }, () => ({ updated: false, failure: 'transient', reason: '502' })) });
    const kinds: string[] = [];
    for (let i = 0; i < MAX_REFRESH_FAILURES + 2; i++) kinds.push((await refreshBehindPr(PARAMS, h.deps)).kind);
    expect(kinds.slice(0, MAX_REFRESH_FAILURES - 1).every((k) => k === 'deferred')).toBe(true);
    expect(kinds[MAX_REFRESH_FAILURES - 1]).toBe('exhausted');
    // Past the cap: no further mutation attempts, still no agent, one diagnostic.
    expect(kinds.slice(MAX_REFRESH_FAILURES).every((k) => k === 'exhausted')).toBe(true);
    expect(h.calls.update).toBe(MAX_REFRESH_FAILURES);
    expect(h.calls.diagnose).toHaveLength(1);
  });

  it('a new head starts a fresh attempt budget', async () => {
    const h = harness({
      initial: { prNumber: 7, headSha: 'old', baseSha: null, failures: MAX_REFRESH_FAILURES, semanticRechecks: 0, inFlightUntil: null, diagnosedAt: 'x', rev: 4 },
    });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('updated');
  });
});

describe('refreshBehindPr — single flight', () => {
  it('a live reservation on this PR means another refresh is in flight', async () => {
    const h = harness({
      initial: { prNumber: 7, headSha: HEAD, baseSha: null, failures: 0, semanticRechecks: 0, inFlightUntil: new Date(1_000_000 + 5_000).toISOString(), rev: 1 },
    });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('in_flight');
    expect(h.calls.update).toBe(0);
  });

  it('an expired reservation is reclaimed', async () => {
    const h = harness({
      initial: { prNumber: 7, headSha: HEAD, baseSha: null, failures: 0, semanticRechecks: 0, inFlightUntil: new Date(1_000_000 - REFRESH_LEASE_MS).toISOString(), rev: 1 },
    });
    expect((await refreshBehindPr(PARAMS, h.deps)).kind).toBe('updated');
  });

  it('losing the reservation CAS means in flight, with no mutation', async () => {
    const h = harness({ loseCas: true });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('in_flight');
    expect(h.calls.update).toBe(0);
  });
});

describe('refreshBehindPr — semantic check', () => {
  const sameSymbol: SemanticAssessment = {
    verdict: 'same_symbol', reason: 'both edit f', baseSha: TIP, sharedPaths: ['a.ts'], evidence: [{ path: 'a.ts', symbols: ['a.ts::f'] }],
  };
  const unknown: SemanticAssessment = { verdict: 'unknown', reason: 'symbol index unavailable', baseSha: TIP, sharedPaths: ['a.ts'] };

  it('enforce: a verified same-symbol edit is sent to semantic review, not refreshed or merged', async () => {
    const h = harness({ assessment: sameSymbol });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(r.kind).toBe('semantic_conflict');
    expect((r as any).assessment.evidence).toEqual(sameSymbol.evidence);
    expect(h.calls.update).toBe(0);
  });

  it('shadow: records the verdict and refreshes as before', async () => {
    const h = harness({ assessment: sameSymbol });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'shadow' } }, h.deps);
    expect(r.kind).toBe('updated');
    expect(gateEvents.find((e) => e.outcome === 'warned' && e.detail.verdict === 'same_symbol')).toBeTruthy();
  });

  it('enforce: unknown coverage defers for bounded rechecks, then a diagnostic — never a conflict agent or a clearance', async () => {
    const h = harness({ assessment: unknown });
    const kinds: string[] = [];
    for (let i = 0; i < MAX_SEMANTIC_RECHECKS + 1; i++) {
      kinds.push((await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps)).kind);
    }
    expect(kinds.slice(0, MAX_SEMANTIC_RECHECKS - 1).every((k) => k === 'semantic_deferred')).toBe(true);
    expect(kinds[MAX_SEMANTIC_RECHECKS - 1]).toBe('semantic_unverified');
    expect(kinds[MAX_SEMANTIC_RECHECKS]).toBe('semantic_unverified');
    expect(h.calls.update).toBe(0);
    expect(h.calls.diagnose).toHaveLength(1);
  });

  it('a moved head seen by the semantic read is a re-read', async () => {
    const h = harness({ assessment: { verdict: 'head_changed', reason: 'moved' } });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(r.kind).toBe('head_changed');
    expect(h.calls.update).toBe(0);
  });

  it('a moved base restarts the recheck budget (new evidence)', async () => {
    const h = harness({
      assessment: unknown,
      initial: { prNumber: 7, headSha: HEAD, baseSha: 'old-base', failures: 0, semanticRechecks: MAX_SEMANTIC_RECHECKS, inFlightUntil: null, rev: 2 },
    });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(r.kind).toBe('semantic_deferred');
  });
});
