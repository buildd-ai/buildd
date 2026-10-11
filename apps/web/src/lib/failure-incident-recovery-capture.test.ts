/**
 * Capture-pipeline recovery (docs/specs/failure-incident-recovery.md §16.3,
 * §16.4, §16.6): the `infrastructure_failure` rule for `visual_qa.*`, its
 * policy, the task/mission adapters and the rollout, against AC-13..AC-17.
 *
 * Regression shape (§16.1): two surface audits in one mission whose capture
 * failed on the same scrub statement. Before this, each auditor asked its
 * owner "How should I proceed?"; now they are subjects of one incident that
 * files one fix, retries the capture after it, and never asks a person.
 *
 * Only the fact reads and the writers are faked; the rule engine, the
 * planner, the assessment and the sweep are the real ones.
 */
import { describe, expect, it } from 'bun:test';
import {
  CONFIG_ERROR_SETUP_ACTIONS,
  classifyCaptureFailure,
  classifyConfigError,
  formatCaptureFailureError,
} from '@buildd/core/visual-qa-page-source';
import { detectFailurePatterns, type CaptureFailureFact, type SentinelFacts } from './failure-pattern-sentinel';
import { assessIncident, planRecovery, readRecovery, type RecoveryDeps, type RecoveryEffects, type RecoveryFamily } from './failure-incident-recovery';
import {
  captureFactFor,
  evaluateCaptureFailure,
  freshCaptureSucceeded,
  legacyRollout,
  parseCaptureSignature,
  pickRunForQuestion,
  readCaptureRollout,
  runCaptureAdapters,
  runCaptureRef,
  type CaptureRecoveryAdapters,
  type CaptureRecoveryFacts,
  type CaptureSubjectFacts,
} from './failure-incident-recovery-capture';
import { createInfrastructureRecoveryFamily } from './failure-incident-recovery-infrastructure';
import { mergeIncident, type IncidentStorePort, type StoredIncident } from './failure-incident-store';
import { incidentEscalationRule } from './failure-incident-escalation';
import { runFailurePatternSweep, type SweepDeps } from './failure-pattern-sweep';
import { taskRecoveryView } from './incident-recovery-refs';
import type { FailureIncidentRule } from '@buildd/shared';

const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const WS = '00000000-0000-4000-8000-0000000000c1';
const MISSION = 'mmmmmmmm-0000-4000-8000-000000000001';
const AUDIT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const AUDIT_B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const REF = 'mission/some-mission-branch';

// The concrete §16.1 failure: the scrub step dies on an immutability trigger.
const SCRUB = classifyCaptureFailure({
  step: 'Scrub prod clone to placeholders',
  error: 'psql:scripts/qa/scrub-pii.sql:42: ERROR:  artifact_revisions rows are immutable',
});

function fact(taskId: string, over: Partial<CaptureFailureFact> = {}): CaptureFailureFact {
  return {
    taskId, missionId: MISSION, component: 'visual_qa.scrub', errorSignature: SCRUB.errorSignature,
    occurredAt: at(-5), workerId: `w-${taskId.slice(0, 4)}`, runId: '1', ref: REF, ...over,
  };
}

function openFrom(facts: CaptureFailureFact[]): StoredIncident {
  const [candidate] = detectFailurePatterns({ workspaceId: WS, now: at(0), captureFailures: facts });
  const merged = mergeIncident(null, candidate).next as Omit<StoredIncident, 'id' | 'version'>;
  return { ...merged, id: 'inc-1', version: 0 } as StoredIncident;
}

function subject(taskId: string, over: Partial<CaptureSubjectFacts> = {}): CaptureSubjectFacts {
  return { taskId, missionId: MISSION, status: 'failed', ref: REF, headSha: null, failedAt: at(-5), openQuestionWorkerIds: [], ...over };
}

function facts(over: Partial<CaptureRecoveryFacts> = {}): CaptureRecoveryFacts {
  return { component: 'visual_qa.scrub', errorSignature: SCRUB.errorSignature, subjects: [subject(AUDIT_A), subject(AUDIT_B)], fixTask: null, runs: [], ...over };
}

function memoryPort(initial: StoredIncident) {
  let row = structuredClone(initial);
  const port: IncidentStorePort = {
    async find() { return structuredClone(row); },
    async findById(id) { return id === row.id ? structuredClone(row) : null; },
    async insert() { return null; },
    async compareAndSwap(id, expected, next) {
      if (id !== row.id || row.version !== expected) return null;
      row = { ...structuredClone(next), id, version: expected + 1 };
      return structuredClone(row);
    },
  };
  return { port, get: () => row };
}

function recordingAdapters() {
  const calls = { attach: [] as Array<{ taskIds: string[]; generation: number }>, supersede: [] as string[][], resume: [] as string[][] };
  const adapters: CaptureRecoveryAdapters = {
    async attachRef(taskIds, ref) { calls.attach.push({ taskIds, generation: ref.generation }); },
    async supersedeQuestions(taskIds) { calls.supersede.push(taskIds); return taskIds.length; },
    async resume(taskIds) { calls.resume.push(taskIds); return taskIds; },
  };
  return { adapters, calls };
}

function recordingEffects() {
  const calls = { fix: 0, retries: [] as string[][] };
  const effects: RecoveryEffects = {
    async releaseBlocker() {}, async wakeSubject() {},
    async fileFixTask() { calls.fix++; return 'fix-1'; },
    async retryCapture(ids) { calls.retries.push(ids); return ids; },
  };
  return { effects, calls };
}

/** The real capture policy and adapters, behind the real infrastructure router, over facts set by the test. */
function family(adapters: CaptureRecoveryAdapters, read: () => CaptureRecoveryFacts) {
  const capture: RecoveryFamily<CaptureRecoveryFacts> = {
    rule: 'infrastructure_failure',
    observe: async () => ({ complete: true, facts: read() }),
    evaluate: evaluateCaptureFailure,
    afterAssess: (i, p) => runCaptureAdapters(adapters, i, p),
  };
  return createInfrastructureRecoveryFamily(capture);
}

// ── The rule (I-10) ──────────────────────────────────────────────────────────

describe('the rule: one incident per (workspace, component, error signature)', () => {
  it('two audits failing on the same scrub statement are one incident with both as subjects (AC-13)', () => {
    const candidates = detectFailurePatterns({ workspaceId: WS, now: at(0), captureFailures: [fact(AUDIT_A), fact(AUDIT_B, { occurredAt: at(-2) })] });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.rule).toBe('infrastructure_failure');
    expect(c.signature).toBe(`infrastructure_failure|ws=${WS}|component=visual_qa.scrub|sig=${SCRUB.errorSignature}`);
    expect(c.reasonCode).toBe('infrastructure_failure.visual_qa.scrub');
    expect(c.affected.taskIds.sort()).toEqual([AUDIT_A, AUDIT_B].sort());
    expect(c.severity).toBe('high');
    // Keyed on the cause: no run, task or raw psql location in it.
    expect(c.signature).not.toContain('psql');
    expect(parseCaptureSignature(c.signature)).toEqual({ component: 'visual_qa.scrub', errorSignature: SCRUB.errorSignature });
  });

  it('a different statement, or a different component, is a different incident', () => {
    const other = classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'ERROR: column "x" does not exist' });
    const candidates = detectFailurePatterns({
      workspaceId: WS, now: at(0),
      captureFailures: [fact(AUDIT_A), fact(AUDIT_B, { errorSignature: other.errorSignature }), fact('cccccccc-0000-4000-8000-0000000000c3', { component: 'visual_qa.guard' })],
    });
    expect(candidates).toHaveLength(3);
  });

  it('before its first assessment the gate holds it as Buildd\'s, never the person\'s', () => {
    const inc = openFrom([fact(AUDIT_A)]);
    expect(incidentEscalationRule({ status: 'open', severity: inc.severity, rule: inc.rule } as any).owner).toBe('buildd');
  });
});

describe('which reports are capture facts (§16.2)', () => {
  const task = { id: AUDIT_A, missionId: MISSION, context: {} };
  const worker = (error: string) => ({ id: 'w-1', error, createdAt: new Date(at(-6)), completedAt: new Date(at(-5)) });

  it('a typed infrastructure report is a fact, with its ref', () => {
    const f = captureFactFor(task, worker(formatCaptureFailureError({ ...SCRUB, ref: REF, runId: '7' })));
    expect(f).toMatchObject({ taskId: AUDIT_A, component: 'visual_qa.scrub', errorSignature: SCRUB.errorSignature, ref: REF, occurredAt: at(-5) });
  });

  it('a preview auth wall is the owner\'s setup: no fact, and its question offers typed setup actions, not retry or cancel (AC-17)', () => {
    const wall = classifyConfigError('app_auth_not_configured', 'Capture screenshots and a11y snapshots');
    expect(wall.ownership).toBe('person');
    expect(captureFactFor(task, worker(formatCaptureFailureError(wall)))).toBeNull();
    const labels = CONFIG_ERROR_SETUP_ACTIONS.app_auth_not_configured.map(a => a.label.toLowerCase());
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some(l => /retry|cancel/.test(l))).toBe(false);
  });

  it('an unclassified step is not an infrastructure incident', () => {
    const unknown = classifyCaptureFailure({ step: 'Some new step', error: 'boom' });
    expect(unknown.ownership).toBe('inconclusive');
    expect(captureFactFor(task, worker(formatCaptureFailureError(unknown)))).toBeNull();
  });

  it('an ordinary failure is not one', () => {
    expect(captureFactFor(task, worker('TypeError: x is undefined'))).toBeNull();
  });
});

// ── The policy ───────────────────────────────────────────────────────────────

describe('the policy, in order', () => {
  const inc = openFrom([fact(AUDIT_A), fact(AUDIT_B)]);

  it('is infrastructure-owned, with the blocked tasks and their mission as subjects', () => {
    const o = evaluateCaptureFailure(inc, facts(), at(1));
    expect(o.cause).toEqual({ reasonCode: 'infrastructure_failure.visual_qa.scrub', rule: 'infrastructure_failure', ownership: 'infrastructure' });
    expect(o.subjects).toEqual([{ kind: 'task', id: AUDIT_A }, { kind: 'task', id: AUDIT_B }, { kind: 'mission', id: MISSION }]);
    expect(o.fallbackOperator?.capability).toBe('repair_infrastructure:visual_qa.scrub');
  });

  it('no fix task: file one, once', () => {
    expect(evaluateCaptureFailure(inc, facts(), at(1)).verdict).toMatchObject({ kind: 'repair', action: 'file_fix_task', once: true });
  });

  it('fix task running: delegated, and the fix is the blocker', () => {
    const o = evaluateCaptureFailure(inc, facts({ fixTask: { id: 'fix-1', status: 'in_progress', finishedAt: null } }), at(10));
    expect(o.verdict).toMatchObject({ kind: 'delegated', nextActionKind: 'fix_task_running', ref: 'fix-1' });
    expect(o.blockers.map(b => b.id)).toEqual(['fix-1']);
  });

  it('fix finished and no fresh capture: retry the capture for the failed audits', () => {
    const o = evaluateCaptureFailure(inc, facts({ fixTask: { id: 'fix-1', status: 'completed', finishedAt: at(60) } }), at(61));
    expect(o.verdict).toMatchObject({ kind: 'repair', action: 'retry_capture', params: { taskIds: [AUDIT_A, AUDIT_B] } });
    expect(o.episodeStartedAt).toBe(at(60));
  });

  it('re-queued audits that have not run yet are waited on, not retried again', () => {
    const o = evaluateCaptureFailure(inc, facts({
      fixTask: { id: 'fix-1', status: 'completed', finishedAt: at(60) },
      subjects: [subject(AUDIT_A, { status: 'pending' }), subject(AUDIT_B, { status: 'pending' })],
    }), at(62));
    expect(o.verdict.kind).toBe('wait');
  });

  it('every audit completed (its own capture ran) or ended: passed', () => {
    const o = evaluateCaptureFailure(inc, facts({ subjects: [subject(AUDIT_A, { status: 'completed' }), subject(AUDIT_B, { status: 'cancelled' })] }), at(5));
    expect(o.verdict.kind).toBe('passed');
  });

  it('an unread task is never cleared', () => {
    expect(evaluateCaptureFailure(inc, facts({ subjects: [subject(AUDIT_A, { status: null })] }), at(5)).verdict.kind).toBe('inconclusive');
  });
});

describe('the check: a fresh capture for the audit\'s own ref, after the repair (I-12)', () => {
  const s = subject(AUDIT_A, { failedAt: at(-5) });
  const run = (ref: string, min: number, conclusion = 'success') => ({ ref, createdAt: at(min), conclusion });

  it('passes on a success for its own ref after the repair', () => {
    expect(freshCaptureSucceeded(s, [run(REF, 70)], at(60))).toBe(true);
  });
  it('a success for another ref (trunk, another branch) never counts', () => {
    expect(freshCaptureSucceeded(s, [run('dev', 70), run('main', 70)], at(60))).toBe(false);
  });
  it('a success started before the repair finished never counts', () => {
    expect(freshCaptureSucceeded(s, [run(REF, 50)], at(60))).toBe(false);
  });
  it('a failed run, or runs that could not be read, never count', () => {
    expect(freshCaptureSucceeded(s, [run(REF, 70, 'failure')], at(60))).toBe(false);
    expect(freshCaptureSucceeded(s, null, at(60))).toBe(false);
  });
  it('matches a sha-dispatched run by the audit\'s head', () => {
    expect(freshCaptureSucceeded({ ...s, headSha: 'abc1234' }, [run('abc1234', 70)], at(60))).toBe(true);
  });
  it('reads the run\'s capture ref from its title', () => {
    expect(runCaptureRef(`Visual QA · ${REF}`)).toBe(REF);
    expect(runCaptureRef('Visual QA')).toBeNull();
  });
});

// ── The assessment, end to end ───────────────────────────────────────────────

describe('assessIncident: one fix, adapters on every blocked audit (AC-13)', () => {
  it('files one fix task, points both audits at the incident and closes their stale questions', async () => {
    const inc = openFrom([fact(AUDIT_A), fact(AUDIT_B)]);
    const store = memoryPort(inc);
    const { adapters, calls } = recordingAdapters();
    const { effects, calls: done } = recordingEffects();
    // Audit B is a legacy one: its worker still holds the "How should I proceed?" question.
    let current = facts({ subjects: [subject(AUDIT_A), subject(AUDIT_B, { openQuestionWorkerIds: ['w-b'] })] });
    let now = at(1);
    const deps: RecoveryDeps = { port: store.port, effects, now: () => now, families: [family(adapters, () => current)] };

    const first = await assessIncident(deps, 'inc-1', 'sweep');
    expect(first.outcome).toBe('repaired');
    expect(done.fix).toBe(1);
    expect(calls.attach).toEqual([{ taskIds: [AUDIT_A, AUDIT_B], generation: 1 }]);
    expect(calls.supersede).toEqual([[AUDIT_A, AUDIT_B]]);
    const rec = readRecovery(store.get())!;
    expect(rec.owner).toBe('buildd');
    expect(rec.state).toBe('recovering');
    expect(rec.decision).toBeUndefined();

    // A concurrent trigger: no second fix task.
    await assessIncident(deps, 'inc-1', 'sweep');
    expect(done.fix).toBe(1);

    // The fix task exists and runs: a new generation (the fix is its blocker), delegated.
    now = at(5);
    current = facts({ fixTask: { id: 'fix-1', status: 'in_progress', finishedAt: null } });
    await assessIncident(deps, 'inc-1', 'sweep');
    expect(readRecovery(store.get())).toMatchObject({ state: 'recovering', generation: 2, nextAction: { kind: 'fix_task_running' } });
    expect(done.fix).toBe(1);
    // The adapters re-point the audits at the new generation.
    expect(calls.attach.at(-1)).toEqual({ taskIds: [AUDIT_A, AUDIT_B], generation: 2 });
    expect(calls.resume).toEqual([]);
  });
});

describe('assessIncident: recovered on a fresh capture, then resumed once (AC-14)', () => {
  it('recovers when the repair merged and each audit\'s own ref captured again, and re-queues each audit once', async () => {
    const inc = openFrom([fact(AUDIT_A), fact(AUDIT_B)]);
    const store = memoryPort(inc);
    const { adapters, calls } = recordingAdapters();
    const { effects } = recordingEffects();
    const fixDone = { id: 'fix-1', status: 'completed', finishedAt: at(60) };
    let current = facts({ fixTask: { id: 'fix-1', status: 'in_progress', finishedAt: null } });
    let now = at(10);
    const deps: RecoveryDeps = { port: store.port, effects, now: () => now, families: [family(adapters, () => current)] };
    await assessIncident(deps, 'inc-1', 'sweep');

    // A later capture of the same component succeeded for the audits' own ref.
    now = at(80);
    current = facts({ fixTask: fixDone, runs: [{ ref: REF, createdAt: at(70), conclusion: 'success' }] });
    const res = await assessIncident(deps, 'inc-1', 'sweep');
    expect(readRecovery(store.get())?.state).toBe('recovered');
    expect(res.incident?.status).toBe('resolved');
    expect(calls.resume).toEqual([[AUDIT_A, AUDIT_B]]);
    // Their earlier attempts and questions are history: recovery never superseded anything on recovery.
    expect(calls.supersede).toHaveLength(1);

    // A resolved incident is not assessed again, so nothing is resumed twice.
    now = at(90);
    await assessIncident(deps, 'inc-1', 'sweep');
    expect(calls.resume).toHaveLength(1);
  });

  it('a task view of a recovering audit holds the mission open and supersedes its question', () => {
    const inc = openFrom([fact(AUDIT_A)]);
    const plan = planRecovery({ incident: inc, outcome: evaluateCaptureFailure(inc, facts({ subjects: [subject(AUDIT_A)] }), at(1)), evidenceRevision: 'r', now: at(1), source: 'sweep', complete: true });
    const view = taskRecoveryView({ ...inc, recovery: plan.recovery } as any);
    expect(view?.holdsCompletion).toBe(true);
    expect(view?.supersedesQuestion).toBe(true);
  });
});

// ── Through the sweep: budget, operator, one warning (AC-13, AC-15) ─────────

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
      return [...rows.values()].filter(r => r.workspaceId === workspaceId && r.rule === rule && r.status !== 'resolved').map(r => structuredClone(r));
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

describe('the sentinel sweep drives the family (AC-13, AC-15)', () => {
  it('one incident and one fix for two audits; three failed retries become needs_operator with one ops warning and no person\'s card', async () => {
    const port = memoryIncidentPort();
    const { adapters } = recordingAdapters();
    const { effects, calls } = recordingEffects();
    const opsErrors: Array<{ message: string; severity: string }> = [];
    const sent: Array<{ dedupeKey: string }> = [];
    let sentinel: SentinelFacts = { workspaceId: WS, now: at(0), captureFailures: [fact(AUDIT_A), fact(AUDIT_B)] };
    let current = facts();
    const deps: SweepDeps = {
      async listWorkspaceIds() { return [WS]; },
      async getWatermark() { return null; },
      async setWatermark() {},
      async collectFacts() { return sentinel; },
      recovery: { families: [family(adapters, () => current)], effects },
      incidentPort: port,
      decide: null,
      fixTasks: null,
      send: async (a) => { sent.push({ dedupeKey: a.dedupeKey }); return true; },
      async reportOpsError(message, _detail, severity) { opsErrors.push({ message, severity }); },
      async recordSelfHealth() { return { consecutiveFailures: 0 }; },
    };
    const sweep = (min: number) => runFailurePatternSweep(deps, { workspaceIds: [WS], now: () => at(min) });
    const incident = () => [...port.rows.values()][0];

    // Sweep 1: both audits report the same scrub failure.
    await sweep(0);
    expect(port.rows.size).toBe(1);
    expect(incident().affectedRefs.taskIds.sort()).toEqual([AUDIT_A, AUDIT_B].sort());
    expect(calls.fix).toBe(1);
    sentinel = { workspaceId: WS, now: at(0) };

    // The fix lands.
    current = facts({ fixTask: { id: 'fix-1', status: 'completed', finishedAt: at(10) } });
    let t = 20;
    for (let retry = 1; retry <= 3; retry++) {
      await sweep(t);
      expect(calls.retries).toHaveLength(retry);
      // Re-queued, then the capture fails again, later.
      current = facts({ fixTask: current.fixTask, subjects: [subject(AUDIT_A, { status: 'pending' }), subject(AUDIT_B, { status: 'pending' })] });
      t += 10;
      await sweep(t);
      expect(readRecovery(incident())?.state).toBe('waiting');
      current = facts({ fixTask: current.fixTask, subjects: [subject(AUDIT_A, { failedAt: at(t + 1) }), subject(AUDIT_B, { failedAt: at(t + 1) })] });
      t += 10;
    }

    // A fourth retry is planned: none runs.
    await sweep(t);
    expect(calls.retries).toHaveLength(3);
    const rec = readRecovery(incident())!;
    expect(rec.state).toBe('needs_operator');
    expect(rec.owner).toBe('operator');
    expect(rec.capabilityGap?.capability).toBe('repair_infrastructure:visual_qa.scrub');
    expect(rec.decision).toBeUndefined();
    const warnings = () => opsErrors.filter(e => e.message.includes('needs an operator'));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].severity).toBe('warning');

    // New evidence while still the operator's: no second warning.
    current = facts({ fixTask: current.fixTask, subjects: [subject(AUDIT_A, { failedAt: at(t + 5) }), subject(AUDIT_B, { failedAt: at(t + 5) })] });
    await sweep(t + 30);
    expect(warnings()).toHaveLength(1);
    expect(calls.retries).toHaveLength(3);
    expect(calls.fix).toBe(1);
  });
});

// ── Rollout (AC-16) ──────────────────────────────────────────────────────────

describe('rollout: legacy audit questions', () => {
  const classify = (step: string) => classifyCaptureFailure({ step, error: `step failed: ${step}` });
  const runs = [
    { id: 1, ref: REF, createdAt: at(-50), conclusion: 'failure' },
    { id: 2, ref: REF, createdAt: at(-20), conclusion: 'failure' },
    { id: 3, ref: REF, createdAt: at(-10), conclusion: 'success' },
  ];

  it('picks the newest failed run inside the worker\'s own window', () => {
    expect(pickRunForQuestion(runs, at(-30), at(-5))?.id).toBe(2);
    expect(pickRunForQuestion(runs, at(-5), at(0))).toBeNull();
  });

  it('a question with no typed capture failure on record stays as it is, marked unclassified (AC-16)', () => {
    const none = legacyRollout({ run: null, failedStep: null, workerId: 'w-1', askedAt: at(-5), now: at(0), classify });
    expect(none).toEqual({ classification: 'unclassified', checkedAt: at(0), workerId: 'w-1' });
    const unknownStep = legacyRollout({ run: runs[1], failedStep: 'Some step outside the map', workerId: 'w-1', askedAt: at(-5), now: at(0), classify });
    expect(unknownStep.classification).toBe('unclassified');
    // An unclassified question is never a capture fact, so no incident adopts it.
    expect(captureFactFor({ id: AUDIT_A, missionId: MISSION, context: { captureFailureRollout: unknownStep } }, null)).toBeNull();
  });

  it('a question whose run failed at a known step is adopted into the incident', () => {
    const adopted = legacyRollout({ run: runs[1], failedStep: 'Scrub prod clone to placeholders', workerId: 'w-1', askedAt: at(-5), now: at(0), classify });
    expect(adopted).toMatchObject({ classification: 'adopted', component: 'visual_qa.scrub', runId: '2', ref: REF, at: at(-5) });
    const ctx = { captureFailureRollout: adopted };
    expect(readCaptureRollout(ctx)).toEqual(adopted);
    expect(captureFactFor({ id: AUDIT_A, missionId: MISSION, context: ctx }, null)).toMatchObject({ component: 'visual_qa.scrub', occurredAt: at(-5) });
  });
});
