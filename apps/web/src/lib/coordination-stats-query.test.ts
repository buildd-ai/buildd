import { expect, it, mock } from 'bun:test';
import { OPT_IN_CAPABILITIES } from '@buildd/core/inference-policy';
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

it('distinguishes disabled opt-in capabilities from empty evidence', async () => {
 const stats = await fetchCoordinationStats({ workspaceIds: ['ws'], window: '7d' });
 const caps = stats.manifestCoverage.decisionCapabilities!;
 expect(caps.map(c => c.capability)).toEqual([...OPT_IN_CAPABILITIES]);
 expect(caps.find(c => c.capability === 'task_role_shadow')?.status).toBe('capability_disabled');
 expect(caps.filter(c => c.status === 'enabled').map(c => c.capability)).toEqual(['orchestration_claim']);
 expect(stats.pathClaims.decisionCapabilities).toEqual(stats.manifestCoverage.decisionCapabilities);
});

it('reports each workspace independently when a team has never opted in', async () => {
 workspaceRows = [
  { id: 'ws', team: { enabledDecisionShadows: ['orchestration_claim'] } },
  { id: 'other', team: { enabledDecisionShadows: null } },
 ];
 const stats = await fetchCoordinationStats({ workspaceIds: ['ws', 'other'], window: '24h' });
 expect(stats.manifestCoverage.decisionCapabilities?.filter(c => c.workspaceId === 'other')).toEqual([
  ...OPT_IN_CAPABILITIES.map(capability => ({ workspaceId: 'other', capability, status: 'capability_disabled' })),
 ]);
});
