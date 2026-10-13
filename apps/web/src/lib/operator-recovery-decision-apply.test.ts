/**
 * operator-recovery §4.2, §6.2, §6.5, §6.6: what an answer does. A merge
 * writes `causeGroup.source = 'model'`; a repair runs only through the
 * owner-click validator, inside the allowlist's live rollout; outcomes label
 * from what happened next.
 */
import { describe, expect, it } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { effectiveCauseKey, ruleCauseKey } from './failure-incident-cause-key';
import { buildAutomationState } from './failure-incident-recovery-automation';
import type { RecoveryActionDeps } from './failure-incident-recovery-actions';
import type { RepairFacts } from './failure-incident-repairs';
import type { StoredIncident } from './failure-incident-store';
import {
  ambiguousCausePairs, applyCauseMerge, applyRepairSuggestion, mergeOutcomeLabel, priorityOutcomeLabel, repairOutcomeLabel, repairQuestionFor,
  validRepairCapabilities, type CauseView,
} from './operator-recovery-decision-apply';
import type { OperatorDecisionResult } from './operator-recovery-decisions';

const NOW = '2026-10-13T09:00:00.000Z';
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
const WS_A = '00000000-0000-4000-8000-0000000000a1';
const WS_B = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const DECISION = '00000000-0000-4000-8000-0000000000d1';

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 1, cause: { reasonCode: 'repeated_failure.agent_timeout', rule: 'repeated_failure', ownership: 'infrastructure' },
    subjects: [{ kind: 'task', id: TASK }], blockers: [], overlappingPaths: [],
    observation: { observedAt: NOW, source: 'sweep', evidenceRevision: 'rev-1' },
    firstSeenAt: at(-5), lastSeenAt: NOW, lastProgressAt: null, owner: 'operator', state: 'needs_operator', nextAction: null, nextCheckAt: null,
    verification: { predicate: 'p', params: {} }, budget: { spent: 0, limit: 3, deadlineAt: at(4), spentKeys: [] }, attempts: [],
    ...over,
  };
}

function incident(id: string, over: Partial<StoredIncident> = {}, rec: Partial<FailureIncidentRecovery> = {}): StoredIncident {
  return {
    id, version: 1, workspaceId: WS_A, signature: `repeated_failure|ws=${WS_A}|agent_timeout`, detectorVersion: 'fps-v2',
    rule: 'repeated_failure', reasonCode: 'repeated_failure.agent_timeout', title: 't', severity: 'high', status: 'open',
    firstSeenAt: at(-5), lastSeenAt: NOW, occurrenceCount: 3, recurrenceCount: 0,
    affectedRefs: { taskIds: [TASK], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: recovery(rec),
    ...over,
  };
}

const view = (members: StoredIncident[], team: string | null): CauseView => ({ causeKey: effectiveCauseKey(members[0]).key, members, teamIds: members.map(() => team) });

function memoryPort(rows: StoredIncident[]) {
  const store = new Map(rows.map(r => [r.id, r]));
  return {
    store,
    async findById(id: string) { return store.get(id) ?? null; },
    async compareAndSwap(id: string, version: number, next: StoredIncident) {
      const cur = store.get(id);
      if (!cur || cur.version !== version) return null;
      const out = { ...next, id, version: version + 1 };
      store.set(id, out);
      return out;
    },
  };
}

const result = (answer: string, over: Partial<Extract<OperatorDecisionResult, { source: 'model' }>> = {}): OperatorDecisionResult => ({
  kind: 'buildd.operator_cause_merge', source: 'model', answer, confidence: 0.91, applied: true, decisionId: DECISION, fingerprint: 'orq:x',
  failure: null, rationale: 'r', uncertainty: null, evidenceRefs: [], ...over,
});

// Two platform causes of the same family and error family, split by cause code: the rule key leaves them ambiguous.
const older = incident('00000000-0000-4000-8000-000000000001', { firstSeenAt: at(-9) }, { firstSeenAt: at(-9) });
const younger = incident('00000000-0000-4000-8000-000000000002', { workspaceId: WS_B, signature: `repeated_failure|ws=${WS_B}|agent_timeout`, reasonCode: 'repeated_failure.agent_stalled' },
  { cause: { reasonCode: 'repeated_failure.agent_stalled', rule: 'repeated_failure', ownership: 'infrastructure' } });

describe('when a merge is asked', () => {
  it('a pair the rule key leaves ambiguous is asked; a cross-team workspace pair is not', () => {
    expect(ruleCauseKey(older)).not.toBe(ruleCauseKey(younger));
    expect(ambiguousCausePairs([view([older], 'team-a'), view([younger], 'team-b')])).toHaveLength(1);
    const wsA = incident('00000000-0000-4000-8000-000000000003', { rule: 'path_overlap_stall', signature: `path_overlap_stall|ws=${WS_A}|blocker=pr:7`, reasonCode: 'path_overlap.no_progress' });
    const wsB = incident('00000000-0000-4000-8000-000000000004', { rule: 'path_overlap_stall', workspaceId: WS_B, signature: `path_overlap_stall|ws=${WS_B}|blocker=pr:7`, reasonCode: 'path_overlap.no_progress' });
    expect(ambiguousCausePairs([view([wsA], 'team-a'), view([wsB], 'team-b')])).toHaveLength(0);
  });
});

describe('a merge verdict is applied', () => {
  it('moves the younger cause onto the older one with source model, through the CAS', async () => {
    const port = memoryPort([older, younger]);
    const out = await applyCauseMerge(result('merge'), [view([older], 'team-a'), view([younger], 'team-b')], { port, now: () => NOW });
    expect(out).toEqual({ merged: true, into: ruleCauseKey(older), moved: [younger.id] });
    const moved = port.store.get(younger.id)!;
    expect(moved.recovery?.causeGroup).toMatchObject({ key: ruleCauseKey(older), source: 'model', decisionId: DECISION, confidence: 0.91, ruleKey: ruleCauseKey(younger) });
    // The read model now groups both under one cause.
    expect(effectiveCauseKey(moved)).toMatchObject({ key: ruleCauseKey(older), source: 'model' });
    expect(port.store.get(older.id)!.version).toBe(1);
  });

  it('never overrides an operator regroup, and does nothing for separate, unsure or a fallback', async () => {
    const regrouped: StoredIncident = { ...younger, recovery: { ...younger.recovery!, causeGroup: { key: 'c1:00000000000000000000', source: 'operator', decisionId: 'audit-1', confidence: null, assignedAt: NOW, ruleKey: ruleCauseKey(younger) } } };
    const port = memoryPort([older, regrouped]);
    expect(await applyCauseMerge(result('merge'), [view([older], 'team-a'), view([regrouped], 'team-b')], { port, now: () => NOW })).toMatchObject({ merged: false });
    expect(port.store.get(younger.id)!.recovery?.causeGroup?.source).toBe('operator');
    for (const r of [result('separate'), result('unsure'), result('unsure', { source: 'fallback', applied: false, failure: 'timeout' })]) {
      const p = memoryPort([older, younger]);
      expect((await applyCauseMerge(r, [view([older], 'team-a'), view([younger], 'team-b')], { port: p, now: () => NOW })).merged).toBe(false);
      expect(p.store.get(younger.id)!.version).toBe(1);
    }
  });

  it('refuses a cross-team merge of two workspace causes even if a model said merge', async () => {
    const a = incident('00000000-0000-4000-8000-000000000005', { rule: 'path_overlap_stall', signature: `path_overlap_stall|ws=${WS_A}|blocker=pr:7`, reasonCode: 'path_overlap.no_progress' });
    const b = incident('00000000-0000-4000-8000-000000000006', { rule: 'path_overlap_stall', workspaceId: WS_B, signature: `path_overlap_stall|ws=${WS_B}|blocker=pr:8`, reasonCode: 'path_overlap.no_progress' });
    const port = memoryPort([a, b]);
    expect(await applyCauseMerge(result('merge'), [view([a], 'team-a'), view([b], 'team-b')], { port, now: () => NOW })).toEqual({ merged: false, reason: 'cross_team' });
  });
});

// ── Repair ──

const repairFacts = (over: Partial<RepairFacts> = {}): RepairFacts => ({
  observedAt: NOW,
  incident: { id: older.id, rule: 'repeated_failure', causeCode: 'repeated_failure.agent_timeout', generation: 1, state: 'needs_operator', spentKeys: [], linkedFixTaskId: null },
  blocker: null,
  subjects: [{ taskId: TASK, missionId: null, status: 'pending', lastWorkerAt: null, outbox: { status: 'failed', attemptCount: 8, createdAt: at(-1), deliveredAt: null }, staleWorker: null, infraRetries: 0 }],
  runnerOnline: true, fix: null, captureFailedAfterFix: null, missions: [], kernel: null,
  ...over,
});

function actionDeps(port: ReturnType<typeof memoryPort>) {
  const ran: string[] = [];
  const deps: RecoveryActionDeps = {
    port,
    effects: {
      releaseBlocker: async () => { ran.push('release_blocker'); },
      wakeSubject: async id => { ran.push(`wake_subject:${id}`); },
      fileFixTask: async () => { ran.push('file_fix_task'); return 'fix-1'; },
      redeliverDispatch: async id => { ran.push(`redeliver_dispatch:${id}`); },
    },
    reassess: async id => port.findById(id),
    writeAutomation: async () => null,
    recordPriority: async () => null,
    now: () => NOW,
  };
  return { deps, ran };
}

// The owner switched repeated_failure's automatic repair on (§8.4); by default the family runs in shadow.
const LIVE_POLICY = { key: 'operator-recovery:policy', value: { v: 1, perRule: { repeated_failure: { budgetLimit: 3, backoffMinutes: [5, 15, 45], episodeDeadlineHours: 6, autoRepair: 'on' } }, model: {} }, updatedAt: new Date(NOW), expiresAt: null };
const repairCtx = (lead: StoredIncident, live = true) => ({
  lead, members: [lead], causeKey: ruleCauseKey(lead), automation: buildAutomationState(live ? [LIVE_POLICY] : [], new Date(NOW)), repairFacts: repairFacts(), tier: 1, now: NOW,
});
const repairResult = (answer: string, over: Partial<Extract<OperatorDecisionResult, { source: 'model' }>> = {}) =>
  result(answer, { kind: 'buildd.operator_repair_suggestion', ...over });

describe('a repair suggestion runs only as an owner click would', () => {
  it('is asked only when no runbook owns the stuck cause, and offers only repairs valid now', () => {
    expect(repairQuestionFor(older)).toBe(true);
    expect(repairQuestionFor(incident(older.id, {}, { state: 'recovering' }))).toBe(false);
    expect(repairQuestionFor(incident(older.id, { rule: 'path_overlap_stall' }))).toBe(false);
    expect(validRepairCapabilities(older, repairFacts())).toContain('wake_subject');
    expect(validRepairCapabilities(older, null)).toEqual([]);
  });

  it('an allowlisted, live, valid repair executes through the shared service', async () => {
    const port = memoryPort([older]);
    const { deps, ran } = actionDeps(port);
    const out = await applyRepairSuggestion(repairResult('wake_subject'), repairCtx(older), deps);
    expect(out).toMatchObject({ executed: true, repair: 'wake_subject' });
    expect(ran).toEqual([`wake_subject:${TASK}`]);
    expect(port.store.get(older.id)!.recovery?.budget.spent).toBe(1);
  });

  it('a repair outside AUTO_ELIGIBLE (not rolled out live) is never executed: it stays a suggestion', async () => {
    const port = memoryPort([older]);
    const { deps, ran } = actionDeps(port);
    // redeliver_dispatch rolls out in shadow: the loop only records it, so a model never runs it either.
    const out = await applyRepairSuggestion(repairResult('redeliver_dispatch'), repairCtx(older), deps);
    expect(out).toMatchObject({ executed: false, repair: 'redeliver_dispatch', reason: 'not_supported' });
    expect(ran).toEqual([]);
    expect(port.store.get(older.id)!.version).toBe(1);
    // Nor does a live-rolled repair on a family whose automatic repair is still in shadow.
    expect(await applyRepairSuggestion(repairResult('wake_subject'), repairCtx(older, false), deps)).toMatchObject({ executed: false, reason: 'not_supported' });
    expect(ran).toEqual([]);
  });

  it('an answer that is not a repair, a fallback, or a paused model never executes', async () => {
    const port = memoryPort([older]);
    const { deps, ran } = actionDeps(port);
    expect(await applyRepairSuggestion(repairResult('disable_trigger'), repairCtx(older), deps)).toMatchObject({ executed: false, reason: 'no_repair' });
    expect(await applyRepairSuggestion(repairResult('escalate'), repairCtx(older), deps)).toMatchObject({ executed: false, reason: 'no_repair' });
    expect(await applyRepairSuggestion(repairResult('wake_subject', { source: 'fallback', applied: false, failure: 'timeout' }), repairCtx(older), deps)).toMatchObject({ executed: false, reason: 'not_applied' });
    const paused = { ...repairCtx(older), automation: buildAutomationState([{ key: 'operator-recovery:pause:model', value: { until: at(2) }, updatedAt: new Date(NOW), expiresAt: new Date(at(2)) }], new Date(NOW)) };
    expect(await applyRepairSuggestion(repairResult('wake_subject'), paused, deps)).toMatchObject({ executed: false, reason: 'paused' });
    expect(ran).toEqual([]);
  });
});

describe('outcome labels', () => {
  it('merge: regrouped after it, or accepted after a week untouched', () => {
    expect(mergeOutcomeLabel(NOW, [at(2)], at(3))).toBe('regrouped');
    expect(mergeOutcomeLabel(NOW, [at(-2)], at(3))).toBeNull();
    expect(mergeOutcomeLabel(NOW, [], at(24 * 7))).toBe('accepted');
  });
  it('repair: the attempt’s own verify verdict; the writer returning is never success', () => {
    expect(repairOutcomeLabel({ outcome: 'accepted', verifyPassed: true })).toBe('progressed');
    expect(repairOutcomeLabel({ outcome: 'accepted', verifyPassed: false })).toBe('no_effect');
    expect(repairOutcomeLabel({ outcome: 'accepted', verifyPassed: null })).toBeNull();
    expect(repairOutcomeLabel({ outcome: 'rejected', verifyPassed: null })).toBe('failed');
  });
  it('priority: acted on within 24 h, or not', () => {
    expect(priorityOutcomeLabel(NOW, [at(3)], at(4))).toBe('acted');
    expect(priorityOutcomeLabel(NOW, [at(30)], at(31))).toBe('not_acted');
    expect(priorityOutcomeLabel(NOW, [], at(5))).toBeNull();
  });
});
