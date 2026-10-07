import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockFireGateEvent = mock((_input: any) => 'sig');
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: mockFireGateEvent,
  GATE_SLUGS: { CLAIM_LOOP_DEFERRAL: 'claim_loop_deferral' },
}));
const mockRecordDecision = mock(async (_row: any) => {});
mock.module('@buildd/core/orchestration-ledger-source', () => ({ recordOrchestrationDecision: mockRecordDecision }));

import { buildForceStartIntent, consumeForceStart, recordForceStartClaim, HUMAN_FORCE_START_DECISION_ID } from './force-start';
import { makeWaitingReason, FORCE_START_TTL_MS } from '@buildd/core/waiting-reason';

const prReason = makeWaitingReason('pr_overlap_ended', {
  because: 'both edit packages/core/db/schema.ts',
  blocker: { type: 'pr', id: '3818', label: 'PR #3818', live: false },
  overlap: { areas: [{ area: 'core/db', count: 1 }], pathCount: 1, paths: ['packages/core/db/schema.ts'], basis: 'declared' },
  provenance: { source: 'probe', derivedFrom: 't' },
});
const now = new Date('2026-10-07T12:00:00Z');

describe('force-start', () => {
  beforeEach(() => { mockFireGateEvent.mockClear(); mockRecordDecision.mockClear(); });

  it('builds a single-use, expiring intent naming exactly the confirmed gates and their evidence', () => {
    const intent = buildForceStartIntent({ reasons: [prReason], userId: 'u1', accountId: null, now });
    expect(intent.kinds).toEqual(['pr_overlap_ended']);
    expect(intent.loopKeys).toEqual(['path_overlap']);
    expect(Date.parse(intent.expiresAt) - now.getTime()).toBe(FORCE_START_TTL_MS);
    expect(intent.blockers).toEqual([{ kind: 'pr_overlap_ended', type: 'pr', id: '3818', label: 'PR #3818', live: false, pathCount: 1, areas: [{ area: 'core/db', count: 1 }] }]);
  });

  it('consume moves the intent into a capped history, and drops a lapsed one', () => {
    const intent = buildForceStartIntent({ reasons: [prReason], userId: 'u1', accountId: null, now });
    const out = consumeForceStart({ forceStart: intent, keep: 1 }, intent, { bypassed: ['path_overlap'], at: now });
    expect(out).not.toHaveProperty('forceStart');
    expect(out.keep).toBe(1);
    expect(out.forceStartHistory).toEqual([expect.objectContaining({ id: intent.id, bypassed: ['path_overlap'], claimedAt: now.toISOString() })]);
    expect(consumeForceStart({ forceStart: { stale: true } }, null, { bypassed: [], at: now })).toEqual({});
    const untouched = { a: 1 };
    expect(consumeForceStart(untouched, null, { bypassed: [], at: now })).toBe(untouched);
  });

  it('claim writes a gate event and a gradeable human_force_start decision row (HOLD → START)', () => {
    const intent = buildForceStartIntent({ reasons: [prReason], userId: 'u1', accountId: null, now });
    recordForceStartClaim({
      intent, bypassed: ['path_overlap'], workerId: 'w1', accountId: 'acc', runner: 'runner-7', now: new Date(now.getTime() + 30_000),
      task: { id: '11111111-1111-1111-1111-111111111111', workspaceId: 'ws', missionId: null, teamId: 'team' },
    });
    expect(mockFireGateEvent.mock.calls[0][0]).toMatchObject({ outcome: 'bypassed', reason: 'force_start', workerId: 'w1' });
    const row = mockRecordDecision.mock.calls[0][0];
    expect(row).toMatchObject({
      decisionId: HUMAN_FORCE_START_DECISION_ID, capability: 'orchestration_claim', ruleVerdict: 'HOLD', effective: 'START',
      applied: true, status: 'applied', mode: 'live', candidatePolicyVersion: 'hf1.path_overlap', taskId: '11111111-1111-1111-1111-111111111111',
    });
    expect(row.receipt).toMatchObject({ actor: 'human_force', bypassed: ['path_overlap'], waitedMs: 30_000, userId: 'u1' });
  });

  it('no decision row when the gate cleared on its own before the claim', () => {
    const intent = buildForceStartIntent({ reasons: [prReason], userId: 'u1', accountId: null, now });
    recordForceStartClaim({ intent, bypassed: [], workerId: 'w1', accountId: 'acc', runner: 'r', now, task: { id: 't', workspaceId: 'ws', missionId: null, teamId: 'team' } });
    expect(mockFireGateEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});
