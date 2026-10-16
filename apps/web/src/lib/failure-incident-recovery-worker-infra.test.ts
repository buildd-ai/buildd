/**
 * Worker infrastructure recovery (docs/specs/failure-incident-recovery.md
 * §18.4): the sentinel rule that opens one incident per cause, the policy,
 * and the assessment end to end against an in-memory store. Only the fact
 * read is faked.
 */
import { describe, expect, it } from 'bun:test';
import { detectFailurePatterns, type WorkerInfraFact } from './failure-pattern-sentinel';
import { ruleCauseKey } from './failure-incident-cause-key';
import { assessIncident, planRecovery, type RecoveryDeps, type RecoveryEffects } from './failure-incident-recovery';
import { evaluateWorkerInfra, parseWorkerInfraSignature, type WorkerInfraRecoveryFacts, type WorkerInfraSubjectFacts } from './failure-incident-recovery-worker-infra';
import { mergeIncident, type IncidentStorePort, type StoredIncident } from './failure-incident-store';
import { incidentEscalationRule } from './failure-incident-escalation';
import { planCredentialHold, releasedHoldContext, type CredentialHold } from './task-recovery-hold';

const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const WS = 'ws-1';
const TASK_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TASK_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CRED = { credentialKey: 'account:acc-1', shared: false, label: 'the Claude login on runner "laptop"' };

const holdAt = (min: number, ctx: Record<string, unknown> = {}): CredentialHold =>
  planCredentialHold({ context: ctx, credential: CRED, now: at(min) }).hold;

function authFact(taskId: string, over: Partial<WorkerInfraFact> = {}): WorkerInfraFact {
  return { taskId, component: 'worker.auth', key: CRED.credentialKey, occurredAt: at(0), attempts: 1, exhausted: false, workerId: `w-${taskId.slice(0, 4)}`, ...over };
}

function openFrom(facts: WorkerInfraFact[], workspaceId = WS): StoredIncident {
  const [candidate] = detectFailurePatterns({ workspaceId, now: at(1), workerInfra: facts });
  const merged = mergeIncident(null, candidate).next as Omit<StoredIncident, 'id' | 'version'>;
  return { ...merged, id: 'inc-1', version: 0 } as StoredIncident;
}

function subject(taskId: string, over: Partial<WorkerInfraSubjectFacts> = {}): WorkerInfraSubjectFacts {
  return { taskId, status: 'pending', hold: holdAt(0), errorType: null, infraRetryCount: 0, lastWorkerAt: at(-1), lastError: '401 OAuth access token is invalid', ...over };
}

function authFacts(subjects: WorkerInfraSubjectFacts[], credentialHealthy: boolean | null = false): WorkerInfraRecoveryFacts {
  return { component: 'worker.auth', key: CRED.credentialKey, credentialHealthy, subjects };
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

describe('the rule: one incident per cause, never per task (I-16)', () => {
  it('two tasks held on the same credential are one incident, one causeKey (AC-23)', () => {
    const candidates = detectFailurePatterns({ workspaceId: WS, now: at(5), workerInfra: [authFact(TASK_A), authFact(TASK_B, { occurredAt: at(2) })] });
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.rule).toBe('infrastructure_failure');
    expect(c.signature).toBe(`infrastructure_failure|ws=${WS}|component=worker.auth|cred=account:acc-1`);
    expect(c.reasonCode).toBe('infrastructure.auth');
    expect(c.affected.taskIds.sort()).toEqual([TASK_A, TASK_B].sort());
    expect(c.severity).toBe('high');
    // The signature carries the credential key, never raw error text.
    expect(c.signature).not.toContain('401');
  });

  it('a shared team credential is one cause across workspaces; a runner login stays in its workspace', () => {
    const shared = (ws: string) => openFrom([authFact(TASK_A, { key: 'secret:s-team', shared: true })], ws);
    expect(ruleCauseKey(shared('ws-1'))).toBe(ruleCauseKey(shared('ws-2')));
    const own = (ws: string) => openFrom([authFact(TASK_A)], ws);
    expect(ruleCauseKey(own('ws-1'))).not.toBe(ruleCauseKey(own('ws-2')));
  });

  it('auth failures do not also open a per-signature repeated_failure', () => {
    const failures = [TASK_A, TASK_B, 'cccccccc-0000-4000-8000-000000000003'].map((t, i) => ({
      workerId: `w${i}`, taskId: t, signature: 'failed to authenticate api error n oauth', exitCause: 'auth_failure', occurredAt: at(-i),
    }));
    expect(detectFailurePatterns({ workspaceId: WS, now: at(1), workerFailures: failures }).filter(c => c.rule === 'repeated_failure')).toEqual([]);
  });

  it('parses its own signature', () => {
    expect(parseWorkerInfraSignature(`infrastructure_failure|ws=${WS}|component=worker.session_lost|sig=stale_worker_expired`))
      .toEqual({ component: 'worker.session_lost', key: 'stale_worker_expired' });
  });

  it('before its first assessment the gate holds it as Buildd\'s, never the person\'s', () => {
    const inc = openFrom([authFact(TASK_A), authFact(TASK_B)]);
    expect(incidentEscalationRule({ status: 'open', severity: inc.severity, rule: inc.rule } as any).owner).toBe('buildd');
  });
});

describe('worker.auth policy', () => {
  const inc = openFrom([authFact(TASK_A), authFact(TASK_B)]);

  it('waits for the credential while it is still rejected', () => {
    const o = evaluateWorkerInfra(inc, authFacts([subject(TASK_A), subject(TASK_B)], false), at(5));
    expect(o.verdict.kind).toBe('wait');
    expect(o.cause).toEqual({ reasonCode: 'infrastructure.auth', rule: 'infrastructure_failure', ownership: 'infrastructure' });
    expect((o.verdict as any).nextCheckAt).toBe(at(16));
  });

  it('releases every held task once the credential checks healthy (AC-19)', () => {
    const o = evaluateWorkerInfra(inc, authFacts([subject(TASK_A), subject(TASK_B)], true), at(5));
    expect(o.verdict).toMatchObject({ kind: 'repair', action: 'release_hold', params: { taskIds: [TASK_A, TASK_B] } });
  });

  it('an exhausted hold goes to the operator with the reconnect named, not to a person', () => {
    let ctx: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) ctx = planCredentialHold({ context: ctx, credential: CRED, now: at(0) }).context;
    const exhausted = subject(TASK_A, { hold: (ctx as any).credentialHold });
    const o = evaluateWorkerInfra(inc, authFacts([exhausted, subject(TASK_B)], false), at(5));
    expect(o.verdict.kind).toBe('operator');
    expect((o.verdict as any).capability).toBe('reconnect_credential');
    expect((o.verdict as any).reason).toContain('Reconnect the Claude login on runner "laptop"');
  });

  it('passes once every held task started again after its release', () => {
    const released = (id: string) => subject(id, { hold: { ...holdAt(0), releasedAt: at(6) }, lastWorkerAt: at(7) });
    expect(evaluateWorkerInfra(inc, authFacts([released(TASK_A), subject(TASK_B, { status: 'completed' })]), at(8)).verdict.kind).toBe('passed');
    // Released but not claimed yet: not passed, waiting.
    const notYet = subject(TASK_A, { hold: { ...holdAt(0), releasedAt: at(6) }, lastWorkerAt: at(-1) });
    expect(evaluateWorkerInfra(inc, authFacts([notYet]), at(8)).verdict.kind).toBe('wait');
  });

  it('a task that left the hold some other way (cancelled, no hold) passes; an unread row does not', () => {
    expect(evaluateWorkerInfra(inc, authFacts([subject(TASK_A, { status: 'cancelled' }), subject(TASK_B, { hold: null })]), at(5)).verdict.kind).toBe('passed');
    expect(evaluateWorkerInfra(inc, authFacts([subject(TASK_A, { status: null })]), at(5)).verdict.kind).not.toBe('passed');
  });

  it('a wait past the episode deadline becomes needs_operator, never needs_decision', () => {
    const o = evaluateWorkerInfra(inc, authFacts([subject(TASK_A)], false), at(7 * 60));
    const plan = planRecovery({ incident: inc, outcome: o, evidenceRevision: 'r1', now: at(7 * 60), source: 'sweep', complete: true });
    expect(plan.recovery.state).toBe('needs_operator');
    expect(plan.recovery.owner).toBe('operator');
    expect(plan.recovery.decision).toBeUndefined();
  });
});

describe('worker.session_lost policy', () => {
  const inc = openFrom([{ taskId: TASK_A, component: 'worker.session_lost', key: 'stale_worker_expired', occurredAt: at(0), attempts: 3, exhausted: true }]);
  const stalled = (over: Partial<WorkerInfraSubjectFacts> = {}) =>
    subject(TASK_A, { status: 'failed', errorType: 'infra_stalled', hold: null, infraRetryCount: 3, lastError: 'Stale worker expired (no update for 15+ minutes)', ...over });

  it('three infra failures are needs_operator with the evidence (AC-21)', () => {
    const o = evaluateWorkerInfra(inc, { component: 'worker.session_lost', key: 'stale_worker_expired', credentialHealthy: null, subjects: [stalled()] }, at(5));
    const plan = planRecovery({ incident: inc, outcome: o, evidenceRevision: 'r1', now: at(5), source: 'sweep', complete: true });
    expect(plan.recovery.state).toBe('needs_operator');
    expect(plan.recovery.capabilityGap?.capability).toBe('requeue_task');
    expect(plan.recovery.capabilityGap?.reason).toContain('3 retries');
    expect(plan.recovery.capabilityGap?.reason).toContain('Stale worker expired');
    expect(plan.recovery.causeGroup?.key).toMatch(/^c1:/);
  });

  it('passes once the task moves again', () => {
    const o = evaluateWorkerInfra(inc, { component: 'worker.session_lost', key: 'k', credentialHealthy: null, subjects: [stalled({ status: 'pending', errorType: null })] }, at(5));
    expect(o.verdict.kind).toBe('passed');
  });
});

describe('assessIncident: release once, then recovered', () => {
  it('releases the holds through the writer, once per key, and resolves when the tasks start', async () => {
    const inc = openFrom([authFact(TASK_A), authFact(TASK_B)]);
    const store = memoryPort(inc);
    const released: string[][] = [];
    const effects: RecoveryEffects = {
      async releaseBlocker() {}, async wakeSubject() {}, async fileFixTask() { return null; },
      async releaseHold(ids) { released.push(ids); return ids; },
    };
    let facts = authFacts([subject(TASK_A), subject(TASK_B)], true);
    let now = at(5);
    const deps: RecoveryDeps = {
      port: store.port, effects, now: () => now,
      families: [{ rule: 'infrastructure_failure', observe: async () => ({ complete: true, facts }), evaluate: evaluateWorkerInfra }],
    };

    const first = await assessIncident(deps, 'inc-1', 'sweep');
    expect(first.outcome).toBe('repaired');
    expect(released).toEqual([[TASK_A, TASK_B]]);
    // A concurrent trigger inside the re-check window runs nothing.
    const second = await assessIncident(deps, 'inc-1', 'sweep');
    expect(second.repair).toBeNull();
    expect(released).toHaveLength(1);

    // Both started on the restored credential.
    now = at(10);
    const releasedCtx = releasedHoldContext({ credentialHold: holdAt(0) }, at(5), 'k');
    facts = authFacts([TASK_A, TASK_B].map(id => subject(id, { hold: (releasedCtx as any).credentialHold, lastWorkerAt: at(8) })), null);
    const third = await assessIncident(deps, 'inc-1', 'sweep');
    expect(third.incident?.status).toBe('resolved');
    expect(store.get().recovery?.state).toBe('recovered');
  });
});
