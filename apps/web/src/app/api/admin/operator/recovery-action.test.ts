/**
 * POST /api/admin/operator's action path (operator-recovery spec §7.2): the
 * order parse → re-observe → CAS → precondition → audit intent → act →
 * complete, with in-memory incidents and a recording audit. The route's owner
 * gate (404, nothing written) is in platform-owner-routes.test.ts.
 */
import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery, RecoveryCauseRow } from '@buildd/shared';
import { buildAutomationState, pauseKey, type AutomationRow } from '@/lib/failure-incident-recovery-automation';
import { causeEvidenceRevisionOf, causeRevisionOf } from '@/lib/failure-incident-recovery-actions';
import type { RepairFacts } from '@/lib/failure-incident-repairs';
import type { StoredIncident } from '@/lib/failure-incident-store';
import type { PlatformAdminAuditInput } from '@/lib/admin/audit';
import { handleOperatorRecoveryAction, type OperatorActionDeps } from './recovery-action';

const NOW = '2026-10-11T12:00:00.000Z';
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
const INC = '00000000-0000-4000-8000-000000000101';
const TASK = '00000000-0000-4000-8000-0000000000a1';
const CAUSE_FROM_RULE = 'computed';
const OWNER = { accountId: 'acct-owner', operatorLabel: 'octo-owner' };

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
    ...over,
  };
}

function incident(over: Partial<StoredIncident> = {}): StoredIncident {
  return {
    id: INC, version: 4, workspaceId: 'ws-a', signature: 'path_overlap_stall|ws=ws-a|blocker=pr:7', detectorVersion: 'fps-v2',
    rule: 'path_overlap_stall', reasonCode: 'path_overlap.no_progress', title: 'Synthetic stall', severity: 'high', status: 'open',
    firstSeenAt: at(-3), lastSeenAt: NOW, occurrenceCount: 1, recurrenceCount: 0,
    affectedRefs: { taskIds: [TASK], workerIds: [], prNumbers: [7] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: recovery(),
    ...over,
  };
}

const facts = (over: Partial<RepairFacts> = {}): RepairFacts => ({
  observedAt: NOW,
  incident: { id: INC, rule: 'path_overlap_stall', causeCode: 'path_overlap.no_progress', generation: 2, state: 'waiting', spentKeys: [], linkedFixTaskId: null },
  blocker: { taskId: 'blk', state: 'merged', activeClaims: 2 },
  subjects: [{ taskId: TASK, missionId: null, status: 'pending', lastWorkerAt: null, outbox: null, staleWorker: null, infraRetries: 0 }],
  runnerOnline: true, fix: null, captureFailedAfterFix: null, missions: [], kernel: null,
  ...over,
});

const row = (i: StoredIncident): RecoveryCauseRow => ({
  causeKey: CAUSE_FROM_RULE, revision: causeRevisionOf([i]), title: i.title, sentence: 's', family: i.rule, causeCode: i.reasonCode,
  grouping: { source: 'rule', confidence: null, decisionId: null }, state: (i.recovery?.state ?? 'observing') as RecoveryCauseRow['state'], owner: 'buildd',
  rank: { position: 1, tier: 2, tierReason: 'Active', score: 10, why: 'w', components: [], override: null, advice: null },
  impact: { teams: [], workspaces: [], missions: [], tasks: { count: 1, sample: [{ id: TASK, name: 'Synthetic task', teamId: null }] }, blockedNow: 1, blockedTaskHours24h: { value: 1, basis: 'measured' }, blockedTaskHours7d: { value: 1, basis: 'measured' }, unblocks: { tasks: 0, missions: 0, teams: 0 }, waitsBehind: null },
  timing: { firstSeenAt: NOW, lastProgressAt: null, lastObservedAt: NOW, nextCheckAt: null, oldestOpenAgeH: 1 },
  trend: { episodes24h: 1, prior6dMeanDaily: 0, reopens7d: 0, direction: 'steady' },
  repair: { attempts: { total: 0, succeeded: 0, failed: 0, noEffect: 0, inFlight: 0 }, budget: { spent: i.recovery?.budget.spent ?? 0, limit: 3, exhausted: false }, fixTask: null, fixPr: null, wasteUsd7d: { value: 0, basis: 'measured' }, modelUsd7d: { value: 0, basis: 'measured' }, costPerRecoveredSubjectUsd: { value: null, basis: 'unknown' } },
  episodes: { open: 1, total7d: 1 }, telemetry: { completeness: 1, missing: [], freshness: { observedAt: NOW, lagSeconds: 0, state: 'fresh' } }, actions: [],
});

function harness(opts: { incident?: StoredIncident | null; automation?: AutomationRow[] | null; repairFacts?: RepairFacts; failIntent?: boolean; failComplete?: boolean } = {}) {
  let current: StoredIncident | null = opts.incident === undefined ? incident() : opts.incident;
  const log: string[] = [];
  const audits: Array<{ id: string; intent: PlatformAdminAuditInput; completed: Record<string, unknown> | null }> = [];
  const effects: string[] = [];
  const attempts: unknown[] = [];
  const deps: OperatorActionDeps = {
    async findIncident(id) { return current && current.id === id ? structuredClone(current) : null; },
    async reassess(id) { log.push(`reassess:${id}`); return current ? structuredClone(current) : null; },
    async causeMembers() { return current ? [structuredClone(current)] : []; },
    async causeRow() { return current ? row(current) : null; },
    async automation() { return buildAutomationState(opts.automation === undefined ? [] : opts.automation, new Date(NOW)); },
    async repairFacts() { return opts.repairFacts ?? facts(); },
    async linkTask() { return null; },
    async teams() { return new Map([['ws-a', 'team-a']]); },
    async auditIntent(event) {
      log.push('audit:intent');
      if (opts.failIntent) throw new Error('audit table down');
      const id = `audit-${audits.length + 1}`;
      audits.push({ id, intent: event, completed: null });
      return id;
    },
    async auditComplete(id, after) {
      log.push('audit:complete');
      if (opts.failComplete) return false;
      const a = audits.find(x => x.id === id);
      if (!a || a.completed) return false;
      a.completed = after;
      return true;
    },
    service: {
      port: {
        async findById() { return current ? structuredClone(current) : null; },
        async compareAndSwap(_id, expected, next) {
          if (!current || current.version !== expected) return null;
          log.push('write:incident');
          current = { ...structuredClone(next), id: current.id, version: expected + 1 };
          return structuredClone(current);
        },
      },
      effects: {
        async releaseBlocker(id) { log.push('effect:release'); effects.push(`release:${id}`); },
        async wakeSubject(id) { effects.push(`wake:${id}`); },
        async fileFixTask() { return 'fix-1'; },
      },
      events: { async attempt(e) { attempts.push(e); }, async verify() {} },
      async reassess() { return current; },
      async writeAutomation() { log.push('write:automation'); return NOW; },
      async recordPriority() { log.push('write:priority'); return 'decision-1'; },
      now: () => NOW,
    },
    now: () => NOW,
  };
  return { deps, log, audits, effects, attempts, get: () => current };
}

const body = (over: Record<string, unknown> = {}) => ({
  capability: 'run_repair', target: { incidentId: INC, generation: 2 }, evidenceRevision: 'ev-1',
  params: { repair: 'release_blocker' }, reason: 'Blocker merged; claims stuck after a missed webhook.', ...over,
});

describe('POST /api/admin/operator: owner recovery actions', () => {
  it('400 for an unknown param, before anything is read or written', async () => {
    const h = harness();
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body({ params: { repair: 'release_blocker', bypass: true } }));
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/unknown param "bypass"/);
    expect(h.log).toEqual([]);
  });

  it('400 for a missing reason and for a capability outside orq-cap-v1', async () => {
    const h = harness();
    expect((await handleOperatorRecoveryAction(h.deps, OWNER, body({ reason: undefined }))).status).toBe(400);
    expect((await handleOperatorRecoveryAction(h.deps, OWNER, body({ capability: 'disable_trigger' }))).status).toBe(400);
  });

  it('404 for an incident that does not exist', async () => {
    const h = harness({ incident: null });
    expect((await handleOperatorRecoveryAction(h.deps, OWNER, body())).status).toBe(404);
    expect(h.audits).toEqual([]);
  });

  it('applied: re-observe, audit intent, then the write and the repair, then the audit completed with before and after', async () => {
    const h = harness();
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body());
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('applied');
    expect(r.body.auditId).toBe('audit-1');
    expect(h.log).toEqual([`reassess:${INC}`, 'audit:intent', 'write:incident', 'effect:release', 'audit:complete']);
    expect(h.effects).toEqual(['release:blk']);
    const a = h.audits[0];
    expect(a.intent).toMatchObject({ action: 'recovery.run_repair', targetType: 'incident', targetId: INC, actorAccountId: 'acct-owner', teamId: 'team-a' });
    expect(a.intent.after).toMatchObject({ operatorLabel: 'octo-owner', reason: 'Blocker merged; claims stuck after a missed webhook.' });
    expect((a.intent.before as { repair: { budget: { spent: number } } }).repair.budget.spent).toBe(0);
    expect(a.completed).toMatchObject({ phase: 'applied', operatorLabel: 'octo-owner' });
    expect((a.completed as { repair: { budget: { spent: number } } }).repair.budget.spent).toBe(1);
    // §7.2: before/after drop impact.tasks.sample
    expect((a.intent.before as { impact: { tasks: Record<string, unknown> } }).impact.tasks).toEqual({ count: 1 });
    expect(h.attempts).toHaveLength(1);
    expect((h.attempts[0] as { detail: { actor: string } }).detail.actor).toBe('platform_admin:acct-owner');
  });

  it('409 stale with the fresh row when the generation moved; nothing written, no audit', async () => {
    const h = harness();
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body({ target: { incidentId: INC, generation: 1 } }));
    expect(r.status).toBe(409);
    expect(r.body.result).toBe('stale');
    expect((r.body.cause as RecoveryCauseRow).title).toBe('Synthetic stall');
    expect(h.audits).toEqual([]);
    expect(h.log).not.toContain('write:incident');
  });

  it('409 stale when the evidence changed since the action was offered', async () => {
    const h = harness();
    expect((await handleOperatorRecoveryAction(h.deps, OWNER, body({ evidenceRevision: 'ev-0' }))).status).toBe(409);
  });

  it('422 precondition on the fresh facts, with the fresh row', async () => {
    const h = harness({ repairFacts: facts({ blocker: { taskId: 'blk', state: 'open', activeClaims: 2 } }) });
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body());
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ result: 'rejected', reason: 'precondition' });
    expect(r.body.cause).toBeTruthy();
    expect(h.audits).toEqual([]);
  });

  it('422 budget when the generation spent its repairs', async () => {
    const h = harness({ incident: incident({ recovery: recovery({ budget: { spent: 3, limit: 3, deadlineAt: at(4), spentKeys: ['a', 'b', 'c'] } }) }) });
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body());
    expect(r).toMatchObject({ status: 422, body: { reason: 'budget' } });
  });

  it('422 paused without overridePause; applied and audited as an override with it (F-13)', async () => {
    const paused: AutomationRow[] = [{ key: pauseKey({ kind: 'platform' }), value: { until: at(5) }, updatedAt: new Date(NOW), expiresAt: new Date(at(5)) }];
    const h = harness({ automation: paused });
    expect(await handleOperatorRecoveryAction(h.deps, OWNER, body())).toMatchObject({ status: 422, body: { reason: 'paused' } });
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body({ params: { repair: 'release_blocker', overridePause: true } }));
    expect(r.status).toBe(200);
    expect(h.audits[0].intent.after).toMatchObject({ overridePause: true });
  });

  it('a pause is read fail-closed: an unreadable switch answers paused', async () => {
    const h = harness({ automation: null });
    expect(await handleOperatorRecoveryAction(h.deps, OWNER, body())).toMatchObject({ status: 422, body: { reason: 'paused' } });
  });

  it('nothing runs when the audit intent cannot be written', async () => {
    const h = harness({ failIntent: true });
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body());
    expect(r.status).toBe(500);
    expect(h.log).not.toContain('write:incident');
    expect(h.effects).toEqual([]);
  });

  it('a completion failure is a 500, never an applied answer', async () => {
    const h = harness({ failComplete: true });
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, body());
    expect(r.status).toBe(500);
    expect(r.body.result).toBeUndefined();
  });

  it('pause_automation on a cause writes the switch through its CAS and audits it', async () => {
    const h = harness();
    const i = incident();
    const causeBody = {
      capability: 'pause_automation', target: { causeKey: 'c1:0123456789abcdef0123', revision: causeRevisionOf([i]) },
      evidenceRevision: 'none', params: { scope: 'cause', until: at(24) }, reason: 'Hold repairs while the fix lands.',
    };
    const r = await handleOperatorRecoveryAction(h.deps, OWNER, causeBody);
    expect(r.status).toBe(200);
    expect(h.log).toContain('write:automation');
    expect(h.audits[0].intent).toMatchObject({ action: 'recovery.pause_automation', targetType: 'cause' });
    // the cause evidence revision is not checked for a switch; its own CAS token is
    expect(causeEvidenceRevisionOf([i])).not.toBe('none');
  });

  it('set_priority refuses a 48 h snooze of a safety cause (F-12)', async () => {
    const h = harness();
    const i = incident();
    const base = { capability: 'set_priority', target: { causeKey: 'c1:0123456789abcdef0123', revision: causeRevisionOf([i]) }, evidenceRevision: causeEvidenceRevisionOf([i]), reason: 'Known; fix lands tomorrow.' };
    h.deps.causeRow = async () => ({ ...row(i), rank: { ...row(i).rank, tier: 0 } });
    expect(await handleOperatorRecoveryAction(h.deps, OWNER, { ...base, params: { mode: 'snooze', until: at(48) } })).toMatchObject({ status: 422, body: { reason: 'precondition' } });
    const ok = await handleOperatorRecoveryAction(h.deps, OWNER, { ...base, params: { mode: 'snooze', until: at(12) } });
    expect(ok.status).toBe(200);
    expect(h.log).toContain('write:priority');
  });
});
