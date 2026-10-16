/**
 * The recovery loop's gate before an automatic repair (operator-recovery spec
 * §8.3, §9.1, §9.5): pause and fail-closed, shadow that records once, one
 * repair per shared cause on the lead, the owner's policy, and a platform
 * cause that never asks a customer.
 */
import { describe, it, expect } from 'bun:test';
import type { FailureRecoveryDecision } from '@buildd/shared';
import { assessIncident, readRecovery, type RecoveryDeps, type RecoveryEffects, type RecoveryPolicyOutcome, type RecoveryRepairAction, type RecoveryVerdict } from './failure-incident-recovery';
import { applyPolicyPatch, buildAutomationState, DEFAULT_RECOVERY_POLICY, pauseKey, POLICY_KEY, type AutomationRow } from './failure-incident-recovery-automation';
import type { RecoveryAttemptEvent } from './failure-incident-recovery-events';
import type { IncidentStorePort, StoredIncident } from './failure-incident-store';

const NOW = '2026-10-11T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(NOW) + min * 60_000).toISOString();
const TASK_A = '00000000-0000-4000-8000-0000000000a1';
const TASK_B = '00000000-0000-4000-8000-0000000000b1';

function incident(over: Partial<StoredIncident> = {}): StoredIncident {
  return {
    id: 'inc-a', version: 0, workspaceId: 'ws-a',
    signature: 'infrastructure_failure|ws=ws-a|component=visual_qa.scrub|sig=immutable', detectorVersion: 'fps-v2',
    rule: 'infrastructure_failure', reasonCode: 'infrastructure_failure.visual_qa.scrub', title: 't', severity: 'high', status: 'open',
    firstSeenAt: at(-60), lastSeenAt: at(-1), occurrenceCount: 1, recurrenceCount: 0,
    affectedRefs: { taskIds: [TASK_A], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null, recovery: null,
    ...over,
  };
}

function port(initial: StoredIncident) {
  let row = structuredClone(initial);
  const p: IncidentStorePort = {
    async find() { return structuredClone(row); },
    async findById(id) { return id === row.id ? structuredClone(row) : null; },
    async insert() { return null; },
    async compareAndSwap(id, expected, next) {
      if (id !== row.id || row.version !== expected) return null;
      row = { ...structuredClone(next), id, version: expected + 1 };
      return structuredClone(row);
    },
  };
  return { port: p, get: () => row };
}

const decision: FailureRecoveryDecision = { question: 'Pick one?', options: [{ capability: 'dismiss', label: 'Dismiss', effect: 'e' }], recommended: 'dismiss' };

function outcomeFor(i: StoredIncident, verdict: RecoveryVerdict): RecoveryPolicyOutcome {
  return {
    cause: { reasonCode: i.reasonCode, rule: i.rule, ownership: 'infrastructure' },
    subjects: i.affectedRefs.taskIds.map(id => ({ kind: 'task' as const, id })),
    blockers: [], overlappingPaths: [], episodeStartedAt: at(-30), lastProgressAt: null,
    verdict, verification: { predicate: 'p', params: {} }, fallbackDecision: decision,
  };
}

const repairVerdict = (action: RecoveryRepairAction, subject = TASK_A): RecoveryVerdict =>
  ({ kind: 'repair', action, subject: { kind: 'task', id: subject }, label: `run ${action}`, params: { taskIds: [subject] } });

function setup(i: StoredIncident, verdict: RecoveryVerdict, extra: Partial<RecoveryDeps> = {}) {
  const store = port(i);
  const calls: Array<{ effect: string; arg: unknown }> = [];
  const events: RecoveryAttemptEvent[] = [];
  const effects: RecoveryEffects = {
    async releaseBlocker(id) { calls.push({ effect: 'release', arg: id }); },
    async wakeSubject(id) { calls.push({ effect: 'wake', arg: id }); },
    async fileFixTask(inc) { calls.push({ effect: 'fix', arg: inc.id }); return 'fix-1'; },
    async retryCapture(ids) { calls.push({ effect: 'retry_capture', arg: ids }); return ids; },
    async redeliverDispatch(id) { calls.push({ effect: 'redeliver', arg: id }); },
    async linkFixTask(id, taskId) { calls.push({ effect: 'link', arg: `${id}->${taskId}` }); },
  };
  const deps: RecoveryDeps = {
    port: store.port, effects, now: () => NOW,
    families: [{ rule: i.rule, async observe() { return { complete: true, facts: {} }; }, evaluate: inc => outcomeFor(inc, verdict) }],
    events: { async attempt(e) { events.push(e); }, async verify() {} },
    ...extra,
  };
  return { store, calls, events, deps };
}

const rows = (...r: AutomationRow[]) => async () => buildAutomationState(r, new Date(NOW));
const pauseRow = (key: string): AutomationRow => ({ key, value: { until: at(600) }, updatedAt: new Date(NOW), expiresAt: new Date(at(600)) });

describe('pause (§8.3, F-13)', () => {
  it('a paused platform runs no repair: waiting with nextAction paused, nothing spent; assessment continues', async () => {
    const { store, calls, deps } = setup(incident(), repairVerdict('file_fix_task'), { automation: rows(pauseRow(pauseKey({ kind: 'platform' }))) });
    const r = await assessIncident(deps, 'inc-a', 'sweep');
    expect(r.outcome).toBe('assessed');
    expect(calls).toEqual([]);
    const rec = readRecovery(store.get())!;
    expect(rec.state).toBe('waiting');
    expect(rec.nextAction?.kind).toBe('paused');
    expect(rec.budget.spent).toBe(0);
    expect(rec.observation.observedAt).toBe(NOW);
  });

  it('an unreadable switch is paused (fail closed)', async () => {
    const { store, calls, deps } = setup(incident(), repairVerdict('file_fix_task'), { automation: async () => { throw new Error('db down'); } });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls).toEqual([]);
    expect(readRecovery(store.get())!.nextAction?.kind).toBe('paused');
  });

  it('a pause of another rule does not hold this one', async () => {
    const { calls, deps } = setup(incident(), repairVerdict('file_fix_task'), { automation: rows(pauseRow(pauseKey({ kind: 'rule', rule: 'path_overlap_stall' }))) });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls.map(c => c.effect)).toEqual(['fix']);
  });
});

describe('shadow (§9.5, F-3)', () => {
  it('a new repair records what it would run, once, and executes nothing', async () => {
    const i = incident({ rule: 'repeated_failure', signature: 'repeated_failure|ws=ws-a|dispatch_delivery', reasonCode: 'repeated_failure.dispatch' });
    const { store, calls, events, deps } = setup(i, repairVerdict('redeliver_dispatch'), { automation: rows() });
    await assessIncident(deps, 'inc-a', 'sweep');
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'deferred', detail: { capability: 'redeliver_dispatch', verify: { passed: null } } });
    expect(readRecovery(store.get())!.nextAction?.kind).toBe('shadow');
    expect(readRecovery(store.get())!.budget.spent).toBe(0);
  });

  it('once promoted by set_policy, it runs', async () => {
    const i = incident({ rule: 'repeated_failure', signature: 'repeated_failure|ws=ws-a|dispatch_delivery', reasonCode: 'repeated_failure.dispatch' });
    const p = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, { rule: 'repeated_failure', autoRepair: 'on', repair: { kind: 'redeliver_dispatch', mode: 'on' } });
    const { calls, deps } = setup(i, repairVerdict('redeliver_dispatch'), { automation: rows({ key: POLICY_KEY, value: p.ok ? p.policy : null, updatedAt: new Date(NOW), expiresAt: null }) });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls.map(c => c.effect)).toEqual(['redeliver']);
  });
});

describe('one repair per shared cause (§9.1, F-1)', () => {
  const lead = incident({ id: 'inc-a', severity: 'high', firstSeenAt: at(-120) });
  const member = incident({ id: 'inc-b', workspaceId: 'ws-b', severity: 'medium', signature: 'infrastructure_failure|ws=ws-b|component=visual_qa.scrub|sig=immutable', affectedRefs: { taskIds: [TASK_B], workerIds: [], prNumbers: [] } });

  it('a member holds with shared_repair, spends nothing, and follows the lead\'s fix', async () => {
    const leadWithFix = { ...lead, linkedFixTaskId: 'fix-1' };
    const { store, calls, deps } = setup(member, repairVerdict('file_fix_task', TASK_B), { causePeers: async () => [leadWithFix] });
    await assessIncident(deps, 'inc-b', 'sweep');
    const rec = readRecovery(store.get())!;
    expect(rec.nextAction?.kind).toBe('shared_repair');
    expect(rec.budget.spent).toBe(0);
    expect(calls).toEqual([{ effect: 'link', arg: 'inc-b->fix-1' }]);
  });

  it('the lead files the one fix and links every member to it', async () => {
    const { calls, events, deps } = setup(lead, repairVerdict('file_fix_task'), { causePeers: async () => [member] });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls).toEqual([{ effect: 'fix', arg: 'inc-a' }, { effect: 'link', arg: 'inc-b->fix-1' }]);
    expect(events[0].detail.members?.incidentIds).toEqual(['inc-a', 'inc-b']);
  });

  it("the lead's capture retry covers every member's audits", async () => {
    const { calls, deps } = setup(lead, repairVerdict('retry_capture'), { causePeers: async () => [member] });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(calls).toEqual([{ effect: 'retry_capture', arg: [TASK_A, TASK_B] }]);
  });
});

describe('policy (§8.4) and platform causes (§8.5)', () => {
  it("a new budget takes the owner's limit", async () => {
    const p = applyPolicyPatch(DEFAULT_RECOVERY_POLICY, { rule: 'infrastructure_failure', budgetLimit: 5 });
    const { store, deps } = setup(incident(), repairVerdict('file_fix_task'), { automation: rows({ key: POLICY_KEY, value: p.ok ? p.policy : null, updatedAt: new Date(NOW), expiresAt: null }) });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(readRecovery(store.get())!.budget.limit).toBe(5);
  });

  it('a decision on a platform cause goes to the operator, never the customer', async () => {
    const { store, deps } = setup(incident(), { kind: 'decide', decision });
    await assessIncident(deps, 'inc-a', 'sweep');
    const rec = readRecovery(store.get())!;
    expect(rec.state).toBe('needs_operator');
    expect(rec.owner).toBe('operator');
    expect(rec.capabilityGap?.capability).toBe('platform_decision');
    expect(rec.decision).toBeUndefined();
  });

  it('a workspace cause still asks its person', async () => {
    const ws = incident({ rule: 'path_overlap_stall', signature: 'path_overlap_stall|ws=ws-a|blocker=pr:7', reasonCode: 'path_overlap.cycle' });
    const { store, deps } = setup(ws, { kind: 'decide', decision });
    await assessIncident(deps, 'inc-a', 'sweep');
    expect(readRecovery(store.get())!.state).toBe('needs_decision');
  });
});
