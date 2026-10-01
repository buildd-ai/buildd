import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * `requestMissionSurfaceAudit`: the decision sheet's "Run visual audit". A
 * person asked, so it files the audit even when the declared manifests never
 * named a UI file, is idempotent, and scopes the audit to what the PRs changed.
 */

const missionsFindFirst = mock(() => Promise.resolve(null as any));
const workspacesFindFirst = mock(() => Promise.resolve(null as any));
const tasksFindMany = mock(() => Promise.resolve([] as any[]));
const tasksInsertReturning = mock(() => Promise.resolve([{ id: 'audit-1', status: 'pending' }] as any[]));
const tasksInsertValues = mock((_values: any) => ({ returning: tasksInsertReturning }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: missionsFindFirst },
      workspaces: { findFirst: workspacesFindFirst },
      tasks: { findMany: tasksFindMany },
      missionNotes: { findFirst: () => Promise.resolve(null) },
    },
    insert: () => ({ values: tasksInsertValues }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

const mockDispatchNewTask = mock((..._a: any[]) => Promise.resolve());
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/task-cancel', () => ({ applyTaskCancelSideEffects: () => Promise.resolve() }));
mock.module('@/lib/chat/mission-events', () => ({ postVisualReviewEvent: () => Promise.resolve(true) }));

const gateTasks = mock(() => Promise.resolve([] as any[]));
const gate = mock((..._a: any[]) => Promise.resolve({ required: false, why: 'no_ui_change' } as any));
mock.module('@/lib/mission-surface-audit-gate', () => ({
  loadSurfaceAuditGateTasks: gateTasks,
  evaluateSurfaceAuditGate: gate,
}));

const { requestMissionSurfaceAudit } = await import('./mission-surface-audit');

const MISSION = { id: 'mission-1', title: 'Mobile nav redesign', status: 'active', workspaceId: 'ws-1', autoSurfaceAudit: true };

beforeEach(() => {
  missionsFindFirst.mockReset(); missionsFindFirst.mockResolvedValue(MISSION);
  workspacesFindFirst.mockReset(); workspacesFindFirst.mockResolvedValue({ id: 'ws-1', name: 'ws', repo: 'o/r', teamId: 't-1' });
  tasksFindMany.mockReset(); tasksFindMany.mockResolvedValue([]);
  tasksInsertValues.mockClear();
  tasksInsertReturning.mockReset(); tasksInsertReturning.mockResolvedValue([{ id: 'audit-1', status: 'pending' }]);
  mockDispatchNewTask.mockReset(); mockDispatchNewTask.mockResolvedValue(undefined);
  gateTasks.mockReset(); gateTasks.mockResolvedValue([
    { id: 'b1', title: 'Build nav', status: 'completed', taskClass: 'work', pathManifest: ['**'] },
  ]);
  gate.mockReset(); gate.mockResolvedValue({ required: true, source: 'diff', uiPaths: ['apps/web/src/app/app/(protected)/missions/[id]/page.tsx'] });
});

describe('requestMissionSurfaceAudit', () => {
  it('files the visual-auditor task, scoped to the changed UI files, and dispatches it', async () => {
    const out = await requestMissionSurfaceAudit('mission-1');

    expect(out).toEqual({ ok: true, created: true, taskId: 'audit-1', status: 'pending' });
    const row = tasksInsertValues.mock.calls[0][0];
    expect(row.title).toBe('[surface audit] Mobile nav redesign');
    expect(row.roleSlug).toBe('visual-auditor');
    expect(row.kind).toBe('observation');
    expect(row.missionId).toBe('mission-1');
    expect(row.dependsOn).toEqual(['b1']);
    expect(row.description).toContain('`/app/missions/:id`');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: an open audit is returned, not duplicated', async () => {
    tasksFindMany.mockResolvedValue([{ id: 'audit-9', status: 'in_progress' }]);
    const out = await requestMissionSurfaceAudit('mission-1');
    expect(out).toEqual({ ok: true, created: false, taskId: 'audit-9', status: 'in_progress' });
    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
  });

  it('returns a finished audit as is', async () => {
    tasksFindMany.mockResolvedValue([{ id: 'audit-9', status: 'completed' }]);
    const out = await requestMissionSurfaceAudit('mission-1');
    expect(out).toMatchObject({ ok: true, created: false, taskId: 'audit-9' });
  });

  it('replaces only a failed or cancelled audit', async () => {
    tasksFindMany.mockResolvedValueOnce([{ id: 'audit-8', status: 'failed' }, { id: 'audit-7', status: 'cancelled' }]);
    const out = await requestMissionSurfaceAudit('mission-1');
    expect(out).toMatchObject({ ok: true, created: true, taskId: 'audit-1' });
  });

  it('refuses a closed mission', async () => {
    missionsFindFirst.mockResolvedValue({ ...MISSION, status: 'completed' });
    expect(await requestMissionSurfaceAudit('mission-1')).toEqual({ ok: false, reason: 'mission_closed' });
    expect(tasksInsertValues).not.toHaveBeenCalled();
  });

  it('reports a missing mission and a mission with no workspace', async () => {
    missionsFindFirst.mockResolvedValue(null);
    expect(await requestMissionSurfaceAudit('nope')).toEqual({ ok: false, reason: 'mission_not_found' });
    missionsFindFirst.mockResolvedValue({ ...MISSION, workspaceId: null });
    expect(await requestMissionSurfaceAudit('mission-1')).toEqual({ ok: false, reason: 'no_workspace' });
  });

  it('still files the audit when the diff cannot be read, from declared manifests', async () => {
    gate.mockRejectedValue(new Error('github down'));
    gateTasks.mockResolvedValue([
      { id: 'b1', title: 'Build nav', status: 'completed', taskClass: 'work', pathManifest: ['apps/web/src/components/Nav.tsx'] },
    ]);
    const out = await requestMissionSurfaceAudit('mission-1');
    expect(out).toMatchObject({ ok: true, created: true });
    expect(tasksInsertValues.mock.calls[0][0].description).toContain('Nav.tsx');
  });

  it('a dispatch failure does not lose the filed audit', async () => {
    mockDispatchNewTask.mockRejectedValue(new Error('pusher down'));
    expect(await requestMissionSurfaceAudit('mission-1')).toMatchObject({ ok: true, created: true });
  });
});
