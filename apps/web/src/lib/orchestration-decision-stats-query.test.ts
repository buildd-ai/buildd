import { expect, it, mock } from 'bun:test';
import { OPT_IN_CAPABILITIES } from '@buildd/core/inference-policy';
const decisionRows = [
 { capability: 'orchestration_claim', decisionId: 'claim.hold', fingerprint: 'aaa', candidatePolicyVersion: 'p1', experimentArm: 'observe', mode: 'shadow',
   day: '2026-10-01', total: 3, applied: 0, suggested: 2, fallback: 1, labelled: 1, firstAt: '2026-10-01 01:00:00+00', lastAt: '2026-10-01 05:00:00+00' },
 { capability: 'orchestration_claim', decisionId: 'claim.hold', fingerprint: 'aaa', candidatePolicyVersion: 'p1', experimentArm: 'observe', mode: 'shadow',
   day: '2026-10-02', total: 2, applied: 0, suggested: 2, fallback: 0, labelled: 0, firstAt: '2026-10-02 01:00:00+00', lastAt: '2026-10-02 03:00:00+00' },
 { capability: 'orchestration_manifest', decisionId: 'manifest.pick', fingerprint: 'bbb', candidatePolicyVersion: 'p1', experimentArm: 'apply', mode: 'shadow',
   day: '2026-10-02', total: 1, applied: 1, suggested: 0, fallback: 0, labelled: 1, firstAt: '2026-10-02 02:00:00+00', lastAt: '2026-10-02 02:00:00+00' },
];
const reasonRows = [{ capability: 'orchestration_claim', status: 'fallback', reason: 'deadline', total: 1 }];
const predictionRows = [
 { day: '2026-10-02', stopReason: 'done', total: 2, complete: 2, unknownScope: 0, allApplied: 0, labelled: 1 },
 { day: '2026-10-02', stopReason: 'deadline', total: 1, complete: 0, unknownScope: 1, allApplied: 0, labelled: 0 },
];
const results = [decisionRows, reasonRows, predictionRows];
let reads = 0;
const selections: any[] = [];
mock.module('@buildd/core/db', () => ({ db: {
 query: { workspaces: { findMany: async () => [{ id: 'ws', team: { enabledDecisionShadows: null } }] } },
 select(fields: any) {
  selections.push(fields);
  return { from: () => ({ where: () => ({ groupBy: async () => results[reads++ % 3] }) }) };
 },
} }));
const { fetchOrchestrationDecisionStats, rollupOrchestrationDecisions } = await import('./orchestration-decision-stats-query');

it('rolls decision rows up by group, day and labelled split', async () => {
 const stats = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], window: '7d' });
 expect(stats.decisions).toMatchObject({ total: 6, applied: 1, suggested: 4, fallback: 1, labelled: 2, unlabelled: 4 });
 expect(stats.decisions.firstAt).toBe('2026-10-01 01:00:00+00');
 expect(stats.decisions.lastAt).toBe('2026-10-02 03:00:00+00');
 expect(stats.decisions.byGroup).toHaveLength(2);
 expect(stats.decisions.byGroup[0]).toMatchObject({ decisionId: 'claim.hold', fingerprint: 'aaa', total: 5, labelled: 1, unlabelled: 4 });
 expect(stats.decisions.byDay.map(d => [d.day, d.capability, d.total])).toEqual([
  ['2026-10-01', 'orchestration_claim', 3],
  ['2026-10-02', 'orchestration_claim', 2],
  ['2026-10-02', 'orchestration_manifest', 1],
 ]);
 expect(stats.decisions.byReason).toEqual([{ capability: 'orchestration_claim', status: 'fallback', reason: 'deadline', total: 1 }]);
});

it('rolls manifest predictions up by day and stop reason', async () => {
 reads = 0;
 const stats = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], window: '7d' });
 expect(stats.manifestPredictions).toMatchObject({ total: 3, complete: 2, unknownScope: 1, labelled: 1, unlabelled: 2 });
 expect(stats.manifestPredictions.byDay).toEqual([{ day: '2026-10-02', total: 3, complete: 2, unknownScope: 1, allApplied: 0, labelled: 1, unlabelled: 2 }]);
 expect(stats.manifestPredictions.byStopReason).toEqual([{ stopReason: 'done', total: 2 }, { stopReason: 'deadline', total: 1 }]);
});

it('reports opt-in state so zero rows are distinguishable from a disabled capability', async () => {
 reads = 0;
 const stats = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], window: '24h' });
 expect(stats.decisionCapabilities).toEqual(OPT_IN_CAPABILITIES.map(capability => ({ workspaceId: 'ws', capability, status: 'capability_disabled' })));
 expect(stats.coverage.note).toContain('enabledDecisionShadows');
});

it('returns an empty ledger without querying for an empty scope', async () => {
 const before = selections.length;
 const stats = await fetchOrchestrationDecisionStats({ workspaceIds: [], window: '30d' });
 expect(selections.length).toBe(before);
 expect(stats.decisions.total).toBe(0);
 expect(stats.decisions.firstAt).toBeNull();
 expect(stats.manifestPredictions.total).toBe(0);
 expect(stats.window).toBe('30d');
});

it('rollup treats string counts from the driver as numbers', () => {
 const rolled = rollupOrchestrationDecisions([{ ...decisionRows[0], total: '3' as any, labelled: '1' as any }], []);
 expect(rolled.decisions.total).toBe(3);
 expect(rolled.decisions.unlabelled).toBe(2);
});
