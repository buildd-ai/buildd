import { describe, it, expect } from 'bun:test';
import {
  computeSweepFloors,
  effectiveFloor,
  minutesBeforeIso,
  runFailurePatternSweep,
  SELF_HEALTH_CONSECUTIVE_THRESHOLD,
  SELF_HEALTH_SIGNATURE,
  SWEEP_LOOKBACK_MINUTES,
  type SweepDeps,
  type SweepFloors,
} from './failure-pattern-sweep';
import type { FixTaskPort, IncidentAlert, IncidentAlertSender } from './failure-incident-actions';
import type { IncidentStorePort, StoredIncident } from './failure-incident-store';
import type { SentinelFacts, WorkerFailureFact } from './failure-pattern-sentinel';
import {
  evaluatePathOverlap,
  type PathOverlapBlockerFacts,
  type PathOverlapRecoveryFacts,
  type PathOverlapSubjectFacts,
} from './failure-incident-recovery-path-overlap';
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

// ── recovery backstop (docs/specs/failure-incident-recovery.md §12(a)) ────────

describe('runFailurePatternSweep: open path-overlap incidents are assessed on fresh facts', () => {
  const STALL = 120;
  const minutesAgo = (m: number) => new Date(T0 - m * 60_000).toISOString();
  const deferral = (over: Partial<NonNullable<SentinelFacts['pathOverlapDeferrals']>[number]> = {}) => ({
    taskId: 'task-a', blockingPrNumber: 77, firstDeferredAt: minutesAgo(STALL + 60), lastDeferredAt: minutesAgo(5),
    lastProgressAt: null, taskStatus: 'pending', blockerState: 'open' as const, ...over,
  });
  const subject = (over: Partial<PathOverlapSubjectFacts> = {}): PathOverlapSubjectFacts => ({
    taskId: 'task-a', status: 'pending', lastWorkerAt: null, wokenAt: null, subjectPrNumber: null,
    lastDeferral: { at: minutesAgo(5), prNumber: 77, blockingTaskId: 'holder', firstDeferredAt: minutesAgo(STALL + 60), paths: ['a.ts'] },
    ...over,
  });
  const blocker = (over: Partial<PathOverlapBlockerFacts> = {}): PathOverlapBlockerFacts => ({
    prNumber: 77, taskId: 'holder', createdAt: minutesAgo(600), prState: 'open', deliveryState: 'CI_PENDING', lastMovedAt: minutesAgo(1),
    leasesHeld: 0, unnotifiedWaiters: [], dependsOnSubjects: [], diffPaths: null, ...over,
  });

  async function openIncident() {
    const incidentPort = memoryIncidentPort();
    let facts: SentinelFacts = { ...emptyFacts(WS1), pathOverlapDeferrals: [deferral()] };
    let recoveryFacts: PathOverlapRecoveryFacts | Error = { subjects: [subject()], blocker: blocker(), fixTask: null };
    const effects: string[] = [];
    const sent: IncidentAlert[] = [];
    const factsMap = { get: () => facts } as unknown as Map<string, SentinelFacts>;
    const { deps, opsErrors } = fakeDeps([WS1], { facts: factsMap, incidentPort, send: async a => { sent.push(a); return false; } });
    deps.recovery = {
      families: [{
        rule: 'path_overlap_stall',
        async observe() { if (recoveryFacts instanceof Error) throw recoveryFacts; return { complete: true, facts: recoveryFacts }; },
        evaluate: evaluatePathOverlap,
      }],
      effects: {
        async releaseBlocker(id) { effects.push(`release:${id}`); },
        async wakeSubject(id) { effects.push(`wake:${id}`); },
        async fileFixTask() { effects.push('fix'); return null; },
      },
    };
    let clock = T0;
    const run = (advanceMin = 0) => { clock += advanceMin * 60_000; return runFailurePatternSweep(deps, { now: () => new Date(clock).toISOString() }); };
    const first = await run();
    expect(first.incidentsOpened).toBe(1);
    return {
      run, effects, sent, opsErrors,
      row: () => [...incidentPort.rows.values()][0],
      set(next: { facts?: SentinelFacts; recovery?: PathOverlapRecoveryFacts | Error }) {
        if (next.facts) facts = next.facts;
        if (next.recovery) recoveryFacts = next.recovery;
      },
    };
  }

  it('a new incident is assessed in the sweep that opened it, and re-gated on that assessment', async () => {
    const h = await openIncident();
    expect(h.row().recovery?.state).toBe('waiting');
    expect(h.row().recovery?.nextCheckAt).not.toBeNull();
    expect(h.sent.some(a => a.dedupeKey.endsWith(':waiting'))).toBe(true);
  });

  it('nothing is re-assessed before its promised check', async () => {
    const h = await openIncident();
    const version = h.row().version;
    const again = await h.run(1);
    expect(again.incidentsAssessed).toBe(0);
    expect(h.row().version).toBe(version);
  });

  it('a missed merge: the blocker merged with its leases held → released once, then resolved once the task moves', async () => {
    const h = await openIncident();
    h.set({ facts: emptyFacts(WS1), recovery: { subjects: [subject()], blocker: blocker({ prState: 'merged', leasesHeld: 2 }), fixTask: null } });
    const c1 = await h.run(6);
    expect(c1.recoveryRepairs).toBe(1);
    expect(h.effects).toEqual(['release:holder']);
    expect(h.row().status).toBe('open');

    // Released and woken, but nothing picked it up: still open, no second repair.
    h.set({ recovery: { subjects: [subject({ wokenAt: new Date(T0 + 7 * 60_000).toISOString() })], blocker: blocker({ prState: 'merged' }), fixTask: null } });
    await h.run(3);
    expect(h.effects).toEqual(['release:holder']);
    expect(h.row().status).toBe('open');

    h.set({ recovery: { subjects: [subject({ status: 'completed' })], blocker: blocker({ prState: 'merged' }), fixTask: null } });
    const c3 = await h.run(10);
    expect(c3.incidentsResolved).toBe(1);
    expect(h.row().status).toBe('resolved');
    expect(h.row().recovery?.state).toBe('recovered');
    // History is kept.
    expect(h.row().occurrenceCount).toBe(1);
  });

  it('unknown evidence is inconclusive, never resolved', async () => {
    const h = await openIncident();
    h.set({ facts: emptyFacts(WS1), recovery: new Error('read failed') });
    await h.run(6);
    expect(h.row().status).toBe('open');
    expect(h.row().recovery?.state).toBe('inconclusive');
  });
});

describe('the collector feeds per-blocker episodes (G1) into detection', () => {
  it('AC-1: a long wait behind PR A then a short one behind PR B opens nothing for B', async () => {
    const minutesAgo = (m: number) => new Date(T0 - m * 60_000).toISOString();
    const incidentPort = memoryIncidentPort();
    const facts = new Map([[WS1, { ...emptyFacts(WS1), pathOverlapDeferrals: [
      { taskId: 't', blockingPrNumber: 1, firstDeferredAt: minutesAgo(190), lastDeferredAt: minutesAgo(11), lastProgressAt: null, taskStatus: 'pending', blockerState: 'open' as const },
      { taskId: 't', blockingPrNumber: 2, firstDeferredAt: minutesAgo(10), lastDeferredAt: minutesAgo(1), lastProgressAt: null, taskStatus: 'pending', blockerState: 'open' as const },
    ] }]]);
    const { deps } = fakeDeps([WS1], { facts, incidentPort });
    const c = await runFailurePatternSweep(deps, { now });
    expect(c.incidentsOpened).toBe(0);
  });
});
