import { expect, it, mock } from 'bun:test';
const manifestRows = [{ workspaceId: 'ws', missionId: 'mission', kind: 'engineering', total: 4, concrete: 2, advisory: 1, none: 1 }];
const claimRows = [{ surface: 'mcp:check_path_claim', claimed: 2, blocked: 1, deadlock: 1, rejected: 1, firstRecordedAt: '2026-09-30' }];
const selections: any[] = [];
let reads = 0;
let workspaceRows = [{ id: 'ws', team: { enabledDecisionShadows: ['orchestration_claim'] as string[] | null } }];
mock.module('@buildd/core/db', () => ({ db: {
 query: { workspaces: { findMany: async () => workspaceRows } },
 select(fields: any) {
  selections.push(fields);
  return { from: () => ({ where: () => ({ groupBy: async () => ++reads % 2 ? manifestRows : claimRows }) }) };
 },
} }));
const { fetchCoordinationStats } = await import('./coordination-stats-query');
it('combines grouped results and preserves all four call outcomes', async () => {
 const stats = await fetchCoordinationStats({ workspaceIds: ['ws'], window: '7d' });
 expect(stats.manifestCoverage).toMatchObject({ total: 4, concreteShare: 0.5 });
 expect(stats.manifestCoverage.groups[0]).toMatchObject({ kind: 'engineering', missionId: 'mission', none: 1 });
 expect(stats.pathClaims).toMatchObject({ calls: 5, claimed: 2, blocked: 1, deadlock: 1, rejected: 1 });
 expect(stats.pathClaims.coverage.completeHistoricalCalls).toBe(false);
});
it('returns empty populations without issuing queries for an empty scope', async () => {
 const before = selections.length;
 const stats = await fetchCoordinationStats({ workspaceIds: [], window: '24h' });
 expect(stats.manifestCoverage.concreteShare).toBeNull();
 expect(stats.pathClaims.calls).toBe(0);
 expect(selections.length).toBe(before);
});

it('distinguishes disabled orchestration capabilities from empty evidence', async () => {
 const stats = await fetchCoordinationStats({ workspaceIds: ['ws'], window: '7d' });
 expect(stats.manifestCoverage.decisionCapabilities).toEqual([
  { workspaceId: 'ws', capability: 'orchestration_manifest', status: 'capability_disabled' },
  { workspaceId: 'ws', capability: 'orchestration_claim', status: 'enabled' },
 ]);
 expect(stats.pathClaims.decisionCapabilities).toEqual(stats.manifestCoverage.decisionCapabilities);
});

it('reports each workspace independently when a team has never opted in', async () => {
 workspaceRows = [
  { id: 'ws', team: { enabledDecisionShadows: ['orchestration_claim'] } },
  { id: 'other', team: { enabledDecisionShadows: null } },
 ];
 const stats = await fetchCoordinationStats({ workspaceIds: ['ws', 'other'], window: '24h' });
 expect(stats.manifestCoverage.decisionCapabilities?.filter(c => c.workspaceId === 'other')).toEqual([
  { workspaceId: 'other', capability: 'orchestration_manifest', status: 'capability_disabled' },
  { workspaceId: 'other', capability: 'orchestration_claim', status: 'capability_disabled' },
 ]);
});
