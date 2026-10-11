import { describe, it, expect } from 'bun:test';
import {
  computeSweepFloors,
  effectiveFloor,
  minutesBeforeIso,
  runFailurePatternSweep,
  SELF_HEALTH_CONSECUTIVE_THRESHOLD,
  SELF_HEALTH_SIGNATURE,
  SWEEP_LOOKBACK_MINUTES,
  tallyFailureRateWindow,
  type FailureRateWorkerRow,
  type SweepDeps,
  type SweepFloors,
} from './failure-pattern-sweep';
import type { FixTaskPort, IncidentAlertSender } from './failure-incident-actions';
import type { IncidentStorePort, StoredIncident } from './failure-incident-store';
import type { PathOverlapObservation, SentinelFacts, WorkerFailureFact } from './failure-pattern-sentinel';
import type { FailureIncidentRule } from '@buildd/shared';

const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const now = () => new Date(T0).toISOString();
const WS1 = '00000000-0000-4000-8000-0000000000a1';
const WS2 = '00000000-0000-4000-8000-0000000000a2';
const WS3 = '00000000-0000-4000-8000-0000000000a3';

// ── fakes ────────────────────────────────────────────────────────────────────

function memoryIncidentPort(): IncidentStorePort & { rows: Map<string, StoredIncident> } {
  const rows = new Map<string, StoredIncident>();
  let seq = 0;
  const key = (s: string, v: string) => `${s}::${v}`;
  return {
    rows,
    async find(s, v) { const r = rows.get(key(s, v)); return r ? structuredClone(r) : null; },
    async findById(id) { for (const r of rows.values()) if (r.id === id) return structuredClone(r); return null; },
    async insert(row) {
      const k = key(row.signature, row.detectorVersion);
      if (rows.has(k)) return null;
      const stored: StoredIncident = { ...structuredClone(row), id: `inc-${++seq}`, version: 0 };
      rows.set(k, stored);
      return structuredClone(stored);
    },
    async listUnresolved(workspaceId: string, rule: FailureIncidentRule) {
      return [...rows.values()]
        .filter(r => r.workspaceId === workspaceId && r.rule === rule && r.status !== 'resolved')
        .map(r => structuredClone(r));
    },
    async compareAndSwap(id, expectedVersion, next) {
      for (const [k, r] of rows) {
        if (r.id !== id) continue;
        if (r.version !== expectedVersion) return null;
        const stored = { ...structuredClone(next), id, version: expectedVersion + 1 };
        rows.set(k, stored);
        return structuredClone(stored);
      }
      return null;
    },
  };
}

function memoryFixTasks(): FixTaskPort & { created: number } {
  const byIncident = new Map<string, string>();
  let seq = 0;
  const state = { created: 0 };
  return {
    get created() { return state.created; },
    async findOpenByIncident(incidentId) { return byIncident.get(incidentId) ?? null; },
    async claim() { return true; },
    async create(draft) {
      state.created++;
      const id = `task-${++seq}`;
      byIncident.set(draft.context.failureIncidentId as string, id);
      return id;
    },
    async touch() {},
  };
}

const sentSender: IncidentAlertSender = async () => true;

/** Ten distinct tasks failing with the same (non-budget, non-transient) signature — a critical repeated_failure. */
function criticalWorkerFailures(countTasks: number): WorkerFailureFact[] {
  return Array.from({ length: countTasks }, (_, i) => ({
    workerId: `worker-${i}`,
    taskId: `task-${i}`,
    signature: 'TypeError: cannot read property of undefined',
    exitCause: 'code_failure',
    occurredAt: now(),
  }));
}

function emptyFacts(workspaceId: string): SentinelFacts {
  return { workspaceId, now: now() };
}

interface FakeOpts {
  facts?: Map<string, SentinelFacts>;
  throwingWorkspaces?: Set<string>;
  listThrows?: boolean;
  incidentPort?: IncidentStorePort;
  fixTasks?: FixTaskPort | null;
  send?: IncidentAlertSender;
  observe?: () => PathOverlapObservation;
}

function fakeDeps(workspaceIds: string[], opts: FakeOpts = {}) {
  const watermarks = new Map<string, string>();
  const watermarkWrites: Array<{ workspaceId: string; at: string }> = [];
  const opsErrors: Array<{ message: string; detail: string; severity: string }> = [];
  let selfHealthConsecutive = 0;

  const deps: SweepDeps = {
    async listWorkspaceIds() {
      if (opts.listThrows) throw new Error('cannot list workspaces');
      return workspaceIds;
    },
    async getWatermark(workspaceId) { return watermarks.get(workspaceId) ?? null; },
    async setWatermark(workspaceId, at) { watermarks.set(workspaceId, at); watermarkWrites.push({ workspaceId, at }); },
    async collectFacts(workspaceId) {
      if (opts.throwingWorkspaces?.has(workspaceId)) throw new Error(`facts unavailable for ${workspaceId}`);
      return opts.facts?.get(workspaceId) ?? emptyFacts(workspaceId);
    },
    incidentPort: opts.incidentPort,
    decide: null, // keep triage deterministic/DB-free in tests
    send: opts.send ?? sentSender,
    fixTasks: opts.fixTasks === undefined ? null : opts.fixTasks,
    ...(opts.observe ? { observePathOverlapSubjects: async () => opts.observe!() } : {}),
    async reportOpsError(message, detail, severity) { opsErrors.push({ message, detail, severity }); },
    async recordSelfHealth(ok) {
      selfHealthConsecutive = ok ? 0 : selfHealthConsecutive + 1;
      return { consecutiveFailures: selfHealthConsecutive };
    },
  };

  return { deps, watermarks, watermarkWrites, opsErrors, get selfHealthConsecutive() { return selfHealthConsecutive; } };
}

// ── window math ──────────────────────────────────────────────────────────────

describe('effectiveFloor', () => {
  it('uses the rolling-window floor when there is no watermark yet', () => {
    expect(effectiveFloor(null, now(), 60)).toBe(minutesBeforeIso(now(), 60));
  });

  it('uses the watermark when it is older than the rolling window (covers the gap)', () => {
    const oldWatermark = minutesBeforeIso(now(), 500);
    expect(effectiveFloor(oldWatermark, now(), 60)).toBe(oldWatermark);
  });

  it('uses the rolling-window floor when the watermark is newer (never shrinks the window)', () => {
    const freshWatermark = minutesBeforeIso(now(), 5);
    expect(effectiveFloor(freshWatermark, now(), 60)).toBe(minutesBeforeIso(now(), 60));
  });
});

describe('computeSweepFloors', () => {
  it('derives every floor from the same watermark and now', () => {
    const floors: SweepFloors = computeSweepFloors(null, now());
    expect(floors.workerFailuresSince).toBe(minutesBeforeIso(now(), SWEEP_LOOKBACK_MINUTES.workerFailures));
    expect(floors.failureRateRecentSince).toBe(minutesBeforeIso(now(), SWEEP_LOOKBACK_MINUTES.failureRateRecent));
    expect(floors.failureRateBaselineSince).toBe(
      minutesBeforeIso(now(), SWEEP_LOOKBACK_MINUTES.failureRateRecent + SWEEP_LOOKBACK_MINUTES.failureRateBaseline),
    );
  });
});

describe('tallyFailureRateWindow', () => {
  const IN_FLIGHT = ['idle', 'starting', 'running', 'waiting_input', 'paused', 'superseded'] as const;
  const at = (minutesAgo: number) => minutesBeforeIso(now(), minutesAgo);
  const row = (id: string, status: string, createdMinutesAgo: number, completedMinutesAgo: number | null, exitCause: FailureRateWorkerRow['exitCause'] = null): FailureRateWorkerRow => ({
    id, status, exitCause, createdAt: at(createdMinutesAgo), completedAt: completedMinutesAgo === null ? null : at(completedMinutesAgo),
  });

  // The incident shape: fast failures created this hour have already ended,
  // the successes created this hour are still running, and the successes that
  // ended this hour were created earlier. Windowing on createdAt read this as
  // a 100% failure rate; windowing on when the worker ended reads 3 of 8.
  it('windows on when the worker ended, not when it was created', () => {
    const rows = [
      row('fast-fail-1', 'failed', 20, 19, 'budget_limited'),
      row('fast-fail-2', 'failed', 15, 14, 'code_failure'),
      row('fast-fail-3', 'error', 10, 9, 'code_failure'),
      row('still-running-1', 'running', 30, null),
      row('still-running-2', 'running', 5, null),
      ...[1, 2, 3, 4, 5].map(i => row(`long-ok-${i}`, 'completed', 90 + i, 10 + i)),
    ];
    const recent = tallyFailureRateWindow(rows, at(60), now(), IN_FLIGHT);
    expect(recent.counts).toEqual({ failed: 3, total: 8 });
    expect(recent.failures.map(f => f.at)).toEqual([at(19), at(14), at(9)]);
  });

  it('keeps a worker that ended in the window out of the window it was created in', () => {
    const rows = [row('ok', 'completed', 90, 10)];
    expect(tallyFailureRateWindow(rows, at(60 + 1440), at(60), IN_FLIGHT).counts).toEqual({ failed: 0, total: 0 });
    expect(tallyFailureRateWindow(rows, at(60), now(), IN_FLIGHT).counts).toEqual({ failed: 0, total: 1 });
  });

  it('drops bookkeeping exits from numerator and denominator, as failure analytics does', () => {
    const rows = [
      row('never-started', 'failed', 20, 10, 'never_started'),
      row('parked', 'failed', 20, 10, 'needs_input'),
      row('real', 'failed', 20, 10, 'code_failure'),
      row('ok', 'completed', 20, 10),
    ];
    expect(tallyFailureRateWindow(rows, at(60), now(), IN_FLIGHT).counts).toEqual({ failed: 1, total: 2 });
  });

  it('falls back to createdAt for a terminal row with no completedAt', () => {
    const rows = [row('legacy', 'failed', 10, null, 'code_failure')];
    expect(tallyFailureRateWindow(rows, at(60), now(), IN_FLIGHT).counts).toEqual({ failed: 1, total: 1 });
  });
});

// ── the sweep ────────────────────────────────────────────────────────────────

describe('runFailurePatternSweep', () => {
  // @notify-fire: failure-pattern-sentinel
  it('opens one incident, pages, and files a fix task for a critical pattern', async () => {
    const incidentPort = memoryIncidentPort();
    const fixTasks = memoryFixTasks();
    const facts = new Map([[WS1, { ...emptyFacts(WS1), workerFailures: criticalWorkerFailures(10) }]]);
    const { deps } = fakeDeps([WS1], { facts, incidentPort, fixTasks });

    const counters = await runFailurePatternSweep(deps, { now });

    expect(counters.workspacesEvaluated).toBe(1);
    expect(counters.windowsEvaluated).toBe(1);
    expect(counters.candidates).toBe(1);
    expect(counters.incidentsOpened).toBe(1);
    expect(counters.incidentsUpdated).toBe(0);
    expect(counters.duplicatesSuppressed).toBe(0);
    expect(counters.alertsSent).toBe(1);
    expect(counters.fixTasksFiled).toBe(1);
    expect(counters.runFailures).toBe(0);
    expect(fixTasks.created).toBe(1);
    expect(incidentPort.rows.size).toBe(1);
    expect([...incidentPort.rows.values()][0].severity).toBe('critical');
  });

  it('is idempotent: a second sweep over the same (overlapping) facts suppresses the duplicate', async () => {
    const incidentPort = memoryIncidentPort();
    const facts = new Map([[WS1, { ...emptyFacts(WS1), workerFailures: criticalWorkerFailures(10) }]]);
    const { deps } = fakeDeps([WS1], { facts, incidentPort });

    const first = await runFailurePatternSweep(deps, { now });
    expect(first.incidentsOpened).toBe(1);

    // Simulate a cron run landing right after a triggered run already covered
    // this window: same underlying facts, no new occurrences.
    const second = await runFailurePatternSweep(deps, { now });
    expect(second.incidentsOpened).toBe(0);
    expect(second.incidentsUpdated).toBe(0);
    expect(second.duplicatesSuppressed).toBe(1);
    expect(incidentPort.rows.size).toBe(1);
  });

  it('advances the watermark for a quiet workspace with no candidates', async () => {
    const { deps, watermarkWrites } = fakeDeps([WS1]);
    const counters = await runFailurePatternSweep(deps, { now });
    expect(counters.candidates).toBe(0);
    expect(counters.workspacesEvaluated).toBe(1);
    expect(watermarkWrites).toEqual([{ workspaceId: WS1, at: now() }]);
  });

  it('isolates a failing workspace: the others still get evaluated and counted', async () => {
    const incidentPort = memoryIncidentPort();
    const facts = new Map([[WS3, { ...emptyFacts(WS3), workerFailures: criticalWorkerFailures(10) }]]);
    const { deps, opsErrors, watermarkWrites } = fakeDeps([WS1, WS2, WS3], {
      facts,
      incidentPort,
      throwingWorkspaces: new Set([WS2]),
    });

    const counters = await runFailurePatternSweep(deps, { now });

    expect(counters.workspacesEvaluated).toBe(2); // WS1 and WS3, not WS2
    expect(counters.runFailures).toBe(1);
    expect(counters.incidentsOpened).toBe(1); // WS3's pattern still recorded
    expect(opsErrors.some(e => e.detail.includes(WS2))).toBe(true);
    expect(watermarkWrites.map(w => w.workspaceId).sort()).toEqual([WS1, WS3]);
  });

  it('reports a per-candidate store failure as an ops error without losing other workspaces', async () => {
    const goodPort = memoryIncidentPort();
    const breakingPort: IncidentStorePort = {
      ...goodPort,
      async find() { throw new Error('db unavailable'); },
    };
    const facts = new Map([
      [WS1, { ...emptyFacts(WS1), workerFailures: criticalWorkerFailures(10) }],
      [WS2, { ...emptyFacts(WS2), workerFailures: criticalWorkerFailures(10) }],
    ]);
    // One shared port that breaks for everyone exercises the per-candidate
    // onError path (recordIncidentCandidates itself never throws) rather than
    // the outer per-workspace try/catch.
    const { deps, opsErrors } = fakeDeps([WS1, WS2], { facts, incidentPort: breakingPort });

    const counters = await runFailurePatternSweep(deps, { now });

    expect(counters.runFailures).toBeGreaterThan(0);
    expect(counters.incidentsOpened).toBe(0);
    expect(opsErrors.length).toBeGreaterThan(0);
  });

  it('never opens a sentinel incident about a single flaky workspace among many healthy ones', async () => {
    const incidentPort = memoryIncidentPort();
    const many = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-00000000${String(i).padStart(4, '0')}`);
    const { deps } = fakeDeps(many, { incidentPort, throwingWorkspaces: new Set([many[0]]) });

    for (let i = 0; i < SELF_HEALTH_CONSECUTIVE_THRESHOLD + 2; i++) {
      await runFailurePatternSweep(deps, { now });
    }

    expect([...incidentPort.rows.values()].some(r => r.signature === SELF_HEALTH_SIGNATURE)).toBe(false);
  });

  it('escalates to one self-health incident after enough consecutive degraded runs, not before', async () => {
    const incidentPort = memoryIncidentPort();
    const { deps } = fakeDeps([WS1, WS2], { incidentPort, listThrows: true });

    for (let i = 0; i < SELF_HEALTH_CONSECUTIVE_THRESHOLD - 1; i++) {
      await runFailurePatternSweep(deps, { now });
      expect([...incidentPort.rows.values()].some(r => r.signature === SELF_HEALTH_SIGNATURE)).toBe(false);
    }

    await runFailurePatternSweep(deps, { now });
    const selfHealthRows = [...incidentPort.rows.values()].filter(r => r.signature === SELF_HEALTH_SIGNATURE);
    expect(selfHealthRows).toHaveLength(1);
    expect(selfHealthRows[0].severity).toBe('critical');
  });

  it('a listWorkspaceIds failure is still reported as an ops error, not a thrown exception', async () => {
    const { deps, opsErrors } = fakeDeps([], { listThrows: true });
    const counters = await runFailurePatternSweep(deps, { now });
    expect(counters.runFailures).toBe(1);
    expect(opsErrors.length).toBe(1);
  });
});

// ── path-overlap incidents reconcile against current facts ──────────────────

describe('runFailurePatternSweep: path-overlap incidents resolve on current facts', () => {
  const STALL = 120;
  const minutesAgo = (m: number) => new Date(T0 - m * 60_000).toISOString();
  const deferral = (over: Partial<NonNullable<SentinelFacts['pathOverlapDeferrals']>[number]> = {}) => ({
    taskId: 'task-a', blockingPrNumber: 77, firstDeferredAt: minutesAgo(STALL + 60), lastDeferredAt: minutesAgo(5),
    lastProgressAt: null, taskStatus: 'pending', blockerState: 'open' as const, ...over,
  });
  const observation = (taskStatus: string | null, pr: 'open' | 'merged' | 'closed' | 'unknown'): PathOverlapObservation => ({
    tasks: new Map([['task-a', { status: taskStatus, lastWorkerAt: null }]]),
    prs: new Map([[77, pr]]),
  });

  async function openIncident() {
    const incidentPort = memoryIncidentPort();
    let facts: SentinelFacts = { ...emptyFacts(WS1), pathOverlapDeferrals: [deferral()] };
    let obs = observation('pending', 'open');
    const factsMap = { get: () => facts } as unknown as Map<string, SentinelFacts>;
    const { deps } = fakeDeps([WS1], { facts: factsMap, incidentPort, observe: () => obs });
    const first = await runFailurePatternSweep(deps, { now });
    expect(first.incidentsOpened).toBe(1);
    return {
      incidentPort,
      deps,
      row: () => [...incidentPort.rows.values()][0],
      set(next: { facts?: SentinelFacts; obs?: PathOverlapObservation }) {
        if (next.facts) facts = next.facts;
        if (next.obs) obs = next.obs;
      },
    };
  }

  it('a stale incident is resolved by the sweep after its blocker merged, with no merge event seen', async () => {
    const h = await openIncident();
    const before = h.row();
    // The merge webhook was missed: the only signal is the sweep's fresh read.
    // The old deferral rows are still inside the 24h window.
    h.set({
      facts: { ...emptyFacts(WS1), pathOverlapDeferrals: [deferral({ blockerState: 'merged' })] },
      obs: observation('pending', 'merged'),
    });
    const counters = await runFailurePatternSweep(h.deps, { now });
    expect(counters.incidentsResolved).toBe(1);
    expect(counters.incidentsOpened + counters.incidentsUpdated).toBe(0);
    const after = h.row();
    expect(after.status).toBe('resolved');
    expect(after.resolvedAt).toBe(now());
    // History is kept: the row, its evidence and its counts are untouched.
    expect(after.evidenceRefs).toEqual(before.evidenceRefs);
    expect(after.occurrenceCount).toBe(before.occurrenceCount);

    const again = await runFailurePatternSweep(h.deps, { now });
    expect(again.incidentsResolved).toBe(0);
    expect(h.row().status).toBe('resolved');
  });

  it('resolves once the waiting task completed, even with the blocker still open', async () => {
    const h = await openIncident();
    h.set({ facts: emptyFacts(WS1), obs: observation('completed', 'open') });
    const counters = await runFailurePatternSweep(h.deps, { now });
    expect(counters.incidentsResolved).toBe(1);
    expect(h.row().status).toBe('resolved');
  });

  it('a real remaining blocker keeps the incident open', async () => {
    const h = await openIncident();
    h.set({ facts: emptyFacts(WS1), obs: observation('pending', 'open') });
    const counters = await runFailurePatternSweep(h.deps, { now });
    expect(counters.incidentsResolved).toBe(0);
    expect(h.row().status).toBe('open');
  });

  it('unknown evidence is not a resolution', async () => {
    const h = await openIncident();
    h.set({ facts: emptyFacts(WS1), obs: observation(null, 'unknown') });
    expect((await runFailurePatternSweep(h.deps, { now })).incidentsResolved).toBe(0);
    expect(h.row().status).toBe('open');
  });

  it('never resolves an incident its own rule still reports in this sweep', async () => {
    const h = await openIncident();
    h.set({ obs: observation('completed', 'merged') }); // facts still say stalled behind an open PR
    expect((await runFailurePatternSweep(h.deps, { now })).incidentsResolved).toBe(0);
    expect(h.row().status).toBe('open');
  });
});
