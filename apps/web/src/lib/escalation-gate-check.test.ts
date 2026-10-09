/**
 * gateEscalations: the escalation gate's server half. Rules decide without a
 * model; Jev decides the rest, live; a verdict is filed once per state and
 * reused; every failure asks the person; a stuck Buildd-owned state is the
 * person's again.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { escalationFingerprint, verdictCode, type EscalationSubject } from '@buildd/core/escalation-gate';
import { ESCALATION_STUCK_MS, escalationActionFiler, gateEscalations, storedVerdictWhere, type EscalationGateDeps, type GatedSubject, type StoredVerdict } from './escalation-gate-check';

const NOW = Date.parse('2026-10-09T12:00:00Z');

const subject = (over: Partial<GatedSubject> = {}): GatedSubject => ({
  key: 'pr:ws:7', workspaceId: 'ws', prNumber: 7, taskId: 'task-7', missionId: null, title: 'fix(x): y',
  why: 'reviewer_escalated', ci: 'green', conflict: false, machineActing: false, missionPrRole: null,
  detail: 'Reviewer asked for changes three times', teamId: 'team', accountId: null,
  ...over,
});

const jevRun = (disposition: string, action: string | null, confidence = 0.9, actionConfidence = 0.85) => async (opts: any) => {
  opts.onUsage?.({ kind: 'decision', decisionId: 'buildd.escalation_gate', provider: 'openrouter', model: 'jev', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 3, outcome: 'ok', attempts: 1 });
  return {
    ok: true, decisionId: 'buildd.escalation_gate', version: 'eg1|jev',
    outcomes: {
      disposition: { status: 'applied', value: disposition, confidence, answer: {} },
      action: action ? { status: 'applied', value: action, confidence: actionConfidence, answer: {} } : { status: 'skipped', reason: 'not_candidate' },
    },
    result: { ok: true, answers: {}, model: 'jev', usage: {}, latencyMs: 3, attempts: 1 }, receipt: null,
  } as any;
};

const FAILED = async () => ({
  ok: false, decisionId: 'd', version: 'v',
  outcomes: { disposition: { status: 'skipped', reason: 'error' }, action: { status: 'skipped', reason: 'error' } },
  result: { ok: false, error: { kind: 'timeout' } }, receipt: null,
} as any);

function harness(over: Partial<EscalationGateDeps> = {}, stored = new Map<string, StoredVerdict>()) {
  const records: any[] = [];
  const acted: Array<{ key: string; action: string }> = [];
  let modelCalls = 0;
  const run = (over.run ?? jevRun('act', 're_review')) as any;
  const deps: EscalationGateDeps = {
    decide: true,
    loadStored: async () => stored,
    resolveAccess: async () => ({ ok: true, apiKey: 'sk', model: 'jev' }) as any,
    recordReceipts: async () => {},
    record: async r => { records.push(r); return 'row'; },
    act: async (s, action) => { acted.push({ key: s.key, action }); },
    now: () => NOW,
    ...over,
    run: (async (opts: any) => { modelCalls += 1; return run(opts); }) as any,
  };
  return { deps, records, acted, calls: () => modelCalls };
}

describe('gateEscalations', () => {
  it('a rule decides without the model and is filed once', async () => {
    const h = harness();
    const s = subject({ ci: 'running', why: 'human_tier' });
    const out = await gateEscalations([s], h.deps);
    expect(out.get(s.key)).toMatchObject({ owner: 'buildd', by: 'rule', action: 'wait_ci' });
    expect(h.calls()).toBe(0);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ capability: 'escalation_gate', subjectType: 'pr', subjectId: s.key, applied: true, status: 'applied', fingerprint: escalationFingerprint(s) });
  });

  it('Jev decides what no rule covers, and Buildd takes the action it named', async () => {
    const h = harness({ run: jevRun('act', 'address_review') as any });
    const s = subject();
    const out = await gateEscalations([s], h.deps);
    expect(out.get(s.key)).toMatchObject({ owner: 'buildd', by: 'jev', action: 'address_review' });
    expect(h.calls()).toBe(1);
    expect(h.acted).toEqual([{ key: s.key, action: 'address_review' }]);
    expect(h.records[0]).toMatchObject({ applied: true, status: 'applied', verdict: 'act:address_review', confidence: 0.9 });
  });

  it('Jev asking reaches the person', async () => {
    const h = harness({ run: jevRun('ask', null) as any });
    const out = await gateEscalations([subject()], h.deps);
    expect(out.get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'jev' });
    expect(h.acted).toHaveLength(0);
  });

  it('a hold acts on nothing and keeps the PR out of the inbox', async () => {
    const h = harness({ run: jevRun('hold', null) as any });
    const out = await gateEscalations([subject()], h.deps);
    expect(out.get('pr:ws:7')).toMatchObject({ owner: 'buildd', action: 'hold' });
    expect(h.acted).toHaveLength(0);
  });

  it('the same state reuses the stored verdict: no model call, no new row', async () => {
    const s = subject();
    const stored = new Map([[s.key, { fingerprint: escalationFingerprint(s), appliedAnswer: 'buildd:jev:re_review:', createdAt: new Date(NOW - 60_000) }]]);
    const h = harness({}, stored);
    const out = await gateEscalations([s], h.deps);
    expect(out.get(s.key)).toMatchObject({ owner: 'buildd', by: 'jev', action: 're_review' });
    expect(h.calls()).toBe(0);
    expect(h.records).toHaveLength(0);
    expect(h.acted).toHaveLength(0);
  });

  it('a changed state is a new look', async () => {
    const s = subject();
    const stored = new Map([[s.key, { fingerprint: 'older-state', appliedAnswer: 'buildd:jev:re_review:', createdAt: new Date(NOW - 60_000) }]]);
    const h = harness({ run: jevRun('ask', null) as any }, stored);
    expect((await gateEscalations([s], h.deps)).get(s.key)).toMatchObject({ owner: 'person' });
    expect(h.calls()).toBe(1);
  });

  it('a Buildd-owned state that has not changed past the ceiling is the person\'s again', async () => {
    const s = subject({ ci: 'red' });
    const stored = new Map([[s.key, { fingerprint: escalationFingerprint(s), appliedAnswer: 'buildd:rule:ci_fix:', createdAt: new Date(NOW - ESCALATION_STUCK_MS - 1) }]]);
    const out = await gateEscalations([s], harness({}, stored).deps);
    expect(out.get(s.key)).toMatchObject({ owner: 'person' });
    expect((out.get(s.key) as any).reason).toMatch(/6h/);
  });

  it('an expired hold is the person\'s again', async () => {
    const s = subject();
    const stored = new Map([[s.key, { fingerprint: escalationFingerprint(s), appliedAnswer: `buildd:jev:hold:${new Date(NOW - 1000).toISOString()}`, createdAt: new Date(NOW - 3 * 3_600_000) }]]);
    expect((await gateEscalations([s], harness({}, stored).deps)).get(s.key)).toMatchObject({ owner: 'person' });
  });

  describe('never silences', () => {
    it('a failed model call asks the person and is filed as a fallback', async () => {
      const h = harness({ run: FAILED as any });
      const out = await gateEscalations([subject()], h.deps);
      expect(out.get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'fallback' });
      expect(h.records[0]).toMatchObject({ status: 'fallback', applied: false, reason: 'timeout' });
    });

    it('no key asks the person', async () => {
      const h = harness({ resolveAccess: async () => ({ ok: false, error: { kind: 'no_key' } }) as any });
      expect((await gateEscalations([subject()], h.deps)).get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'fallback' });
      expect(h.calls()).toBe(0);
    });

    it('a sensitive workspace never sends text to the model', async () => {
      const h = harness();
      expect((await gateEscalations([subject({ sensitive: true })], h.deps)).get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'fallback' });
      expect(h.calls()).toBe(0);
    });

    it('past the per-pass model budget the rest ask and are not filed', async () => {
      const h = harness({ maxModelCalls: 1, run: jevRun('act', 're_review') as any });
      const out = await gateEscalations([subject({ key: 'a' }), subject({ key: 'b' })], h.deps);
      expect(out.get('a')).toMatchObject({ owner: 'buildd' });
      expect(out.get('b')).toMatchObject({ owner: 'person', by: 'fallback' });
      expect(h.records.map(r => r.subjectId)).toEqual(['a']);
    });

    it('a stored-verdict read failure still decides', async () => {
      const h = harness({ loadStored: async () => { throw new Error('db down'); } });
      expect((await gateEscalations([subject({ ci: 'running', why: 'human_tier' })], h.deps)).get('pr:ws:7')).toMatchObject({ owner: 'buildd', action: 'wait_ci' });
    });
  });

  it('subjects of two teams each read their own stored verdicts', async () => {
    const seen: string[] = [];
    const h = harness({ loadStored: async (teamId) => { seen.push(teamId); return new Map(); } });
    await gateEscalations([subject({ teamId: 't1', key: 'a', ci: 'running' }), subject({ teamId: 't2', key: 'b', ci: 'running' })], h.deps);
    expect(seen.sort()).toEqual(['t1', 't2']);
  });
});

describe('read mode: what a page load or list_prs does', () => {
  const reader = (over: Partial<EscalationGateDeps> = {}, stored = new Map<string, StoredVerdict>()) => {
    const enqueued: string[] = [];
    const h = harness({ decide: false, enqueue: list => { enqueued.push(...list.map(s => s.key)); }, ...over }, stored);
    return { ...h, enqueued };
  };

  it('is the default: no model call, no ledger write', async () => {
    const records: any[] = [];
    let calls = 0;
    const out = await gateEscalations([subject()], {
      loadStored: async () => new Map(), record: async r => { records.push(r); },
      resolveAccess: async () => ({ ok: true, apiKey: 'sk', model: 'jev' }) as any,
      run: (async () => { calls += 1; return jevRun('act', 're_review')(); }) as any,
    });
    expect(calls).toBe(0);
    expect(records).toHaveLength(0);
    expect(out.get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'fallback' });
  });

  it('a subject Jev would decide shows as before and is queued for a background look', async () => {
    const r = reader();
    const out = await gateEscalations([subject()], r.deps);
    expect(r.calls()).toBe(0);
    expect(r.records).toHaveLength(0);
    expect(out.get('pr:ws:7')).toMatchObject({ owner: 'person', by: 'fallback' });
    expect(r.enqueued).toEqual(['pr:ws:7']);
  });

  it('a rule answers at once, and the look is still queued so the ledger gets its row', async () => {
    const r = reader();
    const s = subject({ ci: 'running', why: 'human_tier' });
    expect((await gateEscalations([s], r.deps)).get(s.key)).toMatchObject({ owner: 'buildd', by: 'rule', action: 'wait_ci' });
    expect(r.records).toHaveLength(0);
    expect(r.enqueued).toEqual([s.key]);
  });

  it('a stored verdict for the same state is read, not queued again', async () => {
    const s = subject();
    const stored = new Map([[s.key, { fingerprint: escalationFingerprint(s), appliedAnswer: 'buildd:jev:re_review:', createdAt: new Date(NOW - 60_000) }]]);
    const r = reader({}, stored);
    expect((await gateEscalations([s], r.deps)).get(s.key)).toMatchObject({ owner: 'buildd', by: 'jev', action: 're_review' });
    expect(r.enqueued).toEqual([]);
    expect(r.calls()).toBe(0);
  });

  it('a queue failure never changes what the page shows', async () => {
    const r = reader({ enqueue: () => { throw new Error('boom'); } });
    expect((await gateEscalations([subject()], r.deps)).get('pr:ws:7')).toMatchObject({ owner: 'person' });
  });
});

describe('storedVerdictWhere', () => {
  it('scopes to the team, the capability, the PR subject and these keys', () => {
    const q = new PgDialect().sqlToQuery(storedVerdictWhere('team-1', ['pr:ws:7']) as any);
    expect(q.sql).toContain('"team_id" = $1');
    expect(q.sql).toContain('"capability" = $2');
    expect(q.sql).toContain('"subject_type" = $3');
    expect(q.sql).toContain('"subject_id" in ($4)');
    expect(q.params).toEqual(['team-1', 'escalation_gate', 'pr', 'pr:ws:7']);
  });
});

describe('escalationActionFiler', () => {
  it('files one repair per PR and action, on the PR\'s own branch', async () => {
    const filed: any[] = [];
    const act = escalationActionFiler(async input => { filed.push(input); return { id: 'r', reused: false }; });
    await act(subject() as GatedSubject, 'address_review');
    expect(filed[0].spec.signature).toBe('escalation-gate:address_review:ws:7');
    expect(filed[0].spec.description).toMatch(/PR #7/);
    expect(filed[0].blockedTaskId).toBe('task-7');
  });

  it('files nothing for a PR it cannot name', async () => {
    const filed: any[] = [];
    const act = escalationActionFiler(async input => { filed.push(input); return null; });
    await act(subject({ prNumber: null }) as GatedSubject, 'ci_fix');
    expect(filed).toHaveLength(0);
  });
});

describe('verdict codes', () => {
  it('a rule verdict round-trips through the ledger', () => {
    expect(verdictCode({ owner: 'buildd', by: 'rule', action: 'wait_ci', reason: 'x' })).toBe('buildd:rule:wait_ci:');
  });
});

void (null as unknown as EscalationSubject);
