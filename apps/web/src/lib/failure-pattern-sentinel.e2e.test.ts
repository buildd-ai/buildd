/**
 * Failure Pattern Sentinel — end-to-end regression over the real class of bug
 * this system exists to catch: duplicate CI/retry-stage signals for one
 * logical subject (a PR being fixed more than once in parallel), fed through
 * the exact pipeline production uses — `detectFailurePatterns` ->
 * `recordIncidentCandidates` -> `actOnIncidentResults` — via
 * `runFailurePatternSweep`, the single function both the event trigger and
 * the 30-minute cron backstop call (see failure-pattern-sweep.ts's header).
 *
 * No DB: the store/fix-task/alert ports are in-memory fakes with the same
 * CAS/claim semantics as the real ones (see failure-pattern-sweep.test.ts and
 * failure-incident-actions.test.ts, which this mirrors), so the assertions
 * exercise the real merge/triage/alert/fix-task logic end to end rather than a
 * second, parallel notion of what "the same incident" means.
 *
 * The fixture reproduces the class even though the specific retry-idempotency
 * bug that used to create duplicate children in production may be fixed by
 * the time this runs — the facts are synthetic, not read from a live task.
 */
import { describe, it, expect } from 'bun:test';
import { runFailurePatternSweep, type SweepDeps } from './failure-pattern-sweep';
import {
  updateIncidentState,
  type IncidentStorePort,
  type StoredIncident,
} from './failure-incident-store';
import type {
  FixTaskPort,
  IncidentAlert,
  IncidentAlertSender,
  IncidentDecider,
} from './failure-incident-actions';
import type { RetryChildFact, SentinelFacts, WorkerFailureFact } from './failure-pattern-sentinel';

const WS = '00000000-0000-4000-8000-0000000000e2';
const T0 = Date.parse('2026-10-05T09:00:00.000Z');
const at = (minutesFromT0: number) => new Date(T0 + minutesFromT0 * 60_000).toISOString();

// ── fakes (no database; same CAS/claim contract as the drizzle-backed ports) ─

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

function memoryFixTasks(): FixTaskPort & { created: string[]; touches: number } {
  const byIncident = new Map<string, string>();
  const created: string[] = [];
  let touches = 0;
  let seq = 0;
  return {
    created,
    get touches() { return touches; },
    async findOpenByIncident(incidentId) { return byIncident.get(incidentId) ?? null; },
    async claim() { return true; },
    async create(draft) {
      const id = `task-${++seq}`;
      byIncident.set(draft.context.failureIncidentId as string, id);
      created.push(id);
      return id;
    },
    async touch() { touches++; },
  };
}

/**
 * A harness whose `collectFacts` returns whatever `setFacts` last stored for
 * that workspace — standing in for a fresh collector query over that sweep's
 * window, without re-deriving window math (already covered by
 * failure-pattern-sweep.test.ts). `decide`, when given, also records every
 * call it receives so a test can assert the decision policy was (or was not)
 * consulted at all.
 */
function harness(opts: { decide?: IncidentDecider | null } = {}) {
  const incidentPort = memoryIncidentPort();
  const fixTasks = memoryFixTasks();
  const alerts: IncidentAlert[] = [];
  const decideCalls: unknown[] = [];
  const send: IncidentAlertSender = async (alert) => { alerts.push(alert); return true; };
  const factsByWorkspace = new Map<string, SentinelFacts>();
  const watermarks = new Map<string, string>();
  let selfHealthConsecutive = 0;

  const decide: IncidentDecider | null = opts.decide
    ? async (features, incident) => { decideCalls.push(features); return opts.decide!(features, incident); }
    : opts.decide === undefined ? null : null;

  const deps: SweepDeps = {
    async listWorkspaceIds() { return [...factsByWorkspace.keys()]; },
    async getWatermark(workspaceId) { return watermarks.get(workspaceId) ?? null; },
    async setWatermark(workspaceId, atIso) { watermarks.set(workspaceId, atIso); },
    async collectFacts(workspaceId) { return factsByWorkspace.get(workspaceId)!; },
    incidentPort,
    decide,
    send,
    fixTasks,
    async reportOpsError() {},
    async recordSelfHealth(ok) {
      selfHealthConsecutive = ok ? 0 : selfHealthConsecutive + 1;
      return { consecutiveFailures: selfHealthConsecutive };
    },
  };

  return {
    deps,
    incidentPort,
    fixTasks,
    alerts,
    decideCalls,
    setFacts(workspaceId: string, facts: SentinelFacts) { factsByWorkspace.set(workspaceId, facts); },
  };
}

function retryChild(overrides: Partial<RetryChildFact> & { taskId: string; openedPrNumber: number }): RetryChildFact {
  return {
    parentTaskId: null,
    subjectPrNumber: 42,
    kind: 'ci',
    stage: null,
    iteration: 1,
    createdAt: at(0),
    ...overrides,
  };
}

// ── the real class: duplicate retry/CI signals for one logical subject ──────

describe('Failure Pattern Sentinel — retry-fork end to end', () => {
  it(
    'opens one incident, pages once and files one fix task regardless of caller (trigger vs 30-min cron); ' +
    'repeated evaluation updates count/evidence without re-paging or re-filing; a confident "known_noise" model ' +
    'answer never reaches a critical-floor incident; resolving then reproducing creates a recurrence and re-alerts once',
    async () => {
      let attemptedDowngrade = 0;
      const decide: IncidentDecider = async () => {
        attemptedDowngrade++;
        return { decision: 'known_noise', confidence: 1, reasonCode: 'test_attempted_downgrade', source: 'model' };
      };
      const { deps, incidentPort, fixTasks, alerts, decideCalls, setFacts } = harness({ decide });

      // Two parallel CI retry children for the same subject PR/kind/stage/iteration —
      // each forced to open its own PR because it couldn't reuse the branch. Two
      // distinct opened PRs is a deterministic critical trigger on its own
      // (`openedPrs.length >= 2`), independent of the child-count threshold.
      const childrenV1 = [
        retryChild({ taskId: 'task-a', openedPrNumber: 101 }),
        retryChild({ taskId: 'task-b', openedPrNumber: 102, createdAt: at(1) }),
      ];

      // ── 1. the event trigger's sweep (explicit, single-workspace) ─────────
      setFacts(WS, { workspaceId: WS, now: at(1), retryChildren: childrenV1 });
      let counters = await runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(1) });

      expect(counters.candidates).toBe(1);
      expect(counters.incidentsOpened).toBe(1);
      expect(counters.alertsSent).toBe(1);
      expect(counters.fixTasksFiled).toBe(1);
      expect(incidentPort.rows.size).toBe(1);
      const incidentId = [...incidentPort.rows.values()][0].id;
      expect([...incidentPort.rows.values()][0].severity).toBe('critical');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].priority).toBe(1); // critical pages at Pushover priority 1
      expect(alerts[0].reason).toBe('opened');
      expect(fixTasks.created).toHaveLength(1);

      // The critical floor never asks the decision policy, so a model that would
      // downgrade to "known_noise" is never even consulted — severity cannot be
      // lowered by a decision it is structurally excluded from.
      expect(attemptedDowngrade).toBe(0);
      expect(decideCalls).toHaveLength(0);

      // ── 2. the 30-minute cron backstop sweeping every workspace, same window ─
      // Same underlying facts: idempotent regardless of which caller runs it.
      setFacts(WS, { workspaceId: WS, now: at(1), retryChildren: childrenV1 });
      counters = await runFailurePatternSweep(deps, { now: () => at(1) });

      expect(counters.candidates).toBe(1);
      expect(counters.incidentsOpened).toBe(0);
      expect(counters.incidentsUpdated).toBe(0);
      expect(counters.duplicatesSuppressed).toBe(1);
      expect(counters.alertsSent).toBe(0);
      expect(counters.fixTasksFiled).toBe(0);
      expect(incidentPort.rows.size).toBe(1);
      expect(alerts).toHaveLength(1); // still just the one page from step 1

      // ── 3. repeated evaluation: a third child arrives — count/evidence change, ─
      // but the already-paged, already-fixed incident does not page or file again.
      const childrenV2 = [...childrenV1, retryChild({ taskId: 'task-c', openedPrNumber: 103, createdAt: at(10) })];
      setFacts(WS, { workspaceId: WS, now: at(10), retryChildren: childrenV2 });
      counters = await runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(10) });

      expect(counters.incidentsOpened).toBe(0);
      expect(counters.incidentsUpdated).toBe(1);
      expect(counters.alertsSent).toBe(0);
      expect(counters.fixTasksFiled).toBe(0);
      const afterV2 = await incidentPort.findById(incidentId);
      expect(afterV2!.occurrenceCount).toBe(3);
      expect(afterV2!.severity).toBe('critical');
      expect(fixTasks.touches).toBeGreaterThan(0); // context updated, no new task

      // ── 4. resolve it ───────────────────────────────────────────────────────
      const resolved = await updateIncidentState(incidentPort, incidentId, { type: 'resolve' }, { now: at(15) });
      expect(resolved!.status).toBe('resolved');

      // ── 5. reproduce: a fourth child after resolution ──────────────────────
      const childrenV3 = [...childrenV2, retryChild({ taskId: 'task-d', openedPrNumber: 104, createdAt: at(20) })];
      setFacts(WS, { workspaceId: WS, now: at(20), retryChildren: childrenV3 });
      counters = await runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(20) });

      const afterReopen = await incidentPort.findById(incidentId);
      expect(afterReopen!.status).toBe('open');
      expect(afterReopen!.recurrenceCount).toBe(1);
      expect(counters.incidentsOpened).toBe(0);
      expect(counters.incidentsUpdated).toBe(1); // 'reopened' tallies as updated
      expect(counters.alertsSent).toBe(1); // recurrence re-alerts, exactly once
      expect(alerts).toHaveLength(2);
      expect(alerts[1].reason).toBe('recurrence');
      expect(counters.fixTasksFiled).toBe(0); // still the one fix task from step 1
      expect(fixTasks.created).toHaveLength(1);
    },
  );
});

// ── noisy transient/budget case: ledger-only, never pages, never files ──────

describe('Failure Pattern Sentinel — transient/budget noise stays ledger-only', () => {
  it('a repeated transient-network signature opens a low-severity incident that never pages and never files a fix task', async () => {
    const { deps, incidentPort, fixTasks, alerts, setFacts } = harness({ decide: null });

    const failures: WorkerFailureFact[] = Array.from({ length: 3 }, (_, i) => ({
      workerId: `worker-${i}`,
      taskId: `task-transient-${i}`,
      signature: 'fetch failed: ECONNRESET upstream',
      exitCause: 'code_failure',
      occurredAt: at(i),
    }));
    setFacts(WS, { workspaceId: WS, now: at(5), workerFailures: failures });

    const counters = await runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(5) });

    expect(counters.candidates).toBe(1);
    expect(counters.incidentsOpened).toBe(1);
    expect(counters.alertsSent).toBe(0);
    expect(counters.fixTasksFiled).toBe(0);
    expect(alerts).toHaveLength(0);
    expect(fixTasks.created).toHaveLength(0);

    const [incident] = [...incidentPort.rows.values()];
    // 3 tasks is below repeatedFailureHighTasks (5): rule severity is 'medium',
    // whose channel is the digest, not Pushover — ledger-only by construction.
    expect(incident.severity).toBe('medium');
    expect(incident.status).toBe('open');
    expect(incident.linkedFixTaskId).toBeNull();

    // Re-sweeping the same window changes nothing further: still no page, no task.
    setFacts(WS, { workspaceId: WS, now: at(5), workerFailures: failures });
    const again = await runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(5) });
    expect(again.duplicatesSuppressed).toBe(1);
    expect(again.alertsSent).toBe(0);
    expect(again.fixTasksFiled).toBe(0);
  });
});
