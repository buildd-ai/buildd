import { describe, it, expect } from 'bun:test';
import { evaluateCoordinationGates, findActiveClaimBlocker, type CoordinationSnapshot } from './coordination-gates';

const snap = (over: Partial<CoordinationSnapshot> = {}): CoordinationSnapshot => ({
  openPrTasks: [],
  activeClaims: null,
  mission: null,
  missionActiveCount: 0,
  missionAdvisoryInFlight: null,
  orderedBehind: null,
  liveTaskIds: new Set(),
  now: new Date('2026-10-07T12:00:00Z'),
  ...over,
});
const pr = (over: Record<string, unknown> = {}) => ({
  taskId: 'pr-task', pathManifest: ['packages/core/db/schema.ts'], prNumber: 3818, prUrl: 'https://github.com/o/r/pull/3818',
  workerStatus: 'running', prLifecycle: 'open', branch: 'b', prBaseRef: 'dev', ...over,
});
const task = (over: Record<string, unknown> = {}) => ({ id: 't1', workspaceId: 'ws', missionId: null, pathManifest: ['packages/core/db/schema.ts'], context: {}, ...over });

describe('evaluateCoordinationGates', () => {
  it('open PR with a live writer → pr_overlap_live naming the PR and the file', () => {
    const [r] = evaluateCoordinationGates(task(), snap({ openPrTasks: [pr()] }));
    expect(r.kind).toBe('pr_overlap_live');
    expect(r.blocker).toMatchObject({ type: 'pr', id: '3818', label: 'PR #3818', live: true });
    expect(r.because).toBe('both edit packages/core/db/schema.ts');
    expect(r.overlap?.areas).toEqual([{ area: 'core/db', count: 1 }]);
    expect(r.action.force?.lifts).toBe('pr_overlap_live');
  });

  it('writer ended → pr_overlap_ended', () => {
    expect(evaluateCoordinationGates(task(), snap({ openPrTasks: [pr({ workerStatus: 'completed' })] }))[0].kind).toBe('pr_overlap_ended');
  });

  it('own PR and disjoint files never block', () => {
    expect(evaluateCoordinationGates(task(), snap({ openPrTasks: [pr({ taskId: 't1' })] }))).toEqual([]);
    expect(evaluateCoordinationGates(task({ pathManifest: ['apps/runner/x.ts'] }), snap({ openPrTasks: [pr()] }))).toEqual([]);
  });

  it('live lease held by another task → lease_overlap', () => {
    const reasons = evaluateCoordinationGates(task(), snap({ activeClaims: new Map([['h', ['packages/core/db/schema.ts']]]), liveTaskIds: new Set(['h']) }));
    expect(reasons.map(r => r.kind)).toEqual(['lease_overlap']);
    expect(reasons[0].blocker).toMatchObject({ id: 'h', live: true });
  });

  it('mission concurrency, pacing, and the scope-undeclared mutex', () => {
    const mission = { status: 'active', maxConcurrentTasks: 2, pacingMode: 'paced' as const, pacingMaxPerHour: 1, lastTaskStartedAt: new Date('2026-10-07T11:50:00Z') };
    const kinds = evaluateCoordinationGates(task({ missionId: 'm', pathManifest: ['**'] }), snap({ mission, missionActiveCount: 2, missionAdvisoryInFlight: new Set(['peer']) })).map(r => r.kind);
    expect(kinds).toEqual(['mission_concurrent', 'mission_paced', 'scope_undeclared_mutex']);
  });

  it('reviews skip mission concurrency/pacing, and a non-editing task skips the mutex', () => {
    const mission = { status: 'active', maxConcurrentTasks: 1, pacingMode: 'eager' as const, pacingMaxPerHour: null, lastTaskStartedAt: null };
    const s = snap({ mission, missionActiveCount: 5, missionAdvisoryInFlight: new Set(['peer']) });
    const review = task({ missionId: 'm', category: 'review', context: { reviewerFor: 'pr-1' }, pathManifest: null });
    expect(evaluateCoordinationGates(review, s)).toEqual([]);
    const research = task({ missionId: 'm', pathManifest: null, outputRequirement: 'artifact_required' });
    expect(evaluateCoordinationGates(research, s).map(r => r.kind)).toEqual(['mission_concurrent']);
  });

  it('planner order only while its blocker is live, and soft', () => {
    const ob = { blockedBy: 'a', edge: 'path_overlap', since: null };
    expect(evaluateCoordinationGates(task({ pathManifest: null }), snap({ orderedBehind: ob }))).toEqual([]);
    const [r] = evaluateCoordinationGates(task({ pathManifest: null }), snap({ orderedBehind: ob, liveTaskIds: new Set(['a']) }));
    expect(r).toMatchObject({ kind: 'ordered_behind', strength: 'soft' });
  });
});

describe('findActiveClaimBlocker', () => {
  it('ignores own claims and sentinel-only claims or manifests', () => {
    const claims = new Map([['t1', ['a.ts']], ['other', ['**']]]);
    expect(findActiveClaimBlocker('t1', ['a.ts'], claims)).toBeNull();
    expect(findActiveClaimBlocker('t1', ['**'], new Map([['x', ['a.ts']]]))).toBeNull();
    expect(findActiveClaimBlocker('t1', ['**', 'a.ts'], new Map([['x', ['a.ts', 'b.ts']]]))).toEqual({ holderTaskId: 'x', claimedPaths: ['a.ts', 'b.ts'], overlapPaths: ['a.ts'] });
  });
});
