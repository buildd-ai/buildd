/**
 * The start probe's dependency and local-mission reasons
 * (lib/coordination-probe.ts). The claim-loop half is covered through
 * `evaluateCoordinationGates` (claim/coordination-gates.test.ts); here the
 * reads are stubbed and the classification is what is pinned:
 *
 *  - every unmet edge is `dep_declared`, naming its dependency's status: no
 *    edge is read as a guessed overlap (spec: Overlap scheduling, R-1);
 *  - a satisfied edge (the claim's own predicate says so) is not a reason;
 *  - a local mission is `mission_local` unless already handed over;
 *  - a stored soft overlap holds nothing (spec: Overlap scheduling, R-2).
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
      tasks: { findMany: async () => depStatuses },
    },
  },
}));

let depStatuses: Array<{ id: string; status: string; title?: string }> = [];
mock.module('@/app/api/workers/claim/coordination-snapshot', () => ({
  loadOpenPrTasksByWorkspace: async () => new Map(),
  loadMissionCoordination: async () => ({ missionClaimMap: new Map(), missionActiveCountMap: new Map(), missionInFlightRows: [] }),
}));
mock.module('@buildd/core/path-claim', () => ({ getActiveClaimsByWorkspace: async () => new Map() }));
let local = false;
mock.module('@/app/api/workers/claim/held-gate', () => ({ checkMissionLocal: async () => local }));

const { probeCoordination } = await import('./coordination-probe');

const base = { id: 'task-1', workspaceId: 'ws', missionId: null as string | null, pathManifest: ['packages/core/db/schema.ts'], context: {}, status: 'pending' };

beforeEach(() => {
  depRow = {}; depStatuses = []; local = false; softGateRows = [];
});

describe('probeCoordination: dependencies, local missions', () => {
  // 2026-10-22: a task declared on a running task read "next in line".
  it('every unmet edge is a declared dependency naming its status, even one stored as inferred; a satisfied edge is no reason', async () => {
    const task = { ...base, dependsOn: ['h1', 'd1', 'done'], pathDeclaration: { inferredDependsOn: ['h1'] } };
    depRow = { d0: false, d1: false, d2: true };
    depStatuses = [{ id: 'h1', status: 'in_progress' }, { id: 'd1', status: 'pending' }];
    const reasons = (await probeCoordination(task as any))!;
    expect(reasons.map(r => r.kind)).toEqual(['dep_declared', 'dep_declared']);
    const byBlocker = Object.fromEntries(reasons.map(r => [r.blocker?.id, r]));
    expect(byBlocker.h1.blocker).toMatchObject({ live: true, status: 'in_progress' });
    expect(byBlocker.d1.blocker).toMatchObject({ live: false, status: 'pending' });
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

  it('a stored soft overlap, even on a migration path, is no reason: only lanes hold at claim', async () => {
    const task = { ...base, pathManifest: ['packages/core/drizzle/0002_y.sql'], dependsOn: [], pathDeclaration: { softOverlaps: [{ taskId: 'h9', paths: ['packages/core/drizzle/'] }] } };
    expect(await probeCoordination(task as any)).toEqual([]);
  });

  it('no dependencies, no overlaps, not local: nothing holds it', async () => {
    expect(await probeCoordination({ ...base, dependsOn: [] } as any)).toEqual([]);
  });
});
