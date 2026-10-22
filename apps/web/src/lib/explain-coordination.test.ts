import { describe, it, expect } from 'bun:test';
import { buildCoordinationHolds, classifyHolderStall, coordinationLink, coordinationGateDetail, latestOverlapStarts, overlapStartLink, startsAlongsideWords } from './explain-coordination';

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

describe('a task that started past an overlap', () => {
  const at = '2026-10-17T10:00:00.000Z';
  const row = (detail: Record<string, unknown>) => ({ reason: 'soft_overlap_start', detail: { startedAt: at, decidedBy: 'rule', ...detail } });

  it('says it starts alongside the PR, from its open-PR start row', () => {
    const starts = latestOverlapStarts([
      row({ gate: 'open_pr_overlap', holderTaskId: 'pr-task-1', prNumber: 41, paths: ['apps/web/src/lib/x.ts'] }),
      { reason: 'path_overlap', detail: { prNumber: 41 } },
    ]);
    expect(starts).toEqual([{ gate: 'open_pr_overlap', holderTaskId: 'pr-task-1', prNumber: 41, paths: ['apps/web/src/lib/x.ts'] }]);
    const link = overlapStartLink(starts, { taskId: 't', workspaceId: 'ws' });
    expect(link?.claim).toContain('starts alongside #41 (same files, merges at the end)');
    expect(link?.refs).toMatchObject({ prNumber: 41, paths: ['apps/web/src/lib/x.ts'] });
  });

  it('names the holder task when the start row has no PR, and lists the rest of that claim', () => {
    const starts = latestOverlapStarts([
      row({ gate: 'soft_overlap', holderTaskId: 'abcdef12-3456', paths: ['apps/web/src/lib'] }),
      row({ gate: 'lease_overlap', holderTaskId: 'feedbeef-0000', paths: ['apps/web/src/lib/x.ts'] }),
      // An earlier claim's start: not this one.
      { reason: 'soft_overlap_start', detail: { startedAt: '2026-10-16T10:00:00.000Z', prNumber: 7 } },
    ]);
    expect(starts.map(s => s.gate)).toEqual(['soft_overlap', 'lease_overlap']);
    const claim = overlapStartLink(starts, {})!.claim;
    expect(claim).toContain(startsAlongsideWords('task abcdef12'));
    expect(claim).toContain('also overlaps task feedbeef');
    expect(claim).not.toContain('#7');
  });

  it('is absent without a start row', () => {
    expect(overlapStartLink(latestOverlapStarts([{ reason: 'path_overlap', detail: { prNumber: 41 } }]), {})).toBeNull();
  });
});

describe('holder stall on an inferred edge', () => {
  it('classifies deferral, credential hold and closed PR; a near start is not a stall', () => {
    const now = Date.parse('2026-10-22T00:00:00Z');
    expect(classifyHolderStall({ startAt: '2026-10-24T00:00:00Z', now })?.kind).toBe('deferred');
    expect(classifyHolderStall({ startAt: '2026-10-22T01:00:00Z', now })).toBeNull();
    expect(classifyHolderStall({ context: { credentialHold: { credentialKey: 'k', since: 's' } } })?.kind).toBe('credential_hold');
    expect(classifyHolderStall({ context: { credentialHold: { releasedAt: 'x' } } })).toBeNull();
    expect(classifyHolderStall({ prClosedUnmerged: true })?.kind).toBe('pr_closed_unmerged');
  });

  it('names the stall in the causal link', () => {
    const holds = buildCoordinationHolds({
      task: { status: 'pending', dependsOn: ['inf-1'], pathDeclaration: { inferredDependsOn: ['inf-1'] } },
      holders: new Map([['inf-1', { id: 'inf-1', title: 'Intake', status: 'pending', pathManifest: null, stall: { kind: 'credential_hold' as const, label: null } }]]),
      gateDetails: [],
    });
    expect(coordinationLink(holds, {})?.claim).toContain('held for credentials');
  });
});
