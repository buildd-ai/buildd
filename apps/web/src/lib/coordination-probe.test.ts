/**
 * The start probe's dependency, soft-overlap and local-mission reasons
 * (lib/coordination-probe.ts). The claim-loop half is covered through
 * `evaluateCoordinationGates` (claim/coordination-gates.test.ts); here the
 * reads are stubbed and the classification is what is pinned:
 *
 *  - an inferred (creation-time overlap) edge is `dep_inferred`, carrying the
 *    explain hold's paths and overlap kind; a declared edge is `dep_declared`;
 *  - a satisfied edge (the claim's own predicate says so) is not a reason;
 *  - a local mission is `mission_local` unless already handed over;
 *  - a deterministic soft overlap (migration) is `serialized_surface`.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

let depRow: Record<string, boolean> = {};
let softGateRows: Array<{ detail: unknown }> = [];
const chain = (rows: () => unknown[]) => {
  const c: any = {
    from: () => c, where: () => c, orderBy: () => c,
    limit: () => Object.assign(Promise.resolve(rows()), { catch: () => Promise.resolve(rows()) }),
  };
  return c;
};
mock.module('@buildd/core/db', () => ({
  db: {
    select: (cols?: Record<string, unknown>) => chain(() => (cols && 'd0' in cols ? [depRow] : cols && 'detail' in cols && !('occurredAt' in cols) ? softGateRows : [])),
    query: {
      workers: { findMany: async () => [] },
      tasks: { findMany: async () => [] },
    },
  },
}));

let holds: any[] = [];
mock.module('@/lib/explain', () => ({ loadTaskCoordinationHolds: async () => holds }));
mock.module('@/app/api/workers/claim/coordination-snapshot', () => ({
  loadOpenPrTasksByWorkspace: async () => new Map(),
  loadMissionCoordination: async () => ({ missionClaimMap: new Map(), missionActiveCountMap: new Map(), missionAdvisoryInFlight: new Map(), missionInFlightRows: [] }),
}));
mock.module('@buildd/core/path-claim', () => ({ getActiveClaimsByWorkspace: async () => new Map() }));
let local = false;
mock.module('@/app/api/workers/claim/held-gate', () => ({ checkMissionLocal: async () => local }));
let softHolders = new Map<string, any>();
mock.module('@/app/api/workers/claim/soft-overlap-store', () => ({ loadSoftOverlapHolders: async () => softHolders }));
mock.module('@/app/api/workers/claim/hold-start-shadow', () => ({ touchesHardOverlapSurface: () => false }));

const { probeCoordination } = await import('./coordination-probe');

const base = { id: 'task-1', workspaceId: 'ws', missionId: null as string | null, pathManifest: ['packages/core/db/schema.ts'], context: {}, status: 'pending' };

beforeEach(() => {
  depRow = {}; holds = []; local = false; softHolders = new Map(); softGateRows = [];
});

describe('probeCoordination: dependencies, soft overlaps, local missions', () => {
  it('splits inferred overlap edges from declared ones; a satisfied edge is no reason', async () => {
    const task = { ...base, dependsOn: ['h1', 'h2', 'd1', 'done'], pathDeclaration: { inferredDependsOn: ['h1', 'h2'] } };
    depRow = { d0: false, d1: false, d2: false, d3: true };
    holds = [
      { edge: 'inferred_dependency', holderTaskId: 'h1', holderTitle: 'A', holderStatus: 'in_progress', prNumber: null, paths: ['packages/core/db/schema.ts'], verdict: null, overlapKind: 'migration' },
      { edge: 'inferred_dependency', holderTaskId: 'h2', holderTitle: 'B', holderStatus: 'pending', prNumber: null, paths: ['packages/core/db/schema.ts'], verdict: null, overlapKind: 'migration' },
      { edge: 'declared_dependency', holderTaskId: 'd1', holderTitle: 'C', holderStatus: 'pending', prNumber: null, paths: [], verdict: null, overlapKind: null },
    ];
    const reasons = (await probeCoordination(task as any))!;
    const byBlocker = Object.fromEntries(reasons.map(r => [r.blocker?.id, r]));
    expect(byBlocker.h1.kind).toBe('dep_inferred');
    expect(byBlocker.h1.overlap?.overlapKind).toBe('migration');
    expect(byBlocker.h1.overlap?.areas).toEqual([{ area: 'core/db', count: 1 }]);
    expect(byBlocker.h1.blocker?.live).toBe(true);
    expect(byBlocker.h2.blocker?.live).toBe(false);
    expect(byBlocker.d1.kind).toBe('dep_declared');
    expect(byBlocker.d1.action.force).toBeNull();
    expect(byBlocker.done).toBeUndefined();
  });

  it('a local mission is a forceable mission_local reason, unless the caller already lifted it', async () => {
    local = true;
    const task = { ...base, missionId: 'm1', dependsOn: [] };
    const reasons = (await probeCoordination(task as any))!;
    expect(reasons.map(r => r.kind)).toEqual(['mission_local']);
    expect(reasons[0].action.force?.mechanism).toBe('start_context');
    expect(await probeCoordination(task as any, new Date(), { skipMissionLocal: true })).toEqual([]);
    expect(await probeCoordination({ ...task, context: { bypassHeldGate: true } } as any)).toEqual([]);
  });

  it('a migration soft overlap with an in-flight holder is a serialized surface, forceable for claim order', async () => {
    softHolders = new Map([['h9', { id: 'h9', status: 'in_progress', pathManifest: ['packages/core/drizzle/'], title: 'H', workerStatus: 'running' }]]);
    const task = { ...base, pathManifest: ['packages/core/drizzle/0002_y.sql'], dependsOn: [], pathDeclaration: { softOverlaps: [{ taskId: 'h9', paths: ['packages/core/drizzle/'] }] } };
    const reasons = (await probeCoordination(task as any))!;
    const soft = reasons.find(r => r.blocker?.id === 'h9');
    expect(soft?.kind).toBe('serialized_surface');
    expect(soft?.overlap?.overlapKind).toBe('migration');
    expect(soft?.action.force?.lifts).toBe('serialized_surface');
  });

  it('no dependencies, no overlaps, not local: nothing holds it', async () => {
    expect(await probeCoordination({ ...base, dependsOn: [] } as any)).toEqual([]);
  });
});
