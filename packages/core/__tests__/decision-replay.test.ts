import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  captureDecisionReplay,
  listReplayableDecisions,
  loadDecisionReplay,
  replayListPredicates,
  replaySampleRate,
  resetReplayCounters,
  MAX_REPLAY_STATE_CHARS,
  getDecisionReplayStore,
  registerDecisionReplayStore,
  type CaptureInput,
  type DecisionReplayInput,
  type DecisionReplayLocator,
  type DecisionReplayStore,
  type ReplayLedgerRow,
} from '../decision-replay';

const TEAM = '11111111-1111-4111-8111-111111111111';
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222';
const WS = '33333333-3333-4333-8333-333333333333';
const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ASKED = new Date('2026-01-05T10:00:00Z');

function memoryStore() {
  const objects = new Map<string, DecisionReplayInput>();
  const jobs: Array<() => Promise<void>> = [];
  const keyOf = (l: DecisionReplayLocator) => `${l.teamId}/${l.capability}/${l.askedAt.toISOString().slice(0, 10)}/${l.decisionId}`;
  const store: DecisionReplayStore & { objects: typeof objects; jobs: typeof jobs; flush(): Promise<void> } = {
    objects,
    jobs,
    async put(l, input) { objects.set(keyOf(l), input); return 'stored'; },
    async get(l) { return objects.get(keyOf(l)) ?? null; },
    defer(job) { jobs.push(job); },
    async flush() { while (jobs.length) await jobs.shift()!(); },
  };
  return store;
}

function capture(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    decisionId: ID1,
    source: 'orchestration_decisions',
    teamId: TEAM,
    workspaceId: WS,
    capability: 'orchestration_claim',
    model: 'typesafe/jev-1.13',
    ruleAnswer: 'HOLD',
    askedAt: ASKED,
    state: 'A task is waiting; another task edits the same file.',
    questionIds: ['start'],
    candidates: ['START', 'HOLD'],
    promptRef: { id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'abc123' },
    ...over,
  };
}

const ENV_KEYS = ['DECISION_REPLAY_SAMPLE', 'DECISION_REPLAY_SAMPLE_ORCHESTRATION_CLAIM', 'DECISION_REPLAY_DAILY_CAP'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  resetReplayCounters();
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('captureDecisionReplay', () => {
  it('stores the input after the decision, deferred, keyed by the ledger id', async () => {
    const store = memoryStore();
    expect(captureDecisionReplay(capture(), { store })).toBe('scheduled');
    // Nothing is written until the deferred job runs: the decision never waits on storage.
    expect(store.objects.size).toBe(0);
    await store.flush();
    const [stored] = [...store.objects.values()];
    expect(stored).toEqual({
      capability: 'orchestration_claim',
      decisionId: ID1,
      model: 'typesafe/jev-1.13',
      promptRef: { id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'abc123' },
      state: 'A task is waiting; another task edits the same file.',
      questionIds: ['start'],
      candidates: ['START', 'HOLD'],
      ruleAnswer: 'HOLD',
      askedAt: ASKED.toISOString(),
      source: 'orchestration_decisions',
      featureSchemaVersion: null,
    });
  });

  it('does nothing without a registered store', () => {
    expect(captureDecisionReplay(capture(), { store: null })).toBe('no_store');
  });

  it('never throws and never fails the caller when the store write throws', async () => {
    const store = memoryStore();
    store.put = async () => { throw new Error('bucket down'); };
    expect(captureDecisionReplay(capture(), { store })).toBe('scheduled');
    await store.flush(); // the warning is swallowed
  });

  it('skips a missing state or id', () => {
    const store = memoryStore();
    expect(captureDecisionReplay(capture({ state: null }), { store })).toBe('invalid');
    expect(captureDecisionReplay(capture({ decisionId: '' }), { store })).toBe('invalid');
  });

  it('skips a state too large to be a decision input', () => {
    const store = memoryStore();
    expect(captureDecisionReplay(capture({ state: 'x'.repeat(MAX_REPLAY_STATE_CHARS + 1) }), { store })).toBe('too_large');
  });

  it('honours the per-kind daily cap, per team and UTC day', () => {
    const store = memoryStore();
    expect(captureDecisionReplay(capture(), { store, cap: 2 })).toBe('scheduled');
    expect(captureDecisionReplay(capture({ decisionId: ID2 }), { store, cap: 2 })).toBe('scheduled');
    expect(captureDecisionReplay(capture({ decisionId: ID3 }), { store, cap: 2 })).toBe('capped');
    // Another kind, another team and the next day each have their own budget.
    expect(captureDecisionReplay(capture({ capability: 'task_verdict' }), { store, cap: 2 })).toBe('scheduled');
    expect(captureDecisionReplay(capture({ teamId: OTHER_TEAM }), { store, cap: 2 })).toBe('scheduled');
    expect(captureDecisionReplay(capture({ askedAt: new Date('2026-01-06T00:00:01Z') }), { store, cap: 2 })).toBe('scheduled');
  });

  it('samples per kind: a kind-specific rate beats the global one', () => {
    process.env.DECISION_REPLAY_SAMPLE = '0';
    expect(replaySampleRate('task_verdict')).toBe(0);
    process.env.DECISION_REPLAY_SAMPLE_ORCHESTRATION_CLAIM = '0.5';
    expect(replaySampleRate('orchestration_claim')).toBe(0.5);
    const store = memoryStore();
    expect(captureDecisionReplay(capture(), { store, random: () => 0.4 })).toBe('scheduled');
    expect(captureDecisionReplay(capture({ decisionId: ID2 }), { store, random: () => 0.6 })).toBe('sampled_out');
    expect(captureDecisionReplay(capture({ capability: 'task_verdict' }), { store, random: () => 0 })).toBe('sampled_out');
  });

  it('defaults to keeping every decision', () => {
    expect(replaySampleRate('orchestration_claim')).toBe(1);
  });
});

describe('registerDecisionReplayStore', () => {
  it('is shared across module copies in one process', async () => {
    const store = memoryStore();
    registerDecisionReplayStore(store);
    try {
      expect(getDecisionReplayStore()).toBe(store);
      expect((globalThis as any)[Symbol.for('buildd.decision-replay.store')]).toBe(store);
      expect(captureDecisionReplay(capture())).toBe('scheduled');
    } finally {
      registerDecisionReplayStore(null);
    }
    expect(captureDecisionReplay(capture({ decisionId: ID2 }))).toBe('no_store');
  });
});

describe('loadDecisionReplay', () => {
  const ledger: ReplayLedgerRow[] = [
    { decisionId: ID1, teamId: TEAM, workspaceId: WS, capability: 'orchestration_claim', createdAt: ASKED },
    { decisionId: ID2, teamId: OTHER_TEAM, workspaceId: WS, capability: 'orchestration_claim', createdAt: ASKED },
    { decisionId: ID3, teamId: TEAM, workspaceId: WS, capability: 'task_verdict', createdAt: ASKED },
  ];

  it("returns the caller's team's stored copies and drops ids with none", async () => {
    const store = memoryStore();
    captureDecisionReplay(capture(), { store });
    captureDecisionReplay(capture({ decisionId: ID2, teamId: OTHER_TEAM }), { store });
    await store.flush();
    const got = await loadDecisionReplay(
      { teamId: TEAM, decisionIds: [ID1, ID2, ID3, 'not-a-uuid'] },
      { store, lookupLedger: async ids => ledger.filter(r => ids.includes(r.decisionId)) },
    );
    // ID2 is another team's, ID3 has no copy.
    expect([...got.keys()]).toEqual([ID1]);
  });

  it('replays a decision with the prompt version it was asked under, even after the prompt changed', async () => {
    const store = memoryStore();
    captureDecisionReplay(capture({ promptRef: { id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'old-hash' } }), { store });
    await store.flush();
    const got = await loadDecisionReplay({ teamId: TEAM, decisionIds: [ID1] }, { store, lookupLedger: async () => ledger.slice(0, 1) });
    expect(got.get(ID1)?.promptRef).toEqual({ id: 'buildd.orchestration_claim_hold', version: '3', contentHash: 'old-hash' });
  });

  it('treats an unreadable copy as absent', async () => {
    const store = memoryStore();
    store.get = async () => { throw new Error('expired credentials'); };
    const got = await loadDecisionReplay({ teamId: TEAM, decisionIds: [ID1] }, { store, lookupLedger: async () => ledger.slice(0, 1) });
    expect(got.size).toBe(0);
  });

  it('returns an empty map with no store', async () => {
    const got = await loadDecisionReplay({ teamId: TEAM, decisionIds: [ID1] }, { store: null, lookupLedger: async () => ledger });
    expect(got.size).toBe(0);
  });
});

describe('listReplayableDecisions', () => {
  it("lists the team's rows newest first, within the limit", async () => {
    const rows: ReplayLedgerRow[] = [
      { decisionId: ID1, teamId: TEAM, workspaceId: WS, capability: 'a', createdAt: new Date('2026-01-01T00:00:00Z') },
      { decisionId: ID2, teamId: TEAM, workspaceId: null, capability: 'b', createdAt: new Date('2026-01-03T00:00:00Z') },
      { decisionId: ID3, teamId: OTHER_TEAM, workspaceId: WS, capability: 'a', createdAt: new Date('2026-01-04T00:00:00Z') },
    ];
    const got = await listReplayableDecisions(
      { teamId: TEAM, since: new Date('2025-12-01'), limit: 1 },
      { listLedger: async () => rows },
    );
    expect(got).toEqual([{ decisionId: ID2, capability: 'b', createdAt: new Date('2026-01-03T00:00:00Z') }]);
  });

  it('only lists rows where a model was asked, scoped to the team, window and kind', async () => {
    const dialect = new PgDialect();
    const where = await replayListPredicates({ teamId: TEAM, capability: 'orchestration_claim', since: ASKED });
    const records = dialect.sqlToQuery(where.records!);
    expect(records.sql).toContain('"decision_records"."team_id" = $1');
    expect(records.sql).toContain('"decision_records"."created_at" >= $2');
    expect(records.sql).toContain('"decision_records"."capability" = $3');
    expect(records.sql).toContain('"decision_records"."verdict" is not null');
    expect(records.sql).toContain('"decision_records"."failure_class" = $4');
    expect(records.params).toEqual([TEAM, ASKED.toISOString(), 'orchestration_claim', 'provider']);
    const orch = dialect.sqlToQuery(where.orchestration!);
    expect(orch.sql).toContain('"orchestration_decisions"."team_id" = $1');
    expect(orch.sql).toContain('"orchestration_decisions"."reason" not in');
    expect(orch.params).toContain('no_candidates');
    expect(orch.params).toContain('rule_decided');
  });
});
