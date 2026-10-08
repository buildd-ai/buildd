import { describe, it, expect } from 'bun:test';
import { buildCoordinationHolds, coordinationLink, coordinationGateDetail } from './explain-coordination';

/**
 * `explain` for a task held on coordination: who holds what, on which paths,
 * and why (edge kind and verdict). Pure: the loader lives in explain.ts.
 */

const holders = new Map([
  ['dep-1', { id: 'dep-1', title: 'Declared upstream', status: 'in_progress', pathManifest: ['docs/a.md'] }],
  ['inf-1', { id: 'inf-1', title: 'Same file writer', status: 'pending', pathManifest: ['apps/web/src/lib/x.ts'] }],
  ['soft-1', { id: 'soft-1', title: 'Directory neighbour', status: 'in_progress', pathManifest: ['scripts/run.ts'] }],
  ['done-1', { id: 'done-1', title: 'Finished', status: 'completed', pathManifest: ['scripts/old.ts'] }],
  ['lease-1', { id: 'lease-1', title: 'Lease holder', status: 'in_progress', pathManifest: ['scripts/lease.ts'] }],
]);

const task = (over: Record<string, unknown> = {}) => ({
  status: 'pending',
  dependsOn: ['dep-1', 'inf-1'],
  pathManifest: ['apps/web/src/lib/x.ts', 'scripts/'],
  pathDeclaration: {
    inferredDependsOn: ['inf-1'],
    overlapPolicy: 'v2',
    softOverlaps: [{ taskId: 'soft-1', paths: [], kind: 'prefix' }, { taskId: 'done-1', paths: [], kind: 'prefix' }],
  },
  ...over,
});

describe('buildCoordinationHolds', () => {
  it('names each holder with its edge kind, paths and verdict', () => {
    const holds = buildCoordinationHolds({
      task: task(),
      holders,
      gateDetails: [
        { reason: 'soft_overlap', detail: { holderTaskId: 'soft-1', paths: ['scripts', 'scripts/run.ts'], verdict: 'HOLD' } },
        { reason: 'soft_overlap', detail: { holderTaskId: 'soft-1', paths: ['scripts'], verdict: 'deterministic_hold' } },
      ],
    });
    expect(holds).toEqual([
      expect.objectContaining({ edge: 'declared_dependency', holderTaskId: 'dep-1', holderTitle: 'Declared upstream', holderStatus: 'in_progress', paths: [] }),
      expect.objectContaining({ edge: 'inferred_dependency', holderTaskId: 'inf-1', overlapKind: 'exact_file', paths: ['apps/web/src/lib/x.ts'] }),
      expect.objectContaining({ edge: 'soft_overlap', holderTaskId: 'soft-1', verdict: 'HOLD', paths: ['scripts', 'scripts/run.ts'] }),
    ]);
  });

  it('the newest path_overlap deferral names the lease holder or the open PR', () => {
    const lease = buildCoordinationHolds({
      task: task({ dependsOn: [], pathDeclaration: null }),
      holders,
      gateDetails: [{ reason: 'path_overlap', detail: { blockingTaskId: 'lease-1', prNumber: null } }],
    });
    expect(lease).toEqual([expect.objectContaining({ edge: 'path_lease', holderTaskId: 'lease-1', holderTitle: 'Lease holder', paths: ['scripts', 'scripts/lease.ts'] })]);

    const pr = buildCoordinationHolds({
      task: task({ dependsOn: [], pathDeclaration: null }),
      holders,
      gateDetails: [{ reason: 'path_overlap', detail: { prNumber: 41, prUrl: 'u' } }],
    });
    expect(pr).toEqual([expect.objectContaining({ edge: 'open_pr', prNumber: 41, holderTaskId: null })]);
  });

  it('a task that is not pending holds nothing', () => {
    expect(buildCoordinationHolds({ task: task({ status: 'in_progress' }), holders, gateDetails: [] })).toEqual([]);
  });
});

describe('coordinationLink', () => {
  it('says who holds what and why', () => {
    const holds = buildCoordinationHolds({
      task: task({ dependsOn: [] }),
      holders,
      gateDetails: [{ reason: 'soft_overlap', detail: { holderTaskId: 'soft-1', paths: ['scripts'], verdict: 'HOLD' } }],
    });
    const l = coordinationLink(holds, { taskId: 't', workspaceId: 'w' })!;
    expect(l.claim).toContain('Directory neighbour');
    expect(l.claim).toContain('scripts');
    expect(l.claim).toContain('HOLD');
    expect(l.refs).toMatchObject({ taskId: 'soft-1', paths: ['scripts'] });
    expect(coordinationLink([], { taskId: 't' })).toBeNull();
  });
});

describe('coordinationGateDetail', () => {
  it('keeps only the ownership fields of a gate row', () => {
    expect(coordinationGateDetail({ holderTaskId: 'h', paths: ['a', 7], verdict: 'HOLD', consecutiveDeferrals: 3, secret: 'x' }))
      .toEqual({ holderTaskId: 'h', paths: ['a'], verdict: 'HOLD' });
    expect(coordinationGateDetail({ consecutiveDeferrals: 3 })).toBeNull();
  });
});
