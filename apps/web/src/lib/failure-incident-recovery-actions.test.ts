/**
 * The shared validator and the closed request (operator-recovery spec §7.2,
 * §8.1, §8.2, §5.6): every principal gets the same answer on the same facts.
 */
import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { buildAutomationState, pauseKey } from './failure-incident-recovery-automation';
import {
  availableActions, causeEvidenceRevisionOf, causeRevisionOf, parseAdminRecoveryAction, priorityLimit, validateRecoveryAction,
  type AdminRecoveryActionRequest, type RecoveryFresh, type RecoveryPrincipal,
} from './failure-incident-recovery-actions';
import type { RepairFacts } from './failure-incident-repairs';
import type { StoredIncident } from './failure-incident-store';

const NOW = '2026-10-11T12:00:00.000Z';
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
const INC = '00000000-0000-4000-8000-000000000101';
const INC2 = '00000000-0000-4000-8000-000000000102';
const TASK = '00000000-0000-4000-8000-0000000000a1';
const CAUSE = 'c1:0123456789abcdef0123';
const owner: RecoveryPrincipal = { kind: 'platform_admin', accountId: 'acct-owner', operatorLabel: 'octo-owner' };

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 2,
    cause: { reasonCode: 'path_overlap.no_progress', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: TASK }], blockers: [{ kind: 'task', id: 'blk', state: 'merged', observedAt: NOW }], overlappingPaths: [],
    observation: { observedAt: NOW, source: 'click', evidenceRevision: 'ev-1' },
    firstSeenAt: at(-2), lastSeenAt: NOW, lastProgressAt: null, owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting.', key: 'k' }, nextCheckAt: at(1),
    verification: { predicate: 'p', params: {} },
    budget: { spent: 0, limit: 3, deadlineAt: at(4), spentKeys: [] }, attempts: [],
    causeGroup: { key: CAUSE, source: 'rule', decisionId: null, confidence: null, assignedAt: NOW },
    ...over,
  };
}

function incident(over: Partial<StoredIncident> = {}): StoredIncident {
  return {
    id: INC, version: 4, workspaceId: 'ws-a', signature: 'path_overlap_stall|ws=ws-a|blocker=pr:7', detectorVersion: 'fps-v2',
    rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress', title: 't', severity: 'high', status: 'open',
    firstSeenAt: at(-3), lastSeenAt: NOW, occurrenceCount: 1, recurrenceCount: 0,
    affectedRefs: { taskIds: [TASK], workerIds: [], prNumbers: [7] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: recovery(),
    ...over,
  };
}

const repairFacts = (over: Partial<RepairFacts> = {}): RepairFacts => ({
  observedAt: NOW,
  incident: { id: INC, rule: 'path_overlap_stall', causeCode: 'path_overlap.no_progress', generation: 2, state: 'waiting', spentKeys: [], linkedFixTaskId: null },
  blocker: { taskId: 'blk', state: 'merged', activeClaims: 2 },
  subjects: [{ taskId: TASK, missionId: null, status: 'pending', lastWorkerAt: null, outbox: null, staleWorker: null, infraRetries: 0 }],
  runnerOnline: true, fix: null, captureFailedAfterFix: null, missions: [], kernel: null,
  ...over,
});

function fresh(over: Partial<RecoveryFresh> = {}): RecoveryFresh {
  const i = over.incident ?? incident();
  return { now: NOW, incident: i, members: [i], causeKey: CAUSE, automation: buildAutomationState([], new Date(NOW)), repairFacts: repairFacts(), tier: 2, teamOf: () => 'team-a', ...over };
}

function req(body: Record<string, unknown>): AdminRecoveryActionRequest {
  const p = parseAdminRecoveryAction({ reason: 'owner looked at it', evidenceRevision: 'ev-1', target: { incidentId: INC, generation: 2 }, ...body });
  if (!p.ok) throw new Error(p.error);
  return p.request;
}

describe('parse: closed capability set, closed params, required reason (400s)', () => {
  const base = { reason: 'because', evidenceRevision: 'ev-1', target: { incidentId: INC, generation: 2 } };
  const err = (body: unknown) => { const p = parseAdminRecoveryAction(body); expect(p.ok).toBe(false); return p.ok ? '' : p.error; };
  it('refuses an unknown capability, an unknown param and an unknown field', () => {
    expect(err({ ...base, capability: 'disable_trigger' })).toMatch(/capability must be one of/);
    expect(err({ ...base, capability: 'run_repair', params: { repair: 'wake_subject', sql: 'drop table' } })).toMatch(/unknown param "sql"/);
    expect(err({ ...base, capability: 'run_repair', params: { repair: 'disable_trigger' } })).toMatch(/params.repair/);
    expect(err({ ...base, capability: 'retry_recovery', force: true })).toMatch(/unknown field "force"/);
  });
  it('requires a reason of 3 to 500 characters', () => {
    expect(err({ ...base, reason: 'no', capability: 'retry_recovery' })).toMatch(/reason/);
    expect(err({ ...base, reason: 'x'.repeat(501), capability: 'retry_recovery' })).toMatch(/reason/);
  });
  it('the target must match the capability', () => {
    expect(err({ ...base, capability: 'queue_fix' })).toMatch(/targets a cause/);
    expect(err({ ...base, target: { causeKey: CAUSE, revision: 'r' }, capability: 'run_repair', params: { repair: 'wake_subject' } })).toMatch(/targets an incident/);
    expect(err({ ...base, target: { automation: true }, capability: 'pause_automation', params: { scope: 'cause', until: at(1) } })).toMatch(/scope cause/);
  });
  it('a good request parses', () => {
    const p = parseAdminRecoveryAction({ ...base, capability: 'run_repair', params: { repair: 'release_blocker', overridePause: true } });
    expect(p.ok && p.request.params).toEqual({ capability: 'run_repair', repair: 'release_blocker', overridePause: true });
  });
});

describe('validateRecoveryAction: ok or exactly one of stale, precondition, budget, paused, not_supported', () => {
  it('ok on matching facts', () => {
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh())).toEqual({ result: 'ok' });
  });
  it('stale on a moved generation or changed evidence', () => {
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' }, target: { incidentId: INC, generation: 1 } }), fresh()).result).toBe('stale');
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' }, evidenceRevision: 'ev-0' }), fresh()).result).toBe('stale');
  });
  it('stale on a cause whose members changed', () => {
    const r = req({ capability: 'set_priority', params: { mode: 'pin_top', until: at(2) }, target: { causeKey: CAUSE, revision: 'old' }, evidenceRevision: causeEvidenceRevisionOf([incident()]) });
    expect(validateRecoveryAction(owner, r, fresh()).result).toBe('stale');
    const ok = req({ capability: 'set_priority', params: { mode: 'pin_top', until: at(2) }, target: { causeKey: CAUSE, revision: causeRevisionOf([incident()]) }, evidenceRevision: causeEvidenceRevisionOf([incident()]) });
    expect(validateRecoveryAction(owner, ok, fresh()).result).toBe('ok');
  });
  it('precondition on the fresh facts', () => {
    const v = validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh({ repairFacts: repairFacts({ blocker: { taskId: 'blk', state: 'open', activeClaims: 2 } }) }));
    expect(v).toMatchObject({ result: 'precondition' });
  });
  it('budget when the generation spent its repairs (F-5: the 4th is refused)', () => {
    const spent = incident({ recovery: recovery({ budget: { spent: 3, limit: 3, deadlineAt: at(4), spentKeys: ['a', 'b', 'c'] } }) });
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh({ incident: spent, members: [spent] })).result).toBe('budget');
  });
  it('paused unless the owner overrides; a model never overrides (F-13)', () => {
    const paused = buildAutomationState([{ key: pauseKey({ kind: 'platform' }), value: {}, updatedAt: new Date(NOW), expiresAt: new Date(at(5)) }], new Date(NOW));
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh({ automation: paused })).result).toBe('paused');
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker', overridePause: true } }), fresh({ automation: paused })).result).toBe('ok');
    const unreadable = buildAutomationState(null, new Date(NOW));
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh({ automation: unreadable })).result).toBe('paused');
  });
  it('not_supported: a team admin on an owner capability, a model in shadow, a link-only decision option', () => {
    const team: RecoveryPrincipal = { kind: 'team', accountId: 'a', userId: null };
    expect(validateRecoveryAction(team, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh()).result).toBe('not_supported');
    const model: RecoveryPrincipal = { kind: 'model', decisionId: 'd', promoted: false };
    expect(validateRecoveryAction(model, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh()).result).toBe('not_supported');
    const deciding = incident({ recovery: recovery({ state: 'needs_decision', decision: { question: 'q', recommended: 'dismiss', options: [{ capability: 'cancel_attempt', label: 'c', effect: 'e' }, { capability: 'dismiss', label: 'd', effect: 'e' }] } }) });
    expect(validateRecoveryAction(owner, req({ capability: 'decide', params: { option: 'cancel_attempt' } }), fresh({ incident: deciding, members: [deciding] })).result).toBe('not_supported');
    expect(validateRecoveryAction(owner, req({ capability: 'decide', params: { option: 'dismiss' } }), fresh({ incident: deciding, members: [deciding] })).result).toBe('ok');
  });
  it('a shared repair runs on the lead only', () => {
    const lead = incident({ id: INC2, severity: 'critical' });
    expect(validateRecoveryAction(owner, req({ capability: 'run_repair', params: { repair: 'release_blocker' } }), fresh({ members: [incident(), lead] }))).toMatchObject({ result: 'precondition' });
  });
  it('retry_recovery: at most 2 extensions per generation', () => {
    const stuck = incident({ recovery: recovery({ state: 'needs_decision', budget: { spent: 3, limit: 5, deadlineAt: at(4), spentKeys: [], extended: 2 } }) });
    expect(validateRecoveryAction(owner, req({ capability: 'retry_recovery', params: { extendBudgetBy: 1 } }), fresh({ incident: stuck, members: [stuck] })).result).toBe('budget');
    expect(validateRecoveryAction(owner, req({ capability: 'retry_recovery' }), fresh({ incident: stuck, members: [stuck] })).result).toBe('ok');
  });
  it('regroup never merges two workspace causes from different teams', () => {
    const other = incident({ id: INC2, workspaceId: 'ws-b' });
    const r = req({ capability: 'regroup', params: { mergeInto: 'c1:ffffffffffffffffffff' }, target: { causeKey: CAUSE, revision: causeRevisionOf([incident()]) }, evidenceRevision: causeEvidenceRevisionOf([incident()]) });
    expect(validateRecoveryAction(owner, r, fresh({ mergeMembers: [other], teamOf: ws => (ws === 'ws-a' ? 'team-a' : 'team-b') })).result).toBe('precondition');
    expect(validateRecoveryAction(owner, r, fresh({ mergeMembers: [other], teamOf: () => 'team-a' })).result).toBe('ok');
  });
});

describe('set_priority limits (§5.6, F-12)', () => {
  const now = Date.parse(NOW);
  it('a 48 h snooze of a tier-0 cause is refused; 12 h applies; pin_top is not limited to 24 h', () => {
    expect(priorityLimit('snooze', at(48), 0, now)).toMatch(/24 hours/);
    expect(priorityLimit('snooze', at(12), 0, now)).toBeNull();
    expect(priorityLimit('pin_top', at(48), 0, now)).toBeNull();
  });
  it('nothing lasts past 7 days or starts in the past', () => {
    expect(priorityLimit('demote', at(24 * 7 + 1), 2, now)).toMatch(/7 days/);
    expect(priorityLimit('demote', at(-1), 2, now)).toMatch(/future/);
  });
});

describe('availableActions: only what is valid now (§8.1)', () => {
  it('a waiting path-overlap cause offers its repairs on the lead, no retry, a pause', () => {
    const acts = availableActions({ causeKey: CAUSE, members: [incident()], tier: 2, automation: null });
    const caps = acts.map(a => a.capability);
    expect(caps).not.toContain('retry_recovery');
    expect(caps).toContain('pause_automation');
    expect(acts.filter(a => a.capability === 'run_repair').map(a => a.params?.repair).sort()).toEqual(['release_blocker', 'wake_subject']);
    expect(caps).not.toContain('queue_fix'); // workspace cause, not a platform defect
  });
  it('an exhausted decision offers retry, one extension and the posted options only', () => {
    const stuck = incident({ recovery: recovery({ state: 'needs_decision', budget: { spent: 3, limit: 3, deadlineAt: at(4), spentKeys: [] }, decision: { question: 'q', recommended: 'dismiss', options: [{ capability: 'cancel_attempt', label: 'c', effect: 'e' }, { capability: 'dismiss', label: 'd', effect: 'e' }] } }) });
    const acts = availableActions({ causeKey: CAUSE, members: [stuck], tier: 1, automation: null });
    expect(acts.filter(a => a.capability === 'run_repair')).toEqual([]);
    expect(acts.filter(a => a.capability === 'retry_recovery').map(a => a.params ?? null)).toEqual([null, { extendBudgetBy: 1 }]);
    expect(acts.filter(a => a.capability === 'decide').map(a => a.params?.option)).toEqual(['dismiss']);
  });
  it('a paused cause offers resume, not pause', () => {
    const paused = buildAutomationState([{ key: pauseKey({ kind: 'cause', causeKey: CAUSE }), value: {}, updatedAt: new Date(NOW), expiresAt: new Date(at(5)) }], new Date(NOW));
    const caps = availableActions({ causeKey: CAUSE, members: [incident()], tier: 2, automation: paused }).map(a => a.capability);
    expect(caps).toContain('resume_automation');
    expect(caps).not.toContain('pause_automation');
  });
});
