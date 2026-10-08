import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * `task.left_mission` → the surface audit lets go of the task and, when that
 * task was the last thing holding it, wakes it. The detach SQL itself is pinned
 * on real Postgres (tests/db/surface-audit-membership.test.ts).
 */
let detached: string[] = [];
let auditDeps: string[] = [];
let memberRows: Array<{ id: string; status: string }> = [];
const updateReturning = mock(async () => detached.map(id => ({ id })));

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => ({ returning: updateReturning }) }) }),
    query: {
      tasks: {
        findFirst: async () => ({ id: 'audit-1', dependsOn: auditDeps }),
        findMany: async () => memberRows,
      },
    },
  },
}));

const wakes: Array<[string, string]> = [];
mock.module('@/lib/dispatch-authority', () => ({
  wakeTask: async (id: string, cause: string) => { wakes.push([id, cause]); },
  wakeTasks: async () => {},
  announceTaskCreated: async () => {},
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({}),
  deliverTaskDispatch: async () => 'skipped:test',
  routeForCause: () => ({}),
  webhookWants: () => false,
  primaryCause: (_c: readonly string[], fallback: string) => fallback,
  reseedDispatchTimer: async () => {},
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
}));

const { surfaceAuditSubscribers } = await import('./surface-audit-subscribers');
const run = (missionId: string, taskId: string) =>
  (surfaceAuditSubscribers[0] as any).run({ type: 'task.left_mission', taskId, missionId, workspaceId: 'ws-1' });

describe('surface audit: task.left_mission', () => {
  beforeEach(() => {
    wakes.length = 0;
    detached = [];
    auditDeps = [];
    memberRows = [];
  });

  it('subscribes to task.left_mission in the visual-qa module', () => {
    expect(surfaceAuditSubscribers.map(s => `${s.module}:${s.on}:${s.label}`)).toEqual(['visual-qa:task.left_mission:surface-audit-detach']);
  });

  it('wakes the audit when the departed task was the last thing holding it', async () => {
    detached = ['audit-1'];
    auditDeps = ['done-1'];
    memberRows = [{ id: 'done-1', status: 'completed' }];
    await run('m-1', 'gone-1');
    expect(wakes).toEqual([['audit-1', 'dependency.satisfied']]);
  });

  it('does not wake an audit a member dependency still holds', async () => {
    detached = ['audit-1'];
    auditDeps = ['running-1'];
    memberRows = [{ id: 'running-1', status: 'in_progress' }];
    await run('m-1', 'gone-1');
    expect(wakes).toEqual([]);
  });

  it('wakes nothing when no audit held the task', async () => {
    await run('m-1', 'gone-1');
    expect(wakes).toEqual([]);
  });
});
