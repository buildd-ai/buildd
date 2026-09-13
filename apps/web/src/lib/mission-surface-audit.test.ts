import { beforeEach, describe, expect, it, mock } from 'bun:test';

const missionsFindFirst = mock(() => Promise.resolve(null as any));
const tasksFindFirst = mock(() => Promise.resolve(null as any));
const tasksFindMany = mock(() => Promise.resolve([] as any[]));
const tasksInsertReturning = mock(() => Promise.resolve([{ id: 'audit-1', title: '[surface audit] Mission' }] as any[]));
const tasksInsertValues = mock((_values: any) => ({ returning: tasksInsertReturning }));
const tasksUpdateWhere = mock(() => Promise.resolve());
const tasksUpdateSet = mock((_values: any) => ({ where: tasksUpdateWhere }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: missionsFindFirst },
      tasks: { findFirst: tasksFindFirst, findMany: tasksFindMany },
    },
    insert: () => ({ values: tasksInsertValues }),
    update: () => ({ set: tasksUpdateSet }),
  },
}));

const mockDispatchNewTask = mock(() => Promise.resolve());
mock.module('@/lib/task-dispatch', () => ({
  dispatchNewTask: mockDispatchNewTask,
}));

const { ensureMissionSurfaceAudit } = await import('./mission-surface-audit');

const MISSION_ID = 'mission-1';
const WORKSPACE_ID = 'ws-1';
const targetWorkspace = { id: WORKSPACE_ID, name: 'test-ws', repo: 'buildd-ai/buildd' };

function uiTask(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `Builder task ${id}`,
    taskClass: 'work',
    pathManifest: ['apps/web/src/components/Foo.tsx'],
    ...overrides,
  };
}

beforeEach(() => {
  missionsFindFirst.mockReset(); missionsFindFirst.mockResolvedValue({ id: MISSION_ID, title: 'Mobile nav redesign', autoSurfaceAudit: true });
  tasksFindFirst.mockReset(); tasksFindFirst.mockResolvedValue(null);
  tasksFindMany.mockReset(); tasksFindMany.mockResolvedValue([]);
  tasksInsertReturning.mockReset(); tasksInsertReturning.mockResolvedValue([{ id: 'audit-1', title: '[surface audit] Mobile nav redesign' }]);
  tasksInsertValues.mockClear();
  tasksUpdateWhere.mockReset(); tasksUpdateWhere.mockResolvedValue(undefined);
  tasksUpdateSet.mockClear();
  mockDispatchNewTask.mockReset(); mockDispatchNewTask.mockResolvedValue(undefined);
});

describe('ensureMissionSurfaceAudit', () => {
  it('creates exactly one audit task for a UI-manifest mission', async () => {
    const created = uiTask('builder-1');
    tasksFindMany.mockResolvedValue([created]);

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: created,
      targetWorkspace,
    });

    expect(tasksInsertValues).toHaveBeenCalledTimes(1);
    const inserted = tasksInsertValues.mock.calls[0][0];
    expect(inserted.title).toBe('[surface audit] Mobile nav redesign');
    expect(inserted.missionId).toBe(MISSION_ID);
    expect(inserted.dependsOn).toEqual(['builder-1']);
    expect(inserted.outputRequirement).toBe('artifact_required');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('does not create a second audit task on a later decomposition pass — extends dependsOn instead', async () => {
    // Simulate the audit task already existing from a prior pass.
    tasksFindFirst.mockResolvedValue({ id: 'audit-1', dependsOn: ['builder-1'] });

    const secondBuilderTask = uiTask('builder-2');
    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: secondBuilderTask,
      targetWorkspace,
    });

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet).toHaveBeenCalledTimes(1);
    expect(tasksUpdateSet.mock.calls[0][0].dependsOn).toEqual(['builder-1', 'builder-2']);
  });

  it('does not extend dependsOn twice for the same task id (idempotent)', async () => {
    tasksFindFirst.mockResolvedValue({ id: 'audit-1', dependsOn: ['builder-1'] });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: uiTask('builder-1'),
      targetWorkspace,
    });

    expect(tasksUpdateSet).not.toHaveBeenCalled();
  });

  it('does nothing for a non-UI mission (no pathManifest under a UI surface directory)', async () => {
    const backendTask = uiTask('builder-3', { pathManifest: ['packages/core/mission-helpers.ts'] });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: backendTask,
      targetWorkspace,
    });

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet).not.toHaveBeenCalled();
  });

  it('ignores the repo-wide sentinel — an undeclared scope never mints an audit task', async () => {
    const undeclaredTask = uiTask('builder-4', { pathManifest: ['**'] });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: undeclaredTask,
      targetWorkspace,
    });

    expect(tasksInsertValues).not.toHaveBeenCalled();
  });

  it('skips bookkeeping tasks entirely (never trigger, never extend)', async () => {
    tasksFindFirst.mockResolvedValue({ id: 'audit-1', dependsOn: [] });
    const bookkeepingTask = uiTask('mission-task-1', { taskClass: 'bookkeeping', title: 'Mission: Mobile nav redesign' });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: bookkeepingTask,
      targetWorkspace,
    });

    expect(missionsFindFirst).not.toHaveBeenCalled();
    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet).not.toHaveBeenCalled();
  });

  it('never triggers on the audit task itself, even though it is taskClass work', async () => {
    const auditTaskItself = uiTask('audit-1', { title: '[surface audit] Mobile nav redesign' });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: auditTaskItself,
      targetWorkspace,
    });

    expect(missionsFindFirst).not.toHaveBeenCalled();
    expect(tasksInsertValues).not.toHaveBeenCalled();
  });

  it('honors the per-mission opt-out flag', async () => {
    missionsFindFirst.mockResolvedValue({ id: MISSION_ID, title: 'Mobile nav redesign', autoSurfaceAudit: false });

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: uiTask('builder-1'),
      targetWorkspace,
    });

    expect(tasksFindFirst).not.toHaveBeenCalled();
    expect(tasksInsertValues).not.toHaveBeenCalled();
  });

  it('scopes the new audit task to the union of declared UI/backend paths across builder tasks', async () => {
    const first = uiTask('builder-1', { pathManifest: ['apps/web/src/components/Foo.tsx'] });
    const second = uiTask('builder-2', { pathManifest: ['packages/core/mission-helpers.ts'] });
    tasksFindMany.mockResolvedValue([first, second]);

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: first,
      targetWorkspace,
    });

    const inserted = tasksInsertValues.mock.calls[0][0];
    expect(inserted.dependsOn).toEqual(['builder-1', 'builder-2']);
    expect(inserted.description).toContain('apps/web/src/components/Foo.tsx');
    expect(inserted.description).toContain('packages/core/mission-helpers.ts');
  });
});
