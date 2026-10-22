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

mock.module('next/server', () => ({ after: () => { throw new Error('no request scope'); } }));
const persisted: Array<[any, number, string | null | undefined]> = [];
mock.module('@/lib/pr-surface-evidence', () => ({
  persistMergedSurfaceEvidence: async (repo: any, pr: number, head?: string | null) => { persisted.push([repo, pr, head]); },
  loadPrSurfaceFiles: async () => null,
}));

const reruns: string[] = [];
mock.module('@/lib/specs/registered-verification-store', () => ({
  rerunRegisteredVerificationForAudit: async (id: string) => { reruns.push(id); if (id === 'boom') throw new Error('store down'); },
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
    expect(surfaceAuditSubscribers.map(s => `${s.module}:${s.on}:${s.label}`)).toEqual([
      'visual-qa:task.left_mission:surface-audit-detach',
      'visual-qa:pr.closed:surface-evidence-on-merge',
      'visual-qa:worker.reported:registered-checks-on-captures',
    ]);
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

describe('surface audit: pr.closed records merged file evidence', () => {
  const onClosed = (e: Record<string, unknown>) => (surfaceAuditSubscribers[1] as any).run({
    type: 'pr.closed', workspaceId: 'ws-1', prNumber: 42, merged: true, mergeIsNew: true, workerId: 'w', taskId: 't',
    headSha: 'abc', repoFullName: 'acme/app', installationId: 7, ...e,
  });
  beforeEach(() => { persisted.length = 0; });

  it('records a merged PR at its merged head, outside any render', async () => {
    await onClosed({});
    expect(persisted).toEqual([[{ installationId: 7, fullName: 'acme/app' }, 42, 'abc']]);
  });

  it('records nothing for a PR closed without merging, or with no installation', async () => {
    await onClosed({ merged: false });
    await onClosed({ installationId: null });
    expect(persisted).toEqual([]);
  });
});

describe('surface audit: worker.reported re-verifies on arrived captures', () => {
  const reported = (e: Record<string, unknown>) => (surfaceAuditSubscribers[2] as any).run({
    type: 'worker.reported', taskId: 'audit-1', workerId: 'w', workspaceId: 'ws-1', missionId: 'm-1', status: 'completed',
    finalStatus: 'completed', releaseHeld: false, structuredOutput: null, verificationEvidence: null, ...e,
  });
  beforeEach(() => { reruns.length = 0; });

  it('R-6/AC-5: a mission task\'s report asks the store to re-verify what its captures can decide', async () => {
    await reported({});
    expect(reruns).toEqual(['audit-1']);
  });

  it('a task outside any mission is never an audit: nothing is read', async () => {
    await reported({ missionId: null });
    expect(reruns).toEqual([]);
  });

  it('a store failure is logged, never thrown into the report', async () => {
    await expect(reported({ taskId: 'boom' })).resolves.toBeUndefined();
  });
});

