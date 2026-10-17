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

it('keeps human and Jev ledger actors separate within the same policy fingerprint', () => {
 const rows = ['human_force', 'jev_start'].map(actor => ({ ...decisionRows[0], actor, gate: 'overlap', areaClass: 'other' }));
 const stats = rollupOrchestrationDecisions(rows, []);
 expect(stats.decisions.byGroup).toHaveLength(2);
 expect(stats.decisions.byGroup.map(g => g.actor).sort()).toEqual(['human_force', 'jev_start']);
});

it('reports the share of overlap STARTs whose PR later hit a merge conflict, by area class and gate', async () => {
 reads = 0;
 const at = new Date('2026-10-01T10:00:00Z');
 const loaded: string[] = [];
 const loadSoftStarts = async ({ workspaceId }: { workspaceId: string }) => {
  loaded.push(workspaceId);
  return {
   starts: [{ id: 'e1', taskId: 'bad', workspaceId, holderTaskId: 'h', decidedBy: 'rule' as const, riskTier: null, startedAt: at, gate: 'open_pr_overlap', areaClass: 'other' as const }],
   outcome: {
    tasks: [{ id: 'bad', workspaceId, status: 'completed' }], labels: [], gateEvents: [],
    prs: [{ taskId: 'bad', workspaceId, prNumber: 2, headSha: null, baseRef: null, mergedAt: new Date(at.getTime() + 3_600_000), lifecycle: 'merged' }],
    conflictTasks: [{ id: 'c', workspaceId, prNumber: 2, headSha: null, createdAt: new Date(at.getTime() + 60_000) }],
   } as any,
   probes: [],
  };
 };
 const stats = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], window: '7d' }, { loadSoftStarts });
 expect(stats.overlapStartsError).toBeUndefined();
 expect(loaded).toEqual(['ws']);
 expect(stats.overlapStarts?.total).toMatchObject({ starts: 1, observed: 1, conflicted: 1, conflictShare: 1 });
 expect(stats.overlapStarts?.cells.find(c => c.gate === 'open_pr_overlap')).toMatchObject({ areaClass: 'other', conflictShare: 1 });

 reads = 0;
 const scoped = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], missionId: 'm', window: '7d' }, { loadSoftStarts });
 expect(scoped.overlapStarts).toBeUndefined();

 reads = 0;
 const failed = await fetchOrchestrationDecisionStats({ workspaceIds: ['ws'], window: '7d' }, { loadSoftStarts: async () => { throw new Error('down'); } });
 expect(failed.overlapStarts).toBeUndefined();
 expect(failed.overlapStartsError).toBe('down');
});
