import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: mockFireGateEvent,
  GATE_SLUGS: { CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
}));
const mockRecordDecision = mock(async (_row: any) => {});
mock.module('@buildd/core/orchestration-ledger-source', () => ({ recordOrchestrationDecision: mockRecordDecision }));
const { overrideStartSubscribers } = await import('./override-start-decision');
mock.module('@/lib/core-emit', () => ({
  emit: async (e: any) => { for (const s of overrideStartSubscribers) if (s.on === e.type) await (s.run as any)(e); },
}));

import { buildForceStartIntent, consumeForceStart, recordForceStartClaim, recordForceStartRequest } from './force-start';
import { makeWaitingReason } from '@buildd/core/waiting-reason';

// Start anyway (spec 36df686b r1): the audit half. Reuses force receipts and history.
const declared = makeWaitingReason('dep_declared', {
  because: 'it was declared as a dependency',
  blocker: { type: 'task', id: 'up-1', label: 'Upstream task', live: true },
  provenance: { source: 'task_context', derivedFrom: 'tasks.dependsOn' },
});
const now = new Date('2026-10-23T12:00:00Z');
const task = { id: '11111111-1111-1111-1111-111111111111', workspaceId: 'ws', missionId: null, teamId: 'team' };

describe('Start anyway: request and claim records', () => {
  beforeEach(() => { mockFireGateEvent.mockClear(); mockRecordDecision.mockClear(); });

  it('R-2: the intent names the observed declared edges and the digest, and is built idempotently from them', () => {
    const intent = buildForceStartIntent({ reasons: [declared], userId: 'u1', accountId: null, now });
    expect(intent.kinds).toEqual(['dep_declared']);
    expect((intent as any).assessDependsOn).toEqual(['up-1']);
    expect(intent.liftDependsOn).toBeUndefined();
    expect(intent.reasonsDigest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('AC-7: a consumed request leaves exactly one request event, one claim event and one human-force decision row', () => {
    const intent = buildForceStartIntent({ reasons: [declared], userId: 'u1', accountId: null, now });
    recordForceStartRequest({ intent, task, callerOrigin: 'dashboard' });
    recordForceStartClaim({ intent, bypassed: [], task, workerId: 'w1', accountId: 'acc', runner: 'r1', now: new Date(now.getTime() + 5000) });
    const events = mockFireGateEvent.mock.calls.map(c => c[0]).filter(e => e.reason === 'force_start');
    expect(events.map(e => e.detail.phase)).toEqual(['requested', 'claimed']);
    expect(mockRecordDecision).toHaveBeenCalledTimes(1);
    expect(mockRecordDecision.mock.calls[0][0]).toMatchObject({ decisionId: 'buildd.human_force_start', candidatePolicyVersion: 'hf1.dep_declared' });

    // History keeps the consumed intent; assessment/park/resume attach separately.
    const ctx = consumeForceStart({ forceStart: intent }, intent, { bypassed: [], at: now });
    expect(ctx.forceStartHistory).toEqual([expect.objectContaining({ id: intent.id, assessDependsOn: ['up-1'] })]);
    expect(JSON.stringify(ctx.forceStartHistory)).not.toContain('assessment');
  });

  it('R-15: the decision row records the human preference without grading a model wrong', () => {
    const intent = buildForceStartIntent({ reasons: [declared], userId: 'u1', accountId: null, now });
    recordForceStartClaim({ intent, bypassed: [], task, workerId: 'w1', accountId: 'acc', runner: 'r1', now });
    const row = mockRecordDecision.mock.calls[0][0];
    expect(JSON.stringify(row)).toContain('assessDependsOn');
    expect(row.modelVerdict ?? 'none').toBe('none');
  });
});
