/**
 * The repair allowlist (operator-recovery spec §9.2–§9.4): preconditions on
 * fresh facts, verify predicates that never count a writer's return as
 * success, the approved runbooks and the lead of a shared cause.
 */
import { describe, it, expect } from 'bun:test';
import { MAX_INFRA_RETRIES as STALE_WORKERS_MAX_INFRA_RETRIES } from './stale-workers';
import { REPAIR_KINDS } from './failure-incident-recovery-events';
import {
  checkRepair, leadIncidentOf, MAX_INFRA_RETRIES, REPAIRS, repairTarget, RUNBOOKS, runbookFor, verifyRepair, type RepairFacts,
} from './failure-incident-repairs';

const T = '2026-10-11T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();
const TASK = '00000000-0000-4000-8000-0000000000a1';

function facts(over: Partial<RepairFacts> = {}): RepairFacts {
  return {
    observedAt: T,
    incident: { id: 'inc', rule: 'path_overlap_stall', causeCode: 'path_overlap.no_progress', generation: 1, state: 'waiting', spentKeys: [], linkedFixTaskId: null },
    blocker: { taskId: 'blk', state: 'merged', activeClaims: 2 },
    subjects: [{ taskId: TASK, missionId: null, status: 'pending', lastWorkerAt: null, outbox: null, staleWorker: null, infraRetries: 0 }],
    runnerOnline: true,
    fix: null,
    captureFailedAfterFix: null,
    missions: [],
    kernel: null,
    ...over,
  };
}

describe('the allowlist is closed and complete', () => {
  it('one spec per RepairKind, none that touches a trigger, SQL or auth', () => {
    expect(Object.keys(REPAIRS).sort()).toEqual([...REPAIR_KINDS].sort());
    for (const k of REPAIR_KINDS) expect(REPAIRS[k].writer).not.toMatch(/trigger|sql|shell|auth/i);
  });
  it('MAX_INFRA_RETRIES matches the stale-worker policy', () => {
    expect(MAX_INFRA_RETRIES).toBe(STALE_WORKERS_MAX_INFRA_RETRIES);
  });
});

describe('preconditions on fresh facts', () => {
  it('release_blocker: only a landed blocker that still holds claims', () => {
    expect(checkRepair('release_blocker', facts())).toBeNull();
    expect(checkRepair('release_blocker', facts({ blocker: { taskId: 'blk', state: 'open', activeClaims: 2 } }))).toMatch(/still open/);
    expect(checkRepair('release_blocker', facts({ blocker: null }))).toMatch(/No blocking task/);
  });
  it('wake_subject: pending, not woken this generation, nothing blocking', () => {
    expect(checkRepair('wake_subject', facts())).toBeNull();
    expect(checkRepair('wake_subject', facts({ incident: { ...facts().incident, spentKeys: [`recovery:inc:task:${TASK}:x:wake_subject:g1:a1`] } }))).toMatch(/already woken/);
    expect(checkRepair('wake_subject', facts({ blocker: { taskId: 'b', state: 'open', activeClaims: 1 } }))).toMatch(/still blocked/);
  });
  it('redeliver_dispatch: exhausted delivery, a runner online; unknown runner is never a pass', () => {
    const f = (outbox: RepairFacts['subjects'][0]['outbox'], runnerOnline: boolean | null) =>
      facts({ incident: { ...facts().incident, rule: 'repeated_failure' }, blocker: null, runnerOnline, subjects: [{ ...facts().subjects[0], outbox }] });
    const exhausted = { status: 'failed', attemptCount: 8, createdAt: at(-60), deliveredAt: null };
    expect(checkRepair('redeliver_dispatch', f(exhausted, true))).toBeNull();
    expect(checkRepair('redeliver_dispatch', f({ ...exhausted, attemptCount: 3 }, true))).toMatch(/not exhausted/);
    expect(checkRepair('redeliver_dispatch', f(exhausted, null))).toMatch(/couldn't confirm/);
    expect(checkRepair('redeliver_dispatch', f(exhausted, false))).toMatch(/No runner/);
  });
  it('retry_stale_worker: a stalled worker under the infra retry budget', () => {
    const base = facts({ incident: { ...facts().incident, rule: 'stranded_gate' } });
    const stale = { workerId: 'w', accountId: 'acct', updatedAt: at(-30) };
    expect(checkRepair('retry_stale_worker', { ...base, subjects: [{ ...base.subjects[0], staleWorker: stale }] })).toBeNull();
    expect(checkRepair('retry_stale_worker', { ...base, subjects: [{ ...base.subjects[0], staleWorker: stale, infraRetries: 3 }] })).toMatch(/infrastructure retries/);
  });
  it('rerun_visual_audit: fix merged, capture clean since, a mission waiting', () => {
    const base = facts({ incident: { ...facts().incident, rule: 'infrastructure_failure' }, missions: [{ missionId: 'm1', audit: null }] });
    expect(checkRepair('rerun_visual_audit', base)).toMatch(/No fix/);
    expect(checkRepair('rerun_visual_audit', { ...base, fix: { taskId: 'f', status: 'completed', prMerged: false } })).toMatch(/hasn't merged/);
    expect(checkRepair('rerun_visual_audit', { ...base, fix: { taskId: 'f', status: 'completed', prMerged: true }, captureFailedAfterFix: true })).toMatch(/failed again/);
    expect(checkRepair('rerun_visual_audit', { ...base, fix: { taskId: 'f', status: 'completed', prMerged: true }, captureFailedAfterFix: false })).toBeNull();
  });
  it('queue_fix: refused while a fix is live; a failed fix can be replaced', () => {
    expect(checkRepair('queue_fix', facts())).toBeNull();
    expect(checkRepair('queue_fix', facts({ fix: { taskId: 'f0000000', status: 'in_progress', prMerged: null } }))).toMatch(/already in_progress/);
    expect(checkRepair('queue_fix', facts({ fix: { taskId: 'f0000000', status: 'failed', prMerged: null } }))).toBeNull();
  });
  it('a repair for another family does not apply', () => {
    expect(checkRepair('rerun_visual_audit', facts())).toMatch(/does not apply/);
  });
});

describe('verify (§9.4): no phantom success', () => {
  it('in its window and not yet passed is not a verdict; after it, no_effect', () => {
    const attemptAt = at(-5);
    expect(verifyRepair('wake_subject', facts(), attemptAt, false)).toBeNull();
    expect(verifyRepair('wake_subject', facts({ observedAt: at(20) }), attemptAt, false)).toBe(false);
  });
  it('passes only on progress observed after the attempt', () => {
    const attemptAt = at(-5);
    const progressed = facts({ subjects: [{ ...facts().subjects[0], lastWorkerAt: at(-1) }] });
    expect(verifyRepair('wake_subject', progressed, attemptAt, false)).toBe(true);
    const before = facts({ observedAt: at(30), subjects: [{ ...facts().subjects[0], lastWorkerAt: at(-10) }] });
    expect(verifyRepair('wake_subject', before, attemptAt, false)).toBe(false);
  });
  it("the family's own passing check passes it", () => {
    expect(verifyRepair('release_blocker', facts(), at(-1), true)).toBe(true);
  });
  it('a rerun passes only when every mission captured after it', () => {
    const attemptAt = at(-200);
    const m = (lastWorkerAt: string | null, captureFailedAt: string | null) => ({ missionId: 'm', audit: { taskId: 't', status: 'in_progress', lastWorkerAt, captureFailedAt } });
    expect(verifyRepair('rerun_visual_audit', facts({ missions: [m(at(-100), null), m(at(-90), null)] }), attemptAt, false)).toBe(true);
    expect(verifyRepair('rerun_visual_audit', facts({ missions: [m(at(-100), null), m(at(-90), at(-80))] }), attemptAt, false)).toBe(false);
  });
});

describe('targets', () => {
  it('release_blocker takes the blocker task and why it is released', () => {
    expect(repairTarget('release_blocker', facts()).params).toEqual({ blockerTaskId: 'blk', reason: 'merged' });
  });
  it('rerun_visual_audit names every mission and its blocked audit', () => {
    const f = facts({ missions: [{ missionId: 'm1', audit: { taskId: 'a1', status: 'failed', lastWorkerAt: null, captureFailedAt: null } }, { missionId: 'm2', audit: null }] });
    expect(repairTarget('rerun_visual_audit', f)).toEqual({ subject: { kind: 'mission', id: 'm1' }, params: { missionIds: ['m1', 'm2'], taskIds: ['a1'] } });
  });
});

describe('runbooks (§9.3)', () => {
  it('dispatch.delivery_exhausted: once per generation, only with a runner online', () => {
    const rb = RUNBOOKS['dispatch.delivery_exhausted'];
    expect(rb({ outboxExhausted: true, taskPending: true, runnerOnline: true, redeliveredThisGeneration: false })).toBe('redeliver_dispatch');
    expect(rb({ outboxExhausted: true, taskPending: true, runnerOnline: null, redeliveredThisGeneration: false })).toBe('wait');
    expect(rb({ outboxExhausted: true, taskPending: true, runnerOnline: true, redeliveredThisGeneration: true })).toBe('escalate');
    expect(rb({ outboxExhausted: false, taskPending: true, runnerOnline: true, redeliveredThisGeneration: false })).toBe('wait');
  });
  it('qa.scrub_immutable_violation: one fix, then one rerun after the merge; never anything else', () => {
    const rb = RUNBOOKS['qa.scrub_immutable_violation'];
    expect(rb({ fix: null, captureFailedAfterFix: null, missionsWaiting: 3, rerunThisGeneration: false })).toBe('queue_fix');
    expect(rb({ fix: { status: 'in_progress', prMerged: false }, captureFailedAfterFix: null, missionsWaiting: 3, rerunThisGeneration: false })).toBe('wait');
    expect(rb({ fix: { status: 'completed', prMerged: true }, captureFailedAfterFix: false, missionsWaiting: 3, rerunThisGeneration: false })).toBe('rerun_visual_audit');
    expect(rb({ fix: { status: 'completed', prMerged: true }, captureFailedAfterFix: false, missionsWaiting: 3, rerunThisGeneration: true })).toBe('wait');
    expect(rb({ fix: { status: 'completed', prMerged: true }, captureFailedAfterFix: true, missionsWaiting: 3, rerunThisGeneration: false })).toBe('escalate');
    expect(rb({ fix: { status: 'failed', prMerged: null }, captureFailedAfterFix: null, missionsWaiting: 1, rerunThisGeneration: false })).toBe('queue_fix');
  });
  it('runbookFor picks by family and cause code, never by raw text alone', () => {
    expect(runbookFor({ rule: 'infrastructure_failure', reasonCode: 'infrastructure_failure.visual_qa.scrub', signature: 'infrastructure_failure|ws=w|component=visual_qa.scrub|sig=immutable_x' })).toBe('qa.scrub_immutable_violation');
    expect(runbookFor({ rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress', signature: 'path_overlap_stall|ws=w|blocker=pr:1' })).toBeNull();
  });
});

describe('the lead of a shared cause (§9.1)', () => {
  const i = (id: string, severity: 'low' | 'medium' | 'high' | 'critical', firstSeenAt: string, status: 'open' | 'resolved' = 'open') => ({ id, severity, firstSeenAt, status });
  it('highest severity, then oldest, then id; resolved members never lead while one is open', () => {
    expect(leadIncidentOf([i('b', 'medium', at(-10)), i('a', 'high', at(0))])!.id).toBe('a');
    expect(leadIncidentOf([i('b', 'high', at(-10)), i('a', 'high', at(0))])!.id).toBe('b');
    expect(leadIncidentOf([i('b', 'high', at(0)), i('a', 'high', at(0))])!.id).toBe('a');
    expect(leadIncidentOf([i('a', 'critical', at(-60), 'resolved'), i('b', 'low', at(0))])!.id).toBe('b');
  });
});
