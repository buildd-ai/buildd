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
  refreshLeaseMs,
  checkBaseRefreshHold,
  postRefreshDiagnostic,
  type BaseRefreshState,
  type BaseRefreshDeps,
} from './base-refresh';
import { SEMANTIC_CHECK_WORST_CASE_MS, type SemanticAssessment } from './semantic-refresh';

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
  let assessment = opts.assessment;
  const updates = [...(opts.update ?? [{ updated: true }])];
  const calls = { update: 0, assess: 0, diagnose: [] as any[], writes: 0 };
  const deps: BaseRefreshDeps = {
    now: () => opts.now ?? 1_000_000,
    update: async () => { calls.update++; return updates.shift() ?? { updated: true }; },
    assess: async () => { calls.assess++; return assessment ?? { verdict: 'disjoint_paths', reason: 'x', baseSha: TIP }; },
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
  return {
    deps,
    calls,
    get state() { return state; },
    setState(next: BaseRefreshState) { state = next; },
    setAssessment(next: SemanticAssessment) { assessment = next; },
  };
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

  it('a moved base does NOT restart the recheck budget: it is bounded per head', async () => {
    // On a busy base the tip moves between every check; resetting on base
    // movement would hold the PR forever without the diagnostic ever firing.
    const h = harness({ assessment: unknown });
    const kinds: string[] = [];
    for (let i = 0; i < MAX_SEMANTIC_RECHECKS + 1; i++) {
      const moving: SemanticAssessment = { ...unknown, baseSha: `base-${i}` };
      h.setAssessment(moving);
      kinds.push((await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps)).kind);
    }
    expect(kinds[MAX_SEMANTIC_RECHECKS - 1]).toBe('semantic_unverified');
    expect(kinds[MAX_SEMANTIC_RECHECKS]).toBe('semantic_unverified');
    expect(h.calls.diagnose).toHaveLength(1);
  });

  it('past the per-head bound, no further GitHub reads are spent', async () => {
    const h = harness({ assessment: unknown });
    for (let i = 0; i < MAX_SEMANTIC_RECHECKS + 2; i++) {
      await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    }
    expect(h.calls.assess).toBe(MAX_SEMANTIC_RECHECKS);
  });

  it('a new head gets a fresh recheck budget', async () => {
    const h = harness({
      assessment: unknown,
      initial: { prNumber: 7, headSha: 'old', baseSha: TIP, failures: 0, semanticRechecks: MAX_SEMANTIC_RECHECKS, semanticDiagnosedAt: 'x', inFlightUntil: null, rev: 2 },
    });
    const r = await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(r.kind).toBe('semantic_deferred');
  });

  it('an exhausted semantic budget does not suppress a later operational diagnostic', async () => {
    const h = harness({
      initial: { prNumber: 7, headSha: HEAD, baseSha: TIP, failures: MAX_REFRESH_FAILURES - 1, semanticRechecks: 0, semanticDiagnosedAt: 'x', inFlightUntil: null, rev: 2 },
      update: [{ updated: false, failure: 'transient', reason: '502' }],
    });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('exhausted');
    expect(h.calls.diagnose.map((d) => d.kind)).toEqual(['refresh_failed']);
  });
});

describe('refreshBehindPr — explicit 422 classes', () => {
  it('"no new commits" is up_to_date: no failure counted, no diagnostic', async () => {
    const h = harness({ update: [{ updated: false, failure: 'up_to_date', reason: '422 no new commits' }] });
    const r = await refreshBehindPr(PARAMS, h.deps);
    expect(r.kind).toBe('up_to_date');
    expect(h.state?.failures ?? 0).toBe(0);
    expect(h.state?.inFlightUntil).toBeNull();
    expect(h.calls.diagnose).toHaveLength(0);
  });

  it('any other 422 is refused: exhausted at once with one diagnostic, not three retries', async () => {
    const h = harness({ update: [{ updated: false, failure: 'refused', reason: '422 Validation Failed' }] });
    const first = await refreshBehindPr(PARAMS, h.deps);
    expect(first).toMatchObject({ kind: 'exhausted', failure: 'refused' });
    const second = await refreshBehindPr(PARAMS, h.deps);
    expect(second.kind).toBe('exhausted');
    expect(h.calls.update).toBe(1);
    expect(h.calls.diagnose).toHaveLength(1);
    expect(h.calls.diagnose[0].kind).toBe('refresh_failed');
  });
});

describe('refreshBehindPr — lease', () => {
  it('the lease outlives a worst-case semantic check when the check is on', async () => {
    const h = harness({ assessment: { verdict: 'unknown', reason: 'x', baseSha: TIP } });
    let leasedUntil: string | null = null;
    const write = h.deps.writeState!;
    h.deps.writeState = async (id, rev, next) => {
      if (next.inFlightUntil && !leasedUntil) leasedUntil = next.inFlightUntil;
      return write(id, rev, next);
    };
    await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(Date.parse(leasedUntil!) - 1_000_000).toBe(refreshLeaseMs('enforce'));
    expect(refreshLeaseMs('enforce')).toBeGreaterThan(SEMANTIC_CHECK_WORST_CASE_MS);
    expect(refreshLeaseMs('shadow')).toBeGreaterThan(SEMANTIC_CHECK_WORST_CASE_MS);
  });

  it('with the check off the lease stays short', () => {
    expect(refreshLeaseMs('off')).toBe(REFRESH_LEASE_MS);
  });
});

describe('refreshBehindPr — base race: records what the verdict was computed against', () => {
  it('enforce: a cleared refresh records the pre-update head and the verified base', async () => {
    const h = harness({ assessment: { verdict: 'disjoint_paths', reason: 'x', baseSha: TIP } });
    await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(h.state?.pendingBaseVerify).toMatchObject({ preUpdateHeadSha: HEAD, verifiedBaseSha: TIP, mode: 'enforce', rechecks: 0 });
  });

  it('off: nothing is recorded (default no-op)', async () => {
    const h = harness();
    await refreshBehindPr(PARAMS, h.deps);
    expect(h.state?.pendingBaseVerify ?? null).toBeNull();
  });

  it('the pending verification survives the head change the update itself causes', async () => {
    const h = harness({ assessment: { verdict: 'unknown', reason: 'x', baseSha: TIP } });
    h.setState({
      prNumber: 7, headSha: 'merge-commit', baseSha: TIP, failures: 0, semanticRechecks: 0, inFlightUntil: null, rev: 3,
      pendingBaseVerify: { preUpdateHeadSha: 'old-head', verifiedBaseSha: TIP, mode: 'enforce', rechecks: 0, diagnosedAt: null, at: 'x' },
    });
    await refreshBehindPr({ ...PARAMS, gitConfig: { semanticRefresh: 'enforce' } }, h.deps);
    expect(h.state?.headSha).toBe(HEAD);
    expect(h.state?.pendingBaseVerify?.preUpdateHeadSha).toBe('old-head');
  });
});

// ── checkBaseRefreshHold ─────────────────────────────────────────────────────

const PRE = 'p'.repeat(40);
const MERGE = 'g'.repeat(40);
const MOVED = 'n'.repeat(40);
const ENFORCE = { semanticRefresh: 'enforce' } as any;

function holdHarness(opts: {
  pending?: Partial<NonNullable<BaseRefreshState['pendingBaseVerify']>> | null;
  parents?: string[];
  assessment?: SemanticAssessment;
  baseTip?: string;
  readFails?: boolean;
} = {}) {
  let state: BaseRefreshState | null = opts.pending === null ? null : {
    prNumber: 7, headSha: MERGE, baseSha: TIP, failures: 0, semanticRechecks: 0, inFlightUntil: null, rev: 5,
    pendingBaseVerify: { preUpdateHeadSha: PRE, verifiedBaseSha: TIP, mode: 'enforce', rechecks: 0, diagnosedAt: null, at: 'x', ...(opts.pending ?? {}) },
  };
  const calls = { reads: 0, assess: [] as any[], diagnose: [] as any[], api: [] as string[] };
  const deps: BaseRefreshDeps = {
    now: () => 1_000_000,
    readState: async () => { calls.reads++; return state; },
    writeState: async (_id, priorRev, next) => {
      if ((state?.rev ?? 0) !== priorRev) return false;
      state = next;
      return true;
    },
    assess: async (p) => { calls.assess.push(p); return opts.assessment ?? { verdict: 'disjoint_paths', reason: 'x', baseSha: p.pinnedBaseSha }; },
    api: async (_id, path) => {
      calls.api.push(path);
      if (opts.readFails) throw new Error('GitHub API error: 502');
      if (path === `/repos/acme/app/commits/${MERGE}`) return { sha: MERGE, parents: (opts.parents ?? [PRE, TIP]).map((sha) => ({ sha })) };
      if (path === '/repos/acme/app/pulls/7') return { base: { ref: 'dev' } };
      if (path.startsWith('/repos/acme/app/commits/')) return { sha: opts.baseTip ?? MOVED };
      throw new Error(`unexpected ${path}`);
    },
    diagnose: async (input) => { calls.diagnose.push(input); },
  };
  const HOLD = { installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: MERGE, taskId: 'task-1', workspaceId: 'ws-1', missionId: null, gitConfig: ENFORCE };
  return { deps, calls, HOLD, get state() { return state; } };
}

describe('checkBaseRefreshHold — re-verifies a base that moved between the verdict and the update', () => {
  it('off (or no gitConfig passed): no read at all', async () => {
    const h = holdHarness();
    expect((await checkBaseRefreshHold({ ...h.HOLD, gitConfig: null }, h.deps)).blocks).toBe(false);
    expect((await checkBaseRefreshHold({ ...h.HOLD, gitConfig: undefined }, h.deps)).blocks).toBe(false);
    expect(h.calls.reads).toBe(0);
  });

  it('no pending verification: passes', async () => {
    const h = holdHarness({ pending: null });
    expect((await checkBaseRefreshHold(h.HOLD, h.deps)).blocks).toBe(false);
    expect(h.calls.api).toHaveLength(0);
  });

  it('the merged-in base parent is the verified base: clears, no re-check', async () => {
    const h = holdHarness({ parents: [PRE, TIP] });
    expect((await checkBaseRefreshHold(h.HOLD, h.deps)).blocks).toBe(false);
    expect(h.calls.assess).toHaveLength(0);
    expect(h.state?.pendingBaseVerify ?? null).toBeNull();
  });

  it('the base moved and the arrived range is disjoint: re-checked at the pinned ends, then cleared', async () => {
    const h = holdHarness({ parents: [PRE, MOVED] });
    expect((await checkBaseRefreshHold(h.HOLD, h.deps)).blocks).toBe(false);
    expect(h.calls.assess).toEqual([expect.objectContaining({ headSha: PRE, pinnedBaseSha: MOVED })]);
    expect(h.state?.pendingBaseVerify ?? null).toBeNull();
  });

  it('the base moved and coverage is unknown: holds, bounded, one diagnostic, then no more reads', async () => {
    const h = holdHarness({ parents: [PRE, MOVED], assessment: { verdict: 'unknown', reason: 'no index', baseSha: MOVED } });
    const results = [];
    for (let i = 0; i < MAX_SEMANTIC_RECHECKS + 2; i++) results.push(await checkBaseRefreshHold(h.HOLD, h.deps));
    expect(results.every((r) => r.blocks)).toBe(true);
    expect(h.calls.assess).toHaveLength(MAX_SEMANTIC_RECHECKS);
    expect(h.calls.diagnose).toHaveLength(1);
    expect(h.calls.diagnose[0].kind).toBe('semantic_unverified');
    expect((results[0] as any).reason).toMatch(/^semantic hold \(rechecking\)/);
    expect((results.at(-1) as any).reason).toMatch(/^semantic hold \(needs a person\)/);
  });

  it('the base moved and the same symbol is edited on both sides: holds with one diagnostic', async () => {
    const h = holdHarness({ parents: [PRE, MOVED], assessment: { verdict: 'same_symbol', reason: 'both edit f', baseSha: MOVED, evidence: [{ path: 'a.ts', symbols: ['f'] }] } });
    const a = await checkBaseRefreshHold(h.HOLD, h.deps);
    const b = await checkBaseRefreshHold(h.HOLD, h.deps);
    expect(a.blocks && b.blocks).toBe(true);
    expect((a as any).reason).toMatch(/needs a person/);
    expect(h.calls.diagnose.map((d) => d.kind)).toEqual(['semantic_conflict']);
  });

  it('a head not recognisable as the update merge falls back to the live base tip (a superset)', async () => {
    const h = holdHarness({ parents: ['someone-else', 'x'], baseTip: MOVED });
    await checkBaseRefreshHold(h.HOLD, h.deps);
    expect(h.calls.assess).toEqual([expect.objectContaining({ headSha: PRE, pinnedBaseSha: MOVED })]);
  });

  it('the head is still the pre-update head: nothing unchecked was merged in, passes', async () => {
    const h = holdHarness();
    expect((await checkBaseRefreshHold({ ...h.HOLD, headSha: PRE }, h.deps)).blocks).toBe(false);
    expect(h.calls.api).toHaveLength(0);
  });

  it('a GitHub read failure holds (fails closed) and counts as a recheck', async () => {
    const h = holdHarness({ readFails: true });
    const r = await checkBaseRefreshHold(h.HOLD, h.deps);
    expect(r.blocks).toBe(true);
    expect(h.state?.pendingBaseVerify?.rechecks).toBe(1);
  });

  it('shadow: never holds, records the moved base on the ledger, clears', async () => {
    const h = holdHarness({ parents: [PRE, MOVED], pending: { mode: 'shadow' } });
    const r = await checkBaseRefreshHold({ ...h.HOLD, gitConfig: { semanticRefresh: 'shadow' } as any }, h.deps);
    expect(r.blocks).toBe(false);
    expect(h.calls.assess).toHaveLength(0);
    expect(gateEvents.find((e) => e.outcome === 'warned' && /base moved/.test(e.reason))).toBeTruthy();
    expect(h.state?.pendingBaseVerify ?? null).toBeNull();
  });

  it('a caller that does not know the mission still routes the diagnostic to it', async () => {
    const h = holdHarness({ parents: [PRE, MOVED], assessment: { verdict: 'same_symbol', reason: 'f', baseSha: MOVED } });
    h.deps.missionOf = async () => 'm-9';
    const { missionId: _omit, ...noMission } = h.HOLD;
    await checkBaseRefreshHold(noMission, h.deps);
    expect(h.calls.diagnose[0].missionId).toBe('m-9');
  });

  it('enforce turned off since: the hold is not applied', async () => {
    const h = holdHarness({ parents: [PRE, MOVED], assessment: { verdict: 'unknown', reason: 'x' } });
    expect((await checkBaseRefreshHold({ ...h.HOLD, gitConfig: { semanticRefresh: 'off' } as any }, h.deps)).blocks).toBe(false);
  });
});

// ── Diagnostics ──────────────────────────────────────────────────────────────

describe('postRefreshDiagnostic — every outcome reaches a person', () => {
  const INPUT = { kind: 'semantic_unverified' as const, taskId: 'task-1', installationId: 1, repoFullName: 'acme/app', prNumber: 7, headSha: HEAD, reason: 'no index' };

  it('a mission PR gets a mission note', async () => {
    const notes: any[] = []; const activity: any[] = [];
    await postRefreshDiagnostic({ ...INPUT, missionId: 'm-1' }, { insertMissionNote: async (n) => { notes.push(n); }, appendActivity: async (a) => { activity.push(a); return {} as any; } });
    expect(notes).toHaveLength(1);
    expect(notes[0].missionId).toBe('m-1');
  });

  it('a PR with no mission gets a PR activity entry instead of silence', async () => {
    const notes: any[] = []; const activity: any[] = [];
    await postRefreshDiagnostic({ ...INPUT, missionId: null }, { insertMissionNote: async (n) => { notes.push(n); }, appendActivity: async (a) => { activity.push(a); return {} as any; } });
    expect(notes).toHaveLength(0);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ installationId: 1, repoFullName: 'acme/app', prNumber: 7, entry: { kind: 'human_review_required' } });
    expect(activity[0].entry.note).toContain('no index');
  });
});
