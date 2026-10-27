import { describe, it, expect } from 'bun:test';
import { evaluateCoordinationGates, findActiveClaimBlocker, type CoordinationSnapshot } from './coordination-gates';

const snap = (over: Partial<CoordinationSnapshot> = {}): CoordinationSnapshot => ({
  openPrTasks: [],
  activeClaims: null,
  mission: null,
  missionActiveCount: 0,
  orderedBehind: null,
  liveTaskIds: new Set(),
  now: new Date('2026-10-07T12:00:00Z'),
  ...over,
});
const pr = (over: Record<string, unknown> = {}) => ({
  taskId: 'pr-task', pathManifest: ['packages/core/db/schema.ts'], prNumber: 1234, prUrl: 'https://github.com/o/r/pull/1234',
  workerStatus: 'running', prLifecycle: 'open', branch: 'b', prBaseRef: 'dev', ...over,
});
const task = (over: Record<string, unknown> = {}) => ({ id: 't1', workspaceId: 'ws', missionId: null, pathManifest: ['packages/core/db/schema.ts'], context: {}, ...over });

describe('evaluateCoordinationGates', () => {
  // 2026-10-22: a migration task refused every poll behind unmerged work read
  // "next in line". The open-PR backstop holds only on lane paths, so it is a
  // lane wait naming the PR, never a guessed file overlap, and never forced.
  it('open PR on a lane path → a lane wait naming the PR and the file, with no Force start', () => {
    const [r] = evaluateCoordinationGates(task(), snap({ openPrTasks: [pr()] }));
    expect(r.kind).toBe('lane');
    expect(r.lane).toEqual({ lane: 'migration', holderTaskId: 'pr-task', position: null });
    expect(r.blocker).toMatchObject({ type: 'pr', id: '1234', label: 'PR #1234', live: true });
    expect(r.because).toBe('both edit packages/core/db/schema.ts, and PR #1234 holds the lane until it merges or closes');
    expect(r.overlap?.areas).toEqual([{ area: 'core/db', count: 1 }]);
    expect(r.action.force).toBeNull();
  });

  it('writer ended: still the lane, the PR not live', () => {
    const [r] = evaluateCoordinationGates(task(), snap({ openPrTasks: [pr({ workerStatus: 'completed' })] }));
    expect(r.kind).toBe('lane');
    expect(r.blocker?.live).toBe(false);
  });

  it('own PR and disjoint files never block', () => {
    expect(evaluateCoordinationGates(task(), snap({ openPrTasks: [pr({ taskId: 't1' })] }))).toEqual([]);
    expect(evaluateCoordinationGates(task({ pathManifest: ['apps/runner/x.ts'] }), snap({ openPrTasks: [pr()] }))).toEqual([]);
  });

  // Same overlap policy as the claim (./overlap-policy).
  it('an open PR or live lease sharing only a mergeable file holds nothing: the claim starts it alongside', () => {
    const file = ['apps/web/src/lib/x.ts'];
    expect(evaluateCoordinationGates(task({ pathManifest: file }), snap({ openPrTasks: [pr({ pathManifest: file })] }))).toEqual([]);
    expect(evaluateCoordinationGates(task({ pathManifest: file }), snap({ activeClaims: new Map([['h', file]]) }))).toEqual([]);
  });

  it('live lease on a lane path held by another task → a lane wait naming it', () => {
    const reasons = evaluateCoordinationGates(task(), snap({ activeClaims: new Map([['h', ['packages/core/db/schema.ts']]]), liveTaskIds: new Set(['h']) }));
    expect(reasons.map(r => r.kind)).toEqual(['lane']);
    expect(reasons[0].lane).toEqual({ lane: 'migration', holderTaskId: 'h', position: null });
    expect(reasons[0].blocker).toMatchObject({ id: 'h', live: true });
  });

  it('mission concurrency holds an undeclared task; undeclared scope alone never does', () => {
    const mission = { status: 'active', maxConcurrentTasks: 2 };
    const kinds = evaluateCoordinationGates(task({ missionId: 'm', pathManifest: ['**'] }), snap({ mission, missionActiveCount: 2 })).map(r => r.kind);
    expect(kinds).toEqual(['mission_concurrent']);
    const free = { status: 'active', maxConcurrentTasks: 5 };
    for (const pathManifest of [null, [], ['**']]) {
      expect(evaluateCoordinationGates(task({ missionId: 'm', pathManifest }), snap({ mission: free, missionActiveCount: 3 }))).toEqual([]);
    }
  });

  it('reviews skip mission concurrency', () => {
    const mission = { status: 'active', maxConcurrentTasks: 1 };
    const s = snap({ mission, missionActiveCount: 5 });
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

describe('serial lanes in the probe (spec: Overlap scheduling, I-1, I-3, I-4, I-7)', () => {
  const at = (h: number) => new Date(Date.parse('2026-10-07T12:00:00Z') + h * 3600_000);
  const m = (taskId: string, o: Record<string, unknown> = {}) => ({
    taskId, claimableSince: at(-10), priority: 0, createdAt: at(-20), heldAt: null, holding: false, ready: true,
    status: 'pending', prNumber: null, prUrl: null, lastActivityAt: null, ...o,
  });
  const lanes = (members: ReturnType<typeof m>[], released: string[] = []) => ({
    views: new Map([['migration', { workspaceId: 'ws', lane: 'migration', members: members as never }]]),
    releasedTaskIds: new Set(released),
  });

  it('a held lane is one lane naming the holder and the position, not an overlap', () => {
    const reasons = evaluateCoordinationGates(task(), snap({
      openPrTasks: [pr()],
      lanes: lanes([m('pr-task', { holding: true, heldAt: at(-2), prNumber: 1234, lastActivityAt: at(-1) }), m('other', { claimableSince: at(-9) }), m('t1', { claimableSince: at(-8) })]),
    }));
    expect(reasons.map(r => r.kind)).toEqual(['lane']);
    expect(reasons[0].lane).toEqual({ lane: 'migration', holderTaskId: 'pr-task', position: 2 });
    expect(reasons[0].because).toContain('position 2');
    expect(reasons[0].blocker).toMatchObject({ type: 'task', id: 'pr-task' });
  });

  it('a stuck holder is named as stuck', () => {
    const [r] = evaluateCoordinationGates(task(), snap({ lanes: lanes([m('h', { holding: true, heldAt: at(-40), prNumber: 9, lastActivityAt: at(-30) }), m('t1')]) }));
    expect(r.lane?.stuckSince).toBe(at(-30).toISOString());
    expect(r.because).toContain('no activity since');
  });

  it('free lane, ready task ahead: waits behind it; parked task ahead: nothing holds', () => {
    const behind = evaluateCoordinationGates(task(), snap({ lanes: lanes([m('first'), m('t1', { claimableSince: at(-5) })]) }));
    expect(behind[0]).toMatchObject({ kind: 'lane', lane: { position: 1, holderTaskId: null } });
    expect(evaluateCoordinationGates(task(), snap({ lanes: lanes([m('first', { ready: false }), m('t1', { claimableSince: at(-5) })]) }))).toEqual([]);
  });

  it('a holder a person released holds nobody, its open PR included', () => {
    expect(evaluateCoordinationGates(task(), snap({ openPrTasks: [pr()], lanes: lanes([m('t1')], ['pr-task']) }))).toEqual([]);
  });

  it('an own-PR repair is in no lane', () => {
    const repair = task({ taskClass: 'attempt', conflictRetryPrNumber: 1234 });
    expect(evaluateCoordinationGates(repair, snap({ lanes: lanes([m('h', { holding: true }), m('t1')]) }))).toEqual([]);
  });
});
