/**
 * The recovery assessment (docs/specs/failure-incident-recovery.md §3–§8),
 * against an in-memory incident store and fake facts. The path-overlap policy
 * is the real one (`evaluatePathOverlap`); only its fact read is faked.
 */
import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import {
  assessIncident,
  evidenceRevision,
  nextBackoffMinutes,
  planRecovery,
  recoveryActionKey,
  recoveryDue,
  RECOVERY_BUDGET_LIMIT,
  type RecoveryDeps,
  type RecoveryEffects,
  type RecoveryPolicyOutcome,
} from './failure-incident-recovery';
import {
  evaluatePathOverlap,
  type PathOverlapBlockerFacts,
  type PathOverlapRecoveryFacts,
  type PathOverlapSubjectFacts,
} from './failure-incident-recovery-path-overlap';
import type { IncidentStorePort, StoredIncident } from './failure-incident-store';

const T0 = Date.parse('2026-10-11T02:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const SUBJECT = '4704311e-0000-4000-8000-000000000001';
const BLOCKER_TASK = 'b10cce00-0000-4000-8000-000000000002';
const PR = 4386;

function incident(over: Partial<StoredIncident> = {}): StoredIncident {
  return {
    id: 'inc-1', version: 0, workspaceId: 'ws-1',
    signature: `path_overlap_stall|ws=ws-1|blocker=pr:${PR}`, detectorVersion: 'fps-v2',
    rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress', title: 't', severity: 'high', status: 'open',
    firstSeenAt: at(0), lastSeenAt: at(0), occurrenceCount: 1, recurrenceCount: 0,
    affectedRefs: { taskIds: [SUBJECT], workerIds: [], prNumbers: [PR] }, evidenceRefs: [],
    impact: { stalledTasks: 1 }, lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null,
    acknowledgedAt: null, resolvedAt: null, recovery: null,
    ...over,
  };
}

function memoryPort(initial: StoredIncident, opts: { yieldBetween?: boolean } = {}) {
  let row = structuredClone(initial);
  const tick = () => (opts.yieldBetween ? new Promise<void>(r => setTimeout(r, 1)) : Promise.resolve());
  const port: IncidentStorePort = {
    async find() { return structuredClone(row); },
    async findById(id) { await tick(); return id === row.id ? structuredClone(row) : null; },
    async insert() { return null; },
    async compareAndSwap(id, expected, next) {
      await tick();
      if (id !== row.id || row.version !== expected) return null;
      row = { ...structuredClone(next), id, version: expected + 1 };
      return structuredClone(row);
    },
  };
  return { port, get: () => row };
}

function subject(over: Partial<PathOverlapSubjectFacts> = {}): PathOverlapSubjectFacts {
  return {
    taskId: SUBJECT, status: 'pending', lastWorkerAt: null,
    lastDeferral: { at: at(15), prNumber: PR, blockingTaskId: BLOCKER_TASK, firstDeferredAt: at(0), paths: ['apps/web/src/a.ts'] },
    wokenAt: null, subjectPrNumber: null,
    ...over,
  };
}

function blocker(over: Partial<PathOverlapBlockerFacts> = {}): PathOverlapBlockerFacts {
  return {
    prNumber: PR, taskId: BLOCKER_TASK, createdAt: at(-60), prState: 'open', deliveryState: 'CI_PENDING',
    lastMovedAt: at(10), leasesHeld: 0, unnotifiedWaiters: [], dependsOnSubjects: [], diffPaths: null,
    ...over,
  };
}

function recordingEffects() {
  const calls: Array<{ effect: string; id: string; key: string }> = [];
  const effects: RecoveryEffects = {
    async releaseBlocker(id, _reason, key) { calls.push({ effect: 'release', id, key }); },
    async wakeSubject(id, key) { calls.push({ effect: 'wake', id, key }); },
    async fileFixTask(i, key) { calls.push({ effect: 'fix', id: i.id, key }); return 'fix-1'; },
  };
  return { effects, calls };
}

/** Deps whose facts come from `facts()`, read fresh on every observation. */
function deps(port: IncidentStorePort, facts: () => PathOverlapRecoveryFacts | Error, now: () => string, effects: RecoveryEffects): RecoveryDeps {
  return {
    port, effects, now,
    families: [{
      rule: 'path_overlap_stall',
      async observe() { const f = facts(); if (f instanceof Error) throw f; return { complete: true, facts: f }; },
      evaluate: evaluatePathOverlap,
    }],
  };
}

describe('regression: a stale blocker (blocker merged, task woken once, resolves only on observed progress)', () => {
  it('wakes once, waits while nothing moves, and resolves only when the task starts', async () => {
    const store = memoryPort(incident());
    const { effects, calls } = recordingEffects();
    let now = at(20);
    let facts: PathOverlapRecoveryFacts = { subjects: [subject()], blocker: blocker({ prState: 'merged', deliveryState: 'MERGED' }), fixTask: null };
    const d = deps(store.port, () => facts, () => now, effects);

    // The merge hook: the blocker landed, its leases are already released, the task was never woken.
    const first = await assessIncident(d, 'inc-1', 'merge_hook');
    expect(first.outcome).toBe('repaired');
    expect(calls).toEqual([{ effect: 'wake', id: SUBJECT, key: expect.stringContaining(':wake_subject:g1:a1') }]);
    expect(store.get().status).toBe('open');
    expect(store.get().recovery?.state).toBe('recovering');
    expect(store.get().recovery?.cause.reasonCode).toBe('path_overlap.blocker_merged_unreleased');

    // The wake landed in the outbox but no runner has picked the task up: not resolved, not woken again.
    now = at(23);
    facts = { ...facts, subjects: [subject({ wokenAt: at(20) })] };
    const second = await assessIncident(d, 'inc-1', 'backstop');
    expect(second.outcome).toBe('assessed');
    expect(calls).toHaveLength(1);
    expect(store.get().status).toBe('open');
    expect(store.get().recovery?.state).toBe('waiting');

    // The task started a worker: the check passes on fresh facts.
    now = at(26);
    facts = { ...facts, subjects: [subject({ wokenAt: at(20), lastWorkerAt: at(24), status: 'in_progress' })] };
    await assessIncident(d, 'inc-1', 'backstop');
    expect(store.get().status).toBe('resolved');
    expect(store.get().resolvedAt).toBe(at(26));
    expect(store.get().recovery?.state).toBe('recovered');
    expect(calls).toHaveLength(1);
  });

  it('a merged blocker alone never resolves the incident', async () => {
    const store = memoryPort(incident());
    const { effects } = recordingEffects();
    const d = deps(store.port, () => ({ subjects: [subject({ wokenAt: at(30) })], blocker: blocker({ prState: 'merged' }), fixTask: null }), () => at(40), effects);
    await assessIncident(d, 'inc-1', 'backstop');
    expect(store.get().status).toBe('open');
  });
});

describe('AC-4: a merged blocker whose leases are still held', () => {
  it('calls releaseAndNotify once; a concurrent run of the same generation calls nothing', async () => {
    const store = memoryPort(incident(), { yieldBetween: true });
    const { effects, calls } = recordingEffects();
    const facts = { subjects: [subject()], blocker: blocker({ prState: 'merged', leasesHeld: 2, unnotifiedWaiters: [SUBJECT] }), fixTask: null };
    const d = deps(store.port, () => facts, () => at(30), effects);
    await Promise.all([assessIncident(d, 'inc-1', 'merge_hook'), assessIncident(d, 'inc-1', 'backstop')]);
    expect(calls.filter(c => c.effect === 'release')).toEqual([{ effect: 'release', id: BLOCKER_TASK, key: expect.stringContaining(':release_blocker:g1:a1') }]);
    expect(store.get().recovery?.budget.spent).toBe(1);
  });
});

describe('attempt events (operator-recovery §4.2)', () => {
  it('writes one attempt row per repair, then fills its verify on the re-check that saw progress', async () => {
    const store = memoryPort(incident());
    const { effects } = recordingEffects();
    const attempts: any[] = [];
    const verifies: any[] = [];
    let now = at(20);
    let facts: PathOverlapRecoveryFacts = { subjects: [subject()], blocker: blocker({ prState: 'merged', deliveryState: 'MERGED' }), fixTask: null };
    const d: RecoveryDeps = {
      ...deps(store.port, () => facts, () => now, effects),
      events: { async attempt(e) { attempts.push(e); }, async verify(key, v) { verifies.push({ key, ...v }); } },
    };
    await assessIncident(d, 'inc-1', 'merge_hook');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].detail).toMatchObject({ capability: 'wake_subject', incidentId: 'inc-1', generation: 1, attempt: 1, actor: 'buildd:merge_hook' });
    expect(attempts[0].detail.causeKey).toMatch(/^c1:[0-9a-f]{20}$/);
    expect(store.get().recovery?.causeGroup?.key).toBe(attempts[0].detail.causeKey);

    now = at(26);
    facts = { ...facts, subjects: [subject({ wokenAt: at(20), lastWorkerAt: at(24), status: 'in_progress' })] };
    await assessIncident(d, 'inc-1', 'backstop');
    expect(attempts).toHaveLength(1);
    expect(verifies).toEqual([expect.objectContaining({ key: attempts[0].detail.actionKey, passed: true })]);
  });
});

describe('§5 rule 1 / I-3: re-observe before acting', () => {
  it('drops the repair when the facts moved between the two reads, and writes the fresher assessment', async () => {
    const store = memoryPort(incident());
    const { effects, calls } = recordingEffects();
    let reads = 0;
    const d = deps(store.port, () => {
      reads++;
      return { subjects: [subject({ wokenAt: reads > 1 ? at(29) : null })], blocker: blocker({ prState: 'merged' }), fixTask: null };
    }, () => at(30), effects);
    await assessIncident(d, 'inc-1', 'sweep');
    expect(calls).toHaveLength(0);
    expect(store.get().recovery?.state).toBe('waiting');
  });
});

describe('AC-3: a failed read is inconclusive, never resolved', () => {
  it('keeps the incident open with state inconclusive and a next check', async () => {
    const store = memoryPort(incident());
    const { effects } = recordingEffects();
    const d = deps(store.port, () => new Error('connection reset'), () => at(90), effects);
    await assessIncident(d, 'inc-1', 'backstop');
    expect(store.get().status).toBe('open');
    expect(store.get().recovery?.state).toBe('inconclusive');
    expect(store.get().recovery?.nextCheckAt).toBe(at(95));
    expect(store.get().recovery?.owner).toBe('buildd');
  });

  it('a stale assessment is due', () => {
    const r = { v: 1, state: 'waiting', observation: { observedAt: at(0) }, nextCheckAt: at(500) } as unknown as FailureIncidentRecovery;
    expect(recoveryDue(incident({ recovery: r }), at(30))).toBe(false);
    expect(recoveryDue(incident({ recovery: r }), at(61))).toBe(true);
    expect(recoveryDue(incident({ recovery: null }), at(1))).toBe(true);
    expect(recoveryDue(incident({ status: 'resolved' }), at(1))).toBe(false);
  });
});

describe('§6 policy outcomes', () => {
  it('AC-8: a cycle is a decision straight away', async () => {
    const store = memoryPort(incident());
    const { effects, calls } = recordingEffects();
    const d = deps(store.port, () => ({ subjects: [subject()], blocker: blocker({ dependsOnSubjects: [SUBJECT] }), fixTask: null }), () => at(5), effects);
    await assessIncident(d, 'inc-1', 'sweep');
    const r = store.get().recovery!;
    expect(r.state).toBe('needs_decision');
    expect(r.owner).toBe('person');
    expect(r.cause.reasonCode).toBe('path_overlap.cycle');
    expect(r.decision?.options.map(o => o.capability)).toContain('cancel_attempt');
    expect(calls).toHaveLength(0);
  });

  it('AC-9: an ESCALATED blocker keeps the incident Buildd-owned, pointing at the PR card', async () => {
    const store = memoryPort(incident());
    const { effects } = recordingEffects();
    const d = deps(store.port, () => ({ subjects: [subject()], blocker: blocker({ deliveryState: 'ESCALATED' }), fixTask: null }), () => at(500), effects);
    await assessIncident(d, 'inc-1', 'sweep');
    const r = store.get().recovery!;
    expect(r.owner).toBe('buildd');
    expect(r.nextAction?.kind).toBe('blocked_by_escalation');
    expect(r.nextAction?.key).toBe(`pr:${PR}`);
  });

  it('an open, moving blocker is a wait with a promised next check', async () => {
    const r = planRecovery({
      incident: incident(), now: at(20), source: 'sweep', complete: true, evidenceRevision: 'r',
      outcome: evaluatePathOverlap(incident(), { subjects: [subject()], blocker: blocker(), fixTask: null }, at(20)),
    }).recovery;
    expect(r.state).toBe('waiting');
    expect(r.cause.reasonCode).toBe('path_overlap.blocker_open');
    expect(r.nextCheckAt).toBe(at(25));
    expect(r.nextAction?.label).toBe(`Waiting for PR #${PR} to land.`);
  });

  it('a wait past the 6 h episode deadline becomes a decision', () => {
    const r = planRecovery({
      incident: incident(), now: at(361), source: 'sweep', complete: true, evidenceRevision: 'r',
      outcome: evaluatePathOverlap(incident(), { subjects: [subject()], blocker: blocker({ lastMovedAt: at(1) }), fixTask: null }, at(361)),
    }).recovery;
    expect(r.state).toBe('needs_decision');
    expect(r.decision?.options.length).toBeGreaterThan(0);
  });

  it('I-8: an episode never starts before its blocker existed', () => {
    const o = evaluatePathOverlap(
      incident({ firstSeenAt: at(-1000) }),
      { subjects: [subject({ lastDeferral: { at: at(15), prNumber: 999, blockingTaskId: null, firstDeferredAt: at(-1000), paths: [] } })], blocker: blocker({ createdAt: at(-30) }), fixTask: null },
      at(20),
    );
    expect(o.episodeStartedAt).toBe(at(-30));
  });

  it('subject exempt but deferred: files the one fix task, then waits on it', async () => {
    const store = memoryPort(incident());
    const { effects, calls } = recordingEffects();
    let fixTask: PathOverlapRecoveryFacts['fixTask'] = null;
    const d = deps(store.port, () => ({ subjects: [subject({ subjectPrNumber: PR })], blocker: blocker(), fixTask }), () => at(20), effects);
    await assessIncident(d, 'inc-1', 'sweep');
    expect(calls.map(c => c.effect)).toEqual(['fix']);
    expect(store.get().recovery?.cause).toEqual({ reasonCode: 'path_overlap.subject_exempt_violated', rule: 'path_overlap_stall', ownership: 'infrastructure' });
    fixTask = { id: 'fix-1', running: true };
    await assessIncident(d, 'inc-1', 'sweep');
    expect(store.get().recovery?.state).toBe('recovering');
    expect(store.get().recovery?.nextAction?.kind).toBe('fix_task_running');
    fixTask = { id: 'fix-1', running: false };
    await assessIncident(d, 'inc-1', 'sweep');
    expect(store.get().recovery?.state).toBe('needs_decision');
    expect(calls).toHaveLength(1);
  });

  it('a task deferred behind a different blocker since ends this episode', () => {
    const o = evaluatePathOverlap(incident(), {
      subjects: [subject({ lastDeferral: { at: at(30), prNumber: 5000, blockingTaskId: 'other', firstDeferredAt: at(29), paths: [] } })],
      blocker: blocker(), fixTask: null,
    }, at(31));
    expect(o.verdict.kind).toBe('passed');
  });

  it('a task the read did not find is unknown, never passed', () => {
    const o = evaluatePathOverlap(incident(), { subjects: [subject({ status: null })], blocker: blocker({ prState: 'merged' }), fixTask: null }, at(31));
    expect(o.verdict.kind).toBe('inconclusive');
  });
});

describe('§8 budget, generations and backoff', () => {
  const outcome = (over: Partial<RecoveryPolicyOutcome> = {}): RecoveryPolicyOutcome => ({
    cause: { reasonCode: 'path_overlap.blocker_merged_unreleased', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: SUBJECT }], blockers: [{ kind: 'pr', id: String(PR), state: 'merged', observedAt: at(0) }],
    overlappingPaths: [], episodeStartedAt: at(0), lastProgressAt: null,
    verdict: { kind: 'repair', action: 'release_blocker', subject: { kind: 'task', id: BLOCKER_TASK }, label: 'l', params: { blockerTaskId: BLOCKER_TASK } },
    verification: { predicate: 'p', params: {} },
    fallbackDecision: { question: 'q', options: [{ capability: 'open_blocker', label: 'Open', effect: 'e' }], recommended: 'open_blocker' },
    ...over,
  });

  it('AC-6: at the budget limit no repair runs; it is a decision with options', () => {
    let row = incident();
    let ran = 0;
    for (let i = 0; i < RECOVERY_BUDGET_LIMIT + 1; i++) {
      const plan = planRecovery({ incident: row, outcome: outcome(), evidenceRevision: `r${i}`, now: at(10 + i * 10), source: 'sweep', complete: true });
      if (plan.repair) ran++;
      row = { ...row, recovery: plan.recovery };
    }
    expect(ran).toBe(RECOVERY_BUDGET_LIMIT);
    expect(row.recovery?.state).toBe('needs_decision');
    expect(row.recovery?.decision?.options.length).toBeGreaterThan(0);
    expect(row.recovery?.budget.spent).toBe(RECOVERY_BUDGET_LIMIT);
    expect(row.recovery?.attempts).toHaveLength(RECOVERY_BUDGET_LIMIT);
  });

  it('a change of cause starts a new generation with a fresh budget; the attempts stay', () => {
    const first = planRecovery({ incident: incident(), outcome: outcome(), evidenceRevision: 'r1', now: at(10), source: 'sweep', complete: true });
    expect(first.recovery.generation).toBe(1);
    const second = planRecovery({
      incident: incident({ recovery: first.recovery }), evidenceRevision: 'r2', now: at(20), source: 'sweep', complete: true,
      outcome: outcome({ cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' }, verdict: { kind: 'wait', label: 'w' } }),
    });
    expect(second.recovery.generation).toBe(2);
    expect(second.recovery.budget.spent).toBe(0);
    expect(second.recovery.attempts).toHaveLength(1);
    expect(second.changed).toBe(true);
  });

  it('the same facts give the same revision and no change', () => {
    expect(evidenceRevision({ a: 1, b: [2, 3] })).toBe(evidenceRevision({ b: [2, 3], a: 1 }));
    const wait = outcome({ verdict: { kind: 'wait', label: 'w' } });
    const a = planRecovery({ incident: incident(), outcome: wait, evidenceRevision: 'r', now: at(10), source: 'sweep', complete: true });
    const b = planRecovery({ incident: incident({ recovery: a.recovery }), outcome: wait, evidenceRevision: 'r', now: at(15), source: 'sweep', complete: true });
    expect(b.changed).toBe(false);
  });

  it('backoff grows 5 → 15 → 45 → 120 while the state holds', () => {
    const wait = outcome({ verdict: { kind: 'wait', label: 'w' } });
    let row = incident();
    const gaps: number[] = [];
    let now = at(10);
    for (let i = 0; i < 5; i++) {
      const r = planRecovery({ incident: row, outcome: wait, evidenceRevision: 'r', now, source: 'sweep', complete: true }).recovery;
      gaps.push((Date.parse(r.nextCheckAt!) - Date.parse(now)) / 60_000);
      row = { ...row, recovery: r };
      now = r.nextCheckAt!;
    }
    expect(gaps).toEqual([5, 15, 45, 120, 120]);
    expect(nextBackoffMinutes(null)).toBe(5);
  });

  it('action keys follow the spec shape', () => {
    expect(recoveryActionKey({ incidentId: 'i', subject: { kind: 'task', id: 't' }, causeCode: 'c', action: 'wake_subject', generation: 2, attempt: 1 }))
      .toBe('recovery:i:task:t:c:wake_subject:g2:a1');
  });

  it('an operator-owned gap is not a person decision and keeps being checked', () => {
    const r = planRecovery({
      incident: incident(), evidenceRevision: 'r', now: at(10), source: 'sweep', complete: true,
      outcome: outcome({ verdict: { kind: 'operator', capability: 'repair_infrastructure', reason: 'r', label: 'l' } }),
    }).recovery;
    expect(r.state).toBe('needs_operator');
    expect(r.owner).toBe('operator');
    expect(r.capabilityGap).toEqual({ capability: 'repair_infrastructure', reason: 'r' });
    expect(r.nextCheckAt).not.toBeNull();
    expect(r.decision).toBeUndefined();
  });
});

describe('scope', () => {
  it('skips a resolved incident and one no family owns', async () => {
    const { effects } = recordingEffects();
    const resolved = memoryPort(incident({ status: 'resolved' }));
    expect((await assessIncident(deps(resolved.port, () => new Error('x'), () => at(1), effects), 'inc-1', 'sweep')).outcome).toBe('skipped');
    const other = memoryPort(incident({ rule: 'retry_fork' }));
    expect((await assessIncident(deps(other.port, () => new Error('x'), () => at(1), effects), 'inc-1', 'sweep')).outcome).toBe('skipped');
  });
});
