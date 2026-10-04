import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const ZERO = { total: 0, stamped: 0, closed: 0, skipped: 0, errors: 0 };
const MISSION_ZERO = {
  total: 0, opened: 0, alreadyOpen: 0, prClosed: 0, nothingToShip: 0, notReady: 0, errors: 0,
};
const mockReconcile = mock(() => Promise.resolve(ZERO));
const mockMissionPrSweep = mock(() => Promise.resolve(MISSION_ZERO));
const mockDeadZone = mock(() => Promise.resolve({ total: 0, sparked: 0, exhausted: 0, skipped: 0 }));

mock.module('@/lib/pr-reconcile', () => ({
  reconcileStalePrWorkers: mockReconcile,
  sweepMissionIntegrationPrs: mockMissionPrSweep,
}));

mock.module('@/lib/dead-zone-sweep', () => ({
  sweepDeadZonePrs: mockDeadZone,
}));

const BRANCH_REFRESH_ZERO = { scanned: 0, merged: 0, conflicts: 0, skipped: 0, errors: 0 };
const mockBranchRefreshSweep = mock(() => Promise.resolve(BRANCH_REFRESH_ZERO));
mock.module('@/lib/mission-branch-refresh', () => ({
  sweepMissionBranchRefresh: mockBranchRefreshSweep,
}));

const LINEAGE_ZERO = { candidates: 0, closed: 0, stranded: 0, skipped: 0 };
const mockLineageSweep = mock(() => Promise.resolve(LINEAGE_ZERO));
mock.module('@/lib/retry-pr-supersession', () => ({
  sweepDuplicateLineagePrs: mockLineageSweep,
}));

const CLOSED_ZERO = { candidates: 0, recorded: 0, suggested: 0, none: 0, skipped: 0 };
const mockClosedPrSweep = mock(() => Promise.resolve(CLOSED_ZERO as any));
mock.module('@/lib/pr-supersession-detect', () => ({
  sweepClosedUnsupersededPrs: mockClosedPrSweep,
}));

// The two sweeps below were unmocked too, so they queried the live database.
mock.module('@/lib/stranded-tasks-sweep', () => ({
  sweepStrandedTasks: async () => ({ scanned: 0, stranded: 0, cleared: 0 }),
}));
mock.module('@/lib/spec-recheck', () => ({
  sweepSpecDiscrepancyRechecks: async () => ({
    candidates: 0, rechecksDispatched: 0, rechecksCovered: 0, rechecksFailed: 0,
    followUpsDispatched: 0, followUpsFailed: 0,
  }),
}));

const LANDING_ZERO = {
  source: 'floor', enumerated: 0, processed: 0, merged: 0, updatingBranch: 0, waitingCi: 0,
  needsFix: 0, needsHuman: 0, skipped: {}, headMoved: 0, errors: 0, deferred: 0, truncated: false,
};
const mockLandingSweep = mock((_opts: { source: string }) => Promise.resolve<any>(LANDING_ZERO));
mock.module('@/lib/pr-landing-sweep-deps', () => ({ sweepLandingPrs: mockLandingSweep }));

const REDRIVE_ZERO = {
  enumerated: 0, redriven: 0, merged: 0, exhausted: 0, raced: 0, notRedrivable: 0, errors: 0, deferred: 0, outcomes: {},
};
const mockRefreshRedrive = mock(() => Promise.resolve<any>(REDRIVE_ZERO));
mock.module('@/lib/refresh-redrive', () => ({ redriveDeferredRefreshes: mockRefreshRedrive }));

const CI_RED_ZERO = {
  source: 'floor', enumerated: 0, processed: 0, dispatched: 0, escalated: 0, inFlight: 0, tooYoung: 0,
  skipped: {}, errors: 0, deferred: 0, truncated: false,
};
const mockCiRedSweep = mock((_opts: { source: string }) => Promise.resolve<any>(CI_RED_ZERO));
mock.module('@/lib/ci-red-sweep-deps', () => ({ sweepCiRedPrs: mockCiRedSweep }));
// The workflow kernel's outbox floor drain (lib/workflow/seam.ts).
const mockDrainDueEffects = mock(async () => ({ claimed: 0, done: 0, skipped: 0, failed: 0, dead: [] }));
const mockTrunk = mock(async () => ({ checked: 1, resolved: 1, recovered: 2, stillRed: 0, errors: 0 }));
// …and the kernel's reconciliation floor (§11): re-imports heads / PR state, re-enqueues owed effects.
const mockKernelFloor = mock(async () => ({ checked: 3, imported: 1, enqueued: 1, errors: 0 }));
mock.module('@/lib/workflow/seam', () => ({ drainDueEffects: mockDrainDueEffects, reconcileTrunkIncidents: mockTrunk, reconcileKernelDeliveries: mockKernelFloor }));

let dueCount: number | null = 0;
mock.module('@/lib/redis', () => ({
  countDue: async () => dueCount,
  reseedDue: async () => {},
  markDue: async () => {},
  clearDue: async () => {},
  listDue: async () => [],
}));

// This file used to import the real db. withCronRun's run-history insert was
// then unmocked, so every run with a live DATABASE_URL loaded (a checkout's
// apps/web/.env.local) wrote this file's fake "DB unavailable" / "GitHub
// timeout" failures into real cron run history. Any db access now lands here.
const dbTouches: string[] = [];
mock.module('@buildd/core/db', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      dbTouches.push(String(prop));
      throw new Error(`pr-reconcile route test touched db.${String(prop)}`);
    },
  }),
}));

import { GET } from './route';

function makeRequest(token?: string, query = '') {
  return new NextRequest(`http://localhost/api/cron/pr-reconcile${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('GET /api/cron/pr-reconcile', () => {
  const originalEnv = process.env.CRON_SECRET;

  beforeEach(() => {
    mockReconcile.mockReset();
    mockMissionPrSweep.mockReset();
    mockMissionPrSweep.mockResolvedValue(MISSION_ZERO);
    mockDeadZone.mockReset();
    mockBranchRefreshSweep.mockReset();
    mockBranchRefreshSweep.mockResolvedValue(BRANCH_REFRESH_ZERO);
    mockLineageSweep.mockReset();
    mockLineageSweep.mockResolvedValue(LINEAGE_ZERO);
    mockClosedPrSweep.mockReset();
    mockClosedPrSweep.mockResolvedValue(CLOSED_ZERO);
    mockReconcile.mockResolvedValue(ZERO);
    mockDeadZone.mockResolvedValue({ total: 0, sparked: 0, exhausted: 0, skipped: 0 });
    mockLandingSweep.mockReset();
    mockLandingSweep.mockResolvedValue(LANDING_ZERO);
    mockRefreshRedrive.mockReset();
    mockRefreshRedrive.mockResolvedValue(REDRIVE_ZERO);
    mockCiRedSweep.mockReset();
    mockCiRedSweep.mockResolvedValue(CI_RED_ZERO);
    dueCount = 0;
    process.env.CRON_SECRET = 'test-secret';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalEnv;
  });

  it('never touches the database, even when a sweep throws', async () => {
    mockReconcile.mockRejectedValue(new Error('DB unavailable'));
    await GET(makeRequest('test-secret'));
    mockReconcile.mockResolvedValue(ZERO);
    await GET(makeRequest('test-secret'));
    expect(dbTouches).toEqual([]);
  });

  it('returns 401 when no authorization header', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 401 when wrong token', async () => {
    const res = await GET(makeRequest('wrong'));
    expect(res.status).toBe(401);
  });

  it('returns 500 when CRON_SECRET not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(500);
  });

  it('runs both sweeps and returns nested counts on success', async () => {
    mockReconcile.mockResolvedValue({ total: 10, stamped: 4, closed: 2, skipped: 4, errors: 0 });
    mockDeadZone.mockResolvedValue({ total: 5, sparked: 2, exhausted: 1, skipped: 2 });

    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(body.reconcile.total).toBe(10);
    expect(body.reconcile.stamped).toBe(4);
    expect(body.reconcile.closed).toBe(2);
    expect(body.reconcile.skipped).toBe(4);

    expect(body.deadZone.total).toBe(5);
    expect(body.deadZone.sparked).toBe(2);
    expect(body.deadZone.exhausted).toBe(1);
    expect(body.deadZone.skipped).toBe(2);

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockDeadZone).toHaveBeenCalledTimes(1);
    // The floor pass drains the workflow kernel's outbox.
    expect(mockDrainDueEffects).toHaveBeenCalled();
    expect(body.kernelOutbox).toMatchObject({ claimed: 0 });
    // …and re-reads every open trunk incident's base head (§6.10, T26).
    expect(mockTrunk).toHaveBeenCalled();
    expect(body.trunk).toMatchObject({ resolved: 1, recovered: 2 });
    // …and runs the kernel's reconciliation floor, so a lost synchronize/closed webhook is repaired (ddcbe113).
    expect(mockKernelFloor).toHaveBeenCalled();
    expect(body.kernelFloor).toMatchObject({ checked: 3, imported: 1, enqueued: 1 });
  });

  it('returns 500 when reconcileStalePrWorkers throws', async () => {
    mockReconcile.mockRejectedValue(new Error('DB unavailable'));
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('DB unavailable');
  });

  it('returns 500 when sweepDeadZonePrs throws', async () => {
    mockDeadZone.mockRejectedValue(new Error('GitHub timeout'));
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('GitHub timeout');
  });

  it('scope=merge-state runs only the merge reconcile', async () => {
    // The hourly trigger must not spawn conflict-resolution tasks 24x a day.
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.scope).toBe('merge-state');
    expect(body.deadZone).toBeNull();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockDeadZone).not.toHaveBeenCalled();
  });

  it('an unknown scope value falls back to the full sweep', async () => {
    const res = await GET(makeRequest('test-secret', '?scope=banana'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('full');
    expect(mockDeadZone).toHaveBeenCalledTimes(1);
  });

  // ── Option A' mission PR sweep ─────────────────────────────────────────────
  //
  // The webhook used to be the ONLY trigger for the mission PR, so a missed
  // delivery — or a mission that reached completeness with no merge event at all
  // (last deliverable needs no PR, or every deliverable was cancelled) — left it
  // permanently unopened. The sweep is the trigger that does not need a merge.

  it('runs the mission PR sweep on the hourly merge-state scope', async () => {
    // Time-critical for the same reason merge state is: the completion gate
    // refuses a mission whose PR is missing, so waiting for the daily run would
    // hold a finished mission open for a day.
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    expect(mockMissionPrSweep).toHaveBeenCalledTimes(1);
  });

  it('runs the mission PR sweep on the full scope too', async () => {
    const res = await GET(makeRequest('test-secret'));
    expect(res.status).toBe(200);
    expect(mockMissionPrSweep).toHaveBeenCalledTimes(1);
  });

  it('reports the mission PR sweep counters in the response', async () => {
    mockMissionPrSweep.mockResolvedValue({
      total: 3, opened: 1, alreadyOpen: 1, prClosed: 0, nothingToShip: 1, notReady: 0, errors: 0,
    });

    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    const body = await res.json();

    expect(body.missionPrs.opened).toBe(1);
    expect(body.missionPrs.nothingToShip).toBe(1);
  });

  it('a mission PR sweep failure does not hide a successful merge reconcile', async () => {
    mockReconcile.mockResolvedValue({ total: 4, stamped: 2, closed: 0, skipped: 2, errors: 0 });
    mockMissionPrSweep.mockRejectedValue(new Error('missions query failed'));

    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));

    // The merge reconcile is the time-critical half. A sweep failure is reported,
    // never allowed to discard the healing that already happened.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reconcile.stamped).toBe(2);
    expect(body.missionPrs.error).toContain('missions query failed');
  });

  it('reports merge-state errors in the response counters', async () => {
    mockReconcile.mockResolvedValue({ total: 3, stamped: 1, closed: 0, skipped: 1, errors: 1 });
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    const body = await res.json();
    expect(body.reconcile.errors).toBe(1);
  });

  // ── Retry-lineage duplicate PRs ────────────────────────────────────────────
  //
  // create_pr closes the parent's PR when a retry opens a fresh one; when that
  // close does not happen, this hourly sweep is what finds the two open PRs.

  it('runs the duplicate-lineage sweep hourly and reports its closes as changes', async () => {
    mockLineageSweep.mockResolvedValue({ candidates: 3, closed: 1, stranded: 1, skipped: 1 });
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    expect(mockLineageSweep).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.lineagePrs).toEqual({ candidates: 3, closed: 1, stranded: 1, skipped: 1 });
  });

  it('a duplicate-lineage sweep failure does not fail the run', async () => {
    mockReconcile.mockResolvedValue({ total: 4, stamped: 2, closed: 0, skipped: 2, errors: 0 });
    mockLineageSweep.mockRejectedValue(new Error('lineage query failed'));
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reconcile.stamped).toBe(2);
    expect(body.lineagePrs.error).toContain('lineage query failed');
  });

  // ── Closed-unmerged PR supersession backfill ───────────────────────────────

  it('runs the closed-PR supersession backfill hourly and reports it', async () => {
    mockClosedPrSweep.mockResolvedValue({ candidates: 2, recorded: 1, suggested: 1, none: 0, skipped: 0 });
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    expect(mockClosedPrSweep).toHaveBeenCalledTimes(1);
    expect((await res.json()).closedPrs).toEqual({ candidates: 2, recorded: 1, suggested: 1, none: 0, skipped: 0 });
  });

  it('a closed-PR backfill failure does not fail the run', async () => {
    mockClosedPrSweep.mockRejectedValue(new Error('detect failed'));
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    expect((await res.json()).closedPrs.error).toContain('detect failed');
  });

  // The deferred-startAt sweep is gone from this route: a future startAt is a
  // durable outbox wake, fired by /api/cron/dispatch-drain.
  it('no longer sends deferred-startAt nudges', async () => {
    const body = await (await GET(makeRequest('test-secret', '?scope=merge-state'))).json();
    expect(body).not.toHaveProperty('deferredDispatch');
  });

  // Deferred branch refreshes outside landing enforce have no event coming;
  // the hourly pass re-drives them (lib/refresh-redrive.ts).

  it('the hourly pass re-drives deferred refreshes and reports it', async () => {
    mockRefreshRedrive.mockResolvedValue({ ...REDRIVE_ZERO, enumerated: 2, redriven: 2, merged: 1, exhausted: 1, errors: 1 });
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    expect(mockRefreshRedrive).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.refreshRedrive).toMatchObject({ redriven: 2, merged: 1 });
  });

  it('a refresh re-drive failure does not discard merge-state healing', async () => {
    mockReconcile.mockResolvedValue({ total: 4, stamped: 2, closed: 0, skipped: 2, errors: 0 });
    mockRefreshRedrive.mockRejectedValue(new Error('redrive query failed'));
    const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reconcile.stamped).toBe(2);
    expect(body.refreshRedrive.error).toContain('redrive query failed');
  });

  it('the gated landing tick never runs the refresh re-drive (no Postgres on an idle tick)', async () => {
    dueCount = 0;
    await GET(makeRequest('test-secret', '?scope=landing&gate=due'));
    dueCount = 3;
    await GET(makeRequest('test-secret', '?scope=landing&gate=due'));
    expect(mockRefreshRedrive).not.toHaveBeenCalled();
  });

  // ── Landing backstop ───────────────────────────────────────────────────────
  //
  // Two ticks drive one function. The hourly pass is the FLOOR (enumerates from
  // Postgres, re-seeds the queue); `scope=landing&gate=due` is the fast tick that
  // costs only Redis reads when nothing is due.

  describe('landing backstop', () => {
    const GATED = '?scope=landing&gate=due';

    it('a gated tick with nothing due returns before any sweep or query', async () => {
      dueCount = 0;
      const res = await GET(makeRequest('test-secret', GATED));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: 'landing', gated: true, reason: 'nothing_due' });
      expect(mockLandingSweep).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(dbTouches).toEqual([]);
    });

    it('a gated tick with work due runs only the landing sweep, from the due queue', async () => {
      dueCount = 2;
      mockLandingSweep.mockResolvedValue({ ...LANDING_ZERO, source: 'due', processed: 2, merged: 1 });
      const res = await GET(makeRequest('test-secret', GATED));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe('landing');
      expect(body.landing.merged).toBe(1);
      expect(mockLandingSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'due' }]);
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockDeadZone).not.toHaveBeenCalled();
      expect(mockMissionPrSweep).not.toHaveBeenCalled();
    });

    it('fails open when Redis cannot answer: enumerates from Postgres instead of the unreadable queue', async () => {
      dueCount = null;
      await GET(makeRequest('test-secret', GATED));
      expect(mockLandingSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
    });

    it('scope=landing without the gate is its own floor tick', async () => {
      await GET(makeRequest('test-secret', '?scope=landing'));
      expect(mockLandingSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
      expect(mockReconcile).not.toHaveBeenCalled();
    });

    it('a landing-scope sweep that throws is a failed run, not a silent skip', async () => {
      dueCount = 1;
      mockLandingSweep.mockRejectedValue(new Error('landing blew up'));
      const res = await GET(makeRequest('test-secret', GATED));
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('landing blew up');
    });

    it('the hourly merge-state pass runs the floor sweep and reports it', async () => {
      mockLandingSweep.mockResolvedValue({ ...LANDING_ZERO, processed: 3, merged: 1, errors: 1 });
      const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
      expect(res.status).toBe(200);
      expect(mockLandingSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
      expect((await res.json()).landing).toMatchObject({ merged: 1, errors: 1 });
    });

    it('the full pass runs the floor sweep too', async () => {
      await GET(makeRequest('test-secret'));
      expect(mockLandingSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
    });

    it('a landing sweep failure does not discard merge-state healing', async () => {
      mockReconcile.mockResolvedValue({ total: 4, stamped: 2, closed: 0, skipped: 2, errors: 0 });
      mockLandingSweep.mockRejectedValue(new Error('landing query failed'));
      const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reconcile.stamped).toBe(2);
      expect(body.landing.error).toContain('landing query failed');
    });

    it('still requires the cron secret on the gated scope', async () => {
      expect((await GET(makeRequest(undefined, GATED))).status).toBe(401);
      expect(mockLandingSweep).not.toHaveBeenCalled();
    });
  });

  // ── Red-PR sweep ───────────────────────────────────────────────────────────
  //
  // Same two-tick shape as the landing backstop: the hourly pass is the floor,
  // `scope=ci-red&gate=due` is the fast tick the webhook's skipped retries feed.

  describe('red-PR sweep', () => {
    const GATED = '?scope=ci-red&gate=due';

    it('a gated tick with nothing due returns before any sweep or query', async () => {
      dueCount = 0;
      const res = await GET(makeRequest('test-secret', GATED));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, scope: 'ci-red', gated: true, reason: 'nothing_due' });
      expect(mockCiRedSweep).not.toHaveBeenCalled();
      expect(mockLandingSweep).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(dbTouches).toEqual([]);
    });

    it('a gated tick with work due runs only the red-PR sweep, from the due queue', async () => {
      dueCount = 1;
      mockCiRedSweep.mockResolvedValue({ ...CI_RED_ZERO, source: 'due', processed: 1, dispatched: 1 });
      const res = await GET(makeRequest('test-secret', GATED));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe('ci-red');
      expect(body.ciRed.dispatched).toBe(1);
      expect(mockCiRedSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'due' }]);
      expect(mockLandingSweep).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      expect(mockDeadZone).not.toHaveBeenCalled();
    });

    it('fails open when Redis cannot answer', async () => {
      dueCount = null;
      await GET(makeRequest('test-secret', GATED));
      expect(mockCiRedSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
    });

    it('the hourly merge-state pass runs the floor sweep and reports it', async () => {
      mockCiRedSweep.mockResolvedValue({ ...CI_RED_ZERO, processed: 2, dispatched: 1, escalated: 1 });
      const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
      expect(res.status).toBe(200);
      expect(mockCiRedSweep.mock.calls.map(c => c[0])).toEqual([{ source: 'floor' }]);
      expect((await res.json()).ciRed).toMatchObject({ dispatched: 1, escalated: 1 });
    });

    it('a red-PR sweep failure does not discard merge-state healing', async () => {
      mockReconcile.mockResolvedValue({ total: 4, stamped: 2, closed: 0, skipped: 2, errors: 0 });
      mockCiRedSweep.mockRejectedValue(new Error('ci-red query failed'));
      const res = await GET(makeRequest('test-secret', '?scope=merge-state'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reconcile.stamped).toBe(2);
      expect(body.ciRed.error).toContain('ci-red query failed');
    });

    it('the gated landing tick never runs the red-PR sweep', async () => {
      dueCount = 1;
      await GET(makeRequest('test-secret', '?scope=landing&gate=due'));
      expect(mockCiRedSweep).not.toHaveBeenCalled();
    });

    it('still requires the cron secret', async () => {
      expect((await GET(makeRequest(undefined, GATED))).status).toBe(401);
      expect(mockCiRedSweep).not.toHaveBeenCalled();
    });
  });
});
