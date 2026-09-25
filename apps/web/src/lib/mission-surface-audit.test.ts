import { beforeEach, describe, expect, it, mock } from 'bun:test';

const missionsFindFirst = mock(() => Promise.resolve(null as any));
const tasksFindFirst = mock(() => Promise.resolve(null as any));
const tasksFindMany = mock(() => Promise.resolve([] as any[]));
const tasksInsertReturning = mock(() => Promise.resolve([{ id: 'audit-1', title: '[surface audit] Mission' }] as any[]));
const tasksInsertValues = mock((_values: any) => ({ returning: tasksInsertReturning }));
const tasksUpdateWhere = mock(() => Promise.resolve());
const tasksUpdateSet = mock((_values: any) => ({ where: tasksUpdateWhere }));
const notesFindFirst = mock(() => Promise.resolve(null as any));
const notesInsertValues = mock((_values: any) => Promise.resolve());

// The real schema, so the insert mock can tell a mission note from a task.
const { missionNotes } = await import('@buildd/core/db/schema');

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: missionsFindFirst },
      tasks: { findFirst: tasksFindFirst, findMany: tasksFindMany },
      missionNotes: { findFirst: notesFindFirst },
    },
    insert: (table: unknown) => (table === missionNotes ? { values: notesInsertValues } : { values: tasksInsertValues }),
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
  notesFindFirst.mockReset(); notesFindFirst.mockResolvedValue(null);
  notesInsertValues.mockClear();
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
    // Routed to the browser-gated auditor, not any builder runner.
    expect(inserted.roleSlug).toBe('visual-auditor');
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
  });

  it('lists the required routes derived from the builder tasks\' page files', async () => {
    const created = uiTask('builder-1', {
      pathManifest: ['apps/web/src/app/app/(protected)/missions/[id]/page.tsx'],
    });
    tasksFindMany.mockResolvedValue([created]);

    await ensureMissionSurfaceAudit({
      missionId: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      createdTask: created,
      targetWorkspace,
    });

    const inserted = tasksInsertValues.mock.calls[0][0];
    expect(inserted.description).toContain('`/app/missions/:id`');
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

describe('ensureMissionSurfaceAudit — re-check rounds', () => {
  const round1 = (status: string, dependsOn: string[] = ['builder-1']) => ({
    id: 'audit-1', title: '[surface audit] Mobile nav redesign', status, dependsOn, context: {},
  });
  const round2 = (status: string, dependsOn: string[] = ['fix-1']) => ({
    id: 'audit-2', title: '[surface audit] round 2: Mobile nav redesign', status, dependsOn,
    context: { surfaceAuditRound: 2, visualQa: { requiredRoutes: ['/app/tasks/:id'] } },
  });
  // The auditor's own fix tasks rarely touch a UI path in their manifest.
  const fixTask = (id: string, route = '/app/tasks/:id', pathManifest: string[] | null = ['apps/web/src/lib/foo.ts']) => ({
    id,
    title: `[surface fix] ${route}: header overflows at 390px`,
    taskClass: 'work',
    pathManifest,
  });
  const run = (createdTask: ReturnType<typeof fixTask>) => ensureMissionSurfaceAudit({
    missionId: MISSION_ID, workspaceId: WORKSPACE_ID, createdTask, targetWorkspace,
  });

  it('looks up the NEWEST audit, so a retry clone or a later round is the one extended', async () => {
    await run(fixTask('fix-1'));
    const opts = tasksFindFirst.mock.calls[0][0] as any;
    expect(opts.orderBy).toBeDefined();
    expect(opts.columns).toMatchObject({ id: true, status: true, title: true, context: true, dependsOn: true });
  });

  for (const status of ['completed', 'in_progress']) {
    it(`a fix filed against a ${status} round-1 audit opens ONE round-2 audit scoped to the issue route`, async () => {
      tasksFindFirst.mockResolvedValue(round1(status));

      await run(fixTask('fix-1'));

      expect(tasksInsertValues).toHaveBeenCalledTimes(1);
      const inserted = tasksInsertValues.mock.calls[0][0];
      expect(inserted.title).toBe('[surface audit] round 2: Mobile nav redesign');
      expect(inserted.missionId).toBe(MISSION_ID);
      expect(inserted.dependsOn).toEqual(['fix-1']);
      expect(inserted.roleSlug).toBe('visual-auditor');
      expect(inserted.outputRequirement).toBe('artifact_required');
      expect(inserted.taskClass).toBe('work');
      expect(inserted.context).toEqual({ surfaceAuditRound: 2, visualQa: { requiredRoutes: ['/app/tasks/:id'] } });
      expect(inserted.description).toContain('Round 2');
      expect(inserted.description).toContain('- `/app/tasks/:id`');
      // The finished round is not touched: extending it would be inert.
      expect(tasksUpdateSet).not.toHaveBeenCalled();
      expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
      expect(notesInsertValues).not.toHaveBeenCalled();
    });
  }

  it('opens round 2 even when the fix task names no route (routes then come from its manifest)', async () => {
    tasksFindFirst.mockResolvedValue(round1('completed'));
    await run({ ...fixTask('fix-1'), title: '[surface fix] nav overlaps the header' });

    const inserted = tasksInsertValues.mock.calls[0][0];
    expect(inserted.dependsOn).toEqual(['fix-1']);
    expect(inserted.context.visualQa.requiredRoutes).toEqual([]);
  });

  it('later fixes from the same round extend the pending round-2 audit instead of opening another', async () => {
    tasksFindFirst.mockResolvedValue(round2('pending'));

    await run(fixTask('fix-2', '/app/missions'));

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet).toHaveBeenCalledTimes(1);
    const set = tasksUpdateSet.mock.calls[0][0];
    expect(set.dependsOn).toEqual(['fix-1', 'fix-2']);
    // The new issue route joins the frozen list the evidence check reads.
    expect(set.context.visualQa.requiredRoutes).toEqual(['/app/missions', '/app/tasks/:id']);
    expect(set.context.surfaceAuditRound).toBe(2);
  });

  it('bound: a fix filed after round 2 looked raises a mission question, never a round 3', async () => {
    tasksFindFirst.mockResolvedValue(round2('completed'));

    await run(fixTask('fix-9', '/app/missions'));

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet).not.toHaveBeenCalled();
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
    expect(notesInsertValues).toHaveBeenCalledTimes(1);
    const note = notesInsertValues.mock.calls[0][0];
    expect(note.missionId).toBe(MISSION_ID);
    expect(note.type).toBe('question');
    expect(note.status).toBe('open');
    expect(note.taskId).toBe('fix-9');
    expect(note.title).toContain('2 audit rounds');
    expect(note.body).toContain('fix-9');
  });

  it('bound: an in-progress round 2 filing several fixes raises the question once, not per fix', async () => {
    tasksFindFirst.mockResolvedValue(round2('in_progress'));
    notesFindFirst.mockResolvedValue({ id: 'note-1' });

    await run(fixTask('fix-10'));

    expect(notesInsertValues).not.toHaveBeenCalled();
    expect(tasksInsertValues).not.toHaveBeenCalled();
  });

  it('a pending round-1 audit just depends on the fix (it has not looked yet)', async () => {
    tasksFindFirst.mockResolvedValue(round1('pending'));

    await run(fixTask('fix-1'));

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet.mock.calls[0][0].dependsOn).toEqual(['builder-1', 'fix-1']);
  });

  it('an ordinary builder task after a completed audit keeps the old extend behaviour (no new round)', async () => {
    tasksFindFirst.mockResolvedValue(round1('completed'));

    await run({ ...uiTask('builder-2') } as any);

    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(tasksUpdateSet.mock.calls[0][0].dependsOn).toEqual(['builder-1', 'builder-2']);
  });

  it('a fix task in a mission with no audit is treated like any builder task', async () => {
    await run(fixTask('fix-1'));
    // Non-UI manifest and no audit: nothing to mint.
    expect(tasksInsertValues).not.toHaveBeenCalled();
    expect(notesInsertValues).not.toHaveBeenCalled();
  });

  it('honours the per-mission opt-out for later rounds too', async () => {
    missionsFindFirst.mockResolvedValue({ id: MISSION_ID, title: 'Mobile nav redesign', autoSurfaceAudit: false });
    tasksFindFirst.mockResolvedValue(round1('completed'));

    await run(fixTask('fix-1'));

    expect(tasksInsertValues).not.toHaveBeenCalled();
  });
});
