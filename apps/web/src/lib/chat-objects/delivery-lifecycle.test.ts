/**
 * A chat task card and PR card read merged/open/closed from the kernel's
 * delivery when it owns one, and from the worker's own columns otherwise.
 */
import { describe, expect, it, mock } from 'bun:test';

let view: any = null;
let worker: any = { id: 'w1', taskId: 't1', status: 'completed', runner: null, startedAt: null, completedAt: null, currentAction: null,
  waitingFor: null, prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', mergedAt: null, prLifecycleStatus: 'pr_open',
  milestones: [], turns: 1, updatedAt: null, error: null, linesAdded: 1, linesRemoved: 1 };
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: async () => ({ id: 't1', title: 'Change', status: 'completed', workspaceId: 'ws', workspace: { id: 'ws', teamId: null }, mission: null, roleSlug: null, outputRequirement: 'pr_required', missionId: null }) },
      workers: { findFirst: async () => worker },
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ n: 1 }]) }) }),
  },
}));
mock.module('@/lib/team-access', () => ({ verifyWorkspaceAccess: async () => true }));
mock.module('@/app/app/(protected)/tasks/[id]/role-lookup', () => ({ findTaskRole: async () => null }));
mock.module('@/lib/workflow/delivery-view', () => ({
  getOwnerDeliveryDisplays: async () => new Map(),
  getDeliveryViewsForTasks: async () => (view ? new Map([['t1', view]]) : new Map()),
}));
const { loadTaskObject } = await import('./load-task-object');
const { loadPrObject } = await import('./load-pr-object');

describe('chat objects read the delivery', () => {
  it('a merged delivery overrides an open worker row on the task card and the PR card', async () => {
    view = { ownerTaskId: 't1', prNumber: 7, state: 'MERGED', prState: 'merged', mergedAt: '2026-01-01T00:00:00Z', headline: 'Landed', repoFullName: 'o/r' };
    const t = await loadTaskObject('t1', 'u');
    expect(t?.worker?.prLifecycleStatus).toBe('merged');
    expect(t?.worker?.mergedAt).not.toBeNull();
    expect((await loadPrObject('w1', 'u'))?.state).toBe('merged');
  });
  it('AC-26: a merged worker row reads as not merged while the delivery is in review', async () => {
    worker = { ...worker, mergedAt: new Date('2026-01-01'), prLifecycleStatus: 'merged' };
    view = { ownerTaskId: 't1', prNumber: 7, state: 'AWAITING_REVIEW', prState: 'ci_passed', mergedAt: null, headline: 'Review queued', repoFullName: 'o/r' };
    const t = await loadTaskObject('t1', 'u');
    expect(t?.worker?.prLifecycleStatus).toBe('ci_green');
    expect(t?.worker?.mergedAt).toBeNull();
    expect((await loadPrObject('w1', 'u'))?.state).not.toBe('merged');
    expect((await loadPrObject('w1', 'u'))?.mergedAt).toBeNull();
  });
  it('without a delivery the worker columns stand', async () => {
    view = null;
    worker = { ...worker, mergedAt: null, prLifecycleStatus: 'pr_open' };
    const t = await loadTaskObject('t1', 'u');
    expect(t?.worker?.prLifecycleStatus).toBe('pr_open');
    expect(t?.worker?.mergedAt).toBeNull();
  });
});
