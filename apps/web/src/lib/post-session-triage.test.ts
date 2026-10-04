import { describe, expect, it } from 'bun:test';
import { buildStageAFacts, type StageAFacts, type StageASource } from '@buildd/core/post-session-quality';
import {
  POST_SESSION_TRIAGE_CAPABILITY,
  TRIAGE_UNAVAILABLE,
  type TriageOutcome,
} from '@buildd/core/post-session-triage';
import {
  triagePostSessionRun,
  type PostSessionTriageInput,
  type PostSessionTriageStore,
} from './post-session-triage';

const NOW = new Date('2026-10-03T12:00:00Z');

function facts(over: Partial<StageASource> & { worker?: Partial<StageASource['worker']> } = {}): StageAFacts {
  const { worker, ...rest } = over;
  return buildStageAFacts({
    worker: {
      id: 'worker-1', status: 'completed', exitCause: null, error: null, turns: 8, inputTokens: 100, outputTokens: 50,
      costUsd: '0.2', startedAt: new Date('2026-10-03T11:00:00Z'), completedAt: NOW, prNumber: 9,
      prLifecycleStatus: 'ci_green', mergedAt: null, supersededByPrNumber: null, abandonedAt: null,
      rejectedCompletionPayload: null, dirtyWorktree: false, mcpCallCount: 2, resultMeta: null,
      ...worker,
    },
    task: {
      id: 'task-1', status: 'completed', kind: 'engineering', category: null, roleSlug: 'builder', missionId: null,
      outputRequirement: 'pr_required', creationSource: null, parentTaskId: null, result: null,
    },
    workspace: { id: 'ws-1', mergePolicyTier: null, dataClass: 'standard' },
    mode: 'shadow',
    attempts: { attemptNumber: 1, totalAttempts: 1 },
    reviews: [{ status: 'completed', verdict: 'approve', confidence: 0.9 }],
    ciFixAttempts: 0,
    errorTraces: [],
    transcript: { availability: 'present', sizeBytes: null },
    corpora: null,
    unavailable: [],
    ...rest,
  });
}

function fakeStore(input: Partial<PostSessionTriageInput> | null, opts: { fence?: boolean; throwOnLoad?: boolean; throwOnRecord?: boolean } = {}) {
  const recorded: Array<{ runId: string; outcome: TriageOutcome; now: Date }> = [];
  const failures: Array<{ runId: string; error: string }> = [];
  let state = input?.state ?? 'collected';
  const store: PostSessionTriageStore = {
    async loadTriageInput(runId) {
      if (opts.throwOnLoad) throw new Error('db down');
      if (!input) return null;
      return {
        runId, state, facts: facts(), teamId: 'team-1', workspaceId: 'ws-1', dataClass: 'standard', ...input,
      } as PostSessionTriageInput;
    },
    async recordTriage(runId, outcome, now) {
      if (opts.throwOnRecord) throw new Error('write timeout');
      if (opts.fence || state !== 'collected') return false;
      recorded.push({ runId, outcome, now });
      state = outcome.finalDecision === 'analyse' ? 'triaged' : 'skipped';
      return true;
    },
    async listUntriaged() {
      return state === 'collected' ? ['run-1'] : [];
    },
    async recordTriageFailure(runId, error) {
      failures.push({ runId, error });
    },
  };
  return { store, recorded, failures, get state() { return state; } };
}

function okDecide(choice: { decision: string; focus: string; reasonCode: string; confidence?: number }) {
  const calls: any[] = [];
  const decide = (async (params: any) => {
    calls.push(params);
    params.onUsage?.({ decisionId: params.decisionId, model: 'm-1', usage: { costUsd: 0.00004 } });
    return {
      ok: true,
      model: 'm-1',
      usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.00004 },
      latencyMs: 210,
      attempts: 1,
      answers: {
        decision: { type: 'choice', choice: choice.decision, confidence: choice.confidence ?? 0.8, probabilities: {} },
        focus: { type: 'choice', choice: choice.focus, confidence: 0.6, probabilities: {} },
        reasonCode: { type: 'choice', choice: choice.reasonCode, confidence: 0.55, probabilities: {} },
      },
    };
  }) as any;
  return { decide, calls };
}

const failDecide = (kind: string) => (async () => ({ ok: false, error: { kind }, latencyMs: 5000, attempts: 2 })) as any;

describe('triagePostSessionRun', () => {
  it('records the model decision, typed fields, provenance and final outcome', async () => {
    const s = fakeStore({});
    const { decide, calls } = okDecide({ decision: 'analyse', focus: 'retrieval', reasonCode: 'retrieval_gap', confidence: 0.77 });
    const receipts: unknown[] = [];
    const res = await triagePostSessionRun('run-1', {
      store: s.store, decide, now: NOW, recordReceipts: async r => { receipts.push(...r); },
    });
    expect(res).toMatchObject({ status: 'triaged', finalDecision: 'analyse', rule: 'triage', triageStatus: 'ok', hardTriggered: false });
    // Stage cost comes from the decision receipts, for the sweep readout.
    expect(res).toMatchObject({ cost: { calls: 1, usd: 0.00004 } });
    expect(s.recorded).toHaveLength(1);
    const o = s.recorded[0].outcome;
    expect(o.triage).toMatchObject({ status: 'ok', decision: 'analyse', focus: 'retrieval', reasonCode: 'retrieval_gap', confidence: 0.77 });
    expect(o.triage.provenance).toMatchObject({ model: 'm-1', promptVersion: 'pst1', rule: 'triage' });
    expect(o).toMatchObject({ hardTriggered: false, hardTriggerReasons: [], finalDecision: 'analyse' });
    expect(s.state).toBe('triaged');

    // Called through the team-aware decision client, with the dedicated capability and no ids in state.
    expect(calls[0]).toMatchObject({ capability: POST_SESSION_TRIAGE_CAPABILITY, teamId: 'team-1', workspaceId: 'ws-1' });
    expect(JSON.stringify(calls[0].state)).not.toContain('worker-1');
    expect(receipts).toHaveLength(1);
  });

  it('a model skip with no hard trigger settles the run as skipped', async () => {
    const s = fakeStore({});
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(res).toMatchObject({ status: 'triaged', finalDecision: 'skip' });
    expect(s.state).toBe('skipped');
  });

  it('a hard trigger overrides a model skip and is recorded', async () => {
    const s = fakeStore({ facts: facts({ reviews: [{ status: 'completed', verdict: 'escalate', confidence: 0.9 }] }) });
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(res).toMatchObject({ status: 'triaged', hardTriggered: true });
    expect(s.recorded[0].outcome).toMatchObject({
      finalDecision: 'analyse', rule: 'hard_trigger', hardTriggered: true, hardTriggerReasons: ['reviewer_escalated'],
    });
    // The model's own answer is still kept for later comparison.
    expect(s.recorded[0].outcome.triage.decision).toBe('skip');
  });

  for (const kind of ['timeout', 'missing_key', 'capability_disabled', 'transport']) {
    it(`decision ${kind}: records triage_unavailable and fails open to skip`, async () => {
      const s = fakeStore({});
      const res = await triagePostSessionRun('run-1', { store: s.store, decide: failDecide(kind), now: NOW });
      expect(res).toMatchObject({ status: 'triaged', finalDecision: 'skip', rule: 'fail_open_skip', triageStatus: 'unavailable' });
      expect(s.recorded[0].outcome.triage).toMatchObject({ status: 'unavailable', reasonCode: TRIAGE_UNAVAILABLE });
      expect(s.recorded[0].outcome.triage.provenance?.error).toBe(kind);
    });
  }

  it('a malformed answer is unavailable; hard triggers still apply', async () => {
    const s = fakeStore({ facts: facts({ ciFixAttempts: 4 }) });
    const { decide } = okDecide({ decision: 'maybe', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(res).toMatchObject({ finalDecision: 'analyse', rule: 'hard_trigger', triageStatus: 'unavailable' });
    expect(s.recorded[0].outcome.triage.provenance?.error).toBe('malformed');
  });

  it('a decide that throws is caught and treated as unavailable', async () => {
    const s = fakeStore({});
    const decide = (async () => { throw new Error('boom'); }) as any;
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(res).toMatchObject({ status: 'triaged', triageStatus: 'unavailable', finalDecision: 'skip' });
  });

  it('a sensitive workspace never calls the model', async () => {
    const s = fakeStore({ dataClass: 'sensitive' });
    const { decide, calls } = okDecide({ decision: 'analyse', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(calls).toHaveLength(0);
    // No call, no cost.
    expect(res).toMatchObject({ cost: { calls: 0, usd: null } });
    expect(s.recorded[0].outcome.triage).toMatchObject({ status: 'unavailable' });
    expect(s.recorded[0].outcome.triage.provenance?.error).toBe('sensitive');
  });

  it('a receipt write failure never changes the outcome', async () => {
    const s = fakeStore({});
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', {
      store: s.store, decide, now: NOW, recordReceipts: async () => { throw new Error('db'); },
    });
    expect(res).toMatchObject({ status: 'triaged', finalDecision: 'skip' });
  });

  it('only a collected run is triaged; anything else is not_ready and the model is not called', async () => {
    for (const state of ['collecting', 'triaged', 'skipped', 'failed'] as const) {
      const s = fakeStore({ state });
      const { decide, calls } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
      const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
      expect(res).toMatchObject({ status: 'not_ready' });
      expect(calls).toHaveLength(0);
    }
    const noFacts = fakeStore({ facts: null });
    expect((await triagePostSessionRun('run-1', { store: noFacts.store, decide: failDecide('x'), now: NOW })).status).toBe('not_ready');
  });

  it('losing the fence reports fenced (a concurrent sweep already triaged it)', async () => {
    const s = fakeStore({}, { fence: true });
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    expect((await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW })).status).toBe('fenced');
  });

  it('never throws: missing run and store errors are returned statuses', async () => {
    expect((await triagePostSessionRun('run-1', { store: fakeStore(null).store, decide: failDecide('x'), now: NOW })).status).toBe('missing');
    const res = await triagePostSessionRun('run-1', { store: fakeStore({}, { throwOnLoad: true }).store, decide: failDecide('x'), now: NOW });
    expect(res).toMatchObject({ status: 'error' });
  });

  it('a store error after the decision is recorded on the run, not swallowed', async () => {
    const s = fakeStore({}, { throwOnRecord: true });
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    const res = await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW });
    expect(res).toMatchObject({ status: 'error', error: 'write timeout' });
    expect(s.failures).toEqual([{ runId: 'run-1', error: 'write timeout' }]);
  });

  it('a failing failure-recorder never turns into a throw', async () => {
    const s = fakeStore({}, { throwOnRecord: true });
    s.store.recordTriageFailure = async () => { throw new Error('still down'); };
    const { decide } = okDecide({ decision: 'skip', focus: 'general', reasonCode: 'routine_success' });
    expect((await triagePostSessionRun('run-1', { store: s.store, decide, now: NOW })).status).toBe('error');
  });
});
