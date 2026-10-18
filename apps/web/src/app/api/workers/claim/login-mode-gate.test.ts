/**
 * Which candidates a runner's login mode must leave on Claude (spec 34a48877
 * R-16): those whose workspace, mission or role names Claude.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockMissionsFindMany = mock((_q?: unknown) => [] as any[]);
const mockWorkspaceSkillsFindMany = mock((_q?: unknown) => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findMany: mockMissionsFindMany },
      workspaceSkills: { findMany: mockWorkspaceSkillsFindMany },
    },
  },
}));

const { claudeDefaultTaskIds } = await import('./login-mode-gate');

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'ws-1', backend: 'claude', missionId: null, roleSlug: null,
  workspace: { teamId: 'team-1', gitConfig: {} }, ...over,
});

beforeEach(() => {
  mockMissionsFindMany.mockReset();
  mockMissionsFindMany.mockImplementation(() => []);
  mockWorkspaceSkillsFindMany.mockReset();
  mockWorkspaceSkillsFindMany.mockImplementation(() => []);
});

describe('claudeDefaultTaskIds', () => {
  it('a task nothing ties to a backend is free, and no query runs for it', async () => {
    expect([...await claudeDefaultTaskIds([task('t-1')])]).toEqual([]);
    expect(mockMissionsFindMany).not.toHaveBeenCalled();
    expect(mockWorkspaceSkillsFindMany).not.toHaveBeenCalled();
  });

  it('a workspace default of claude ties its tasks', async () => {
    const ids = await claudeDefaultTaskIds([task('t-1', { workspace: { teamId: 'team-1', gitConfig: { defaultBackend: 'claude' } } })]);
    expect(ids.has('t-1')).toBe(true);
  });

  it("a mission default of claude ties the mission's tasks, not others", async () => {
    mockMissionsFindMany.mockImplementation(() => [{ id: 'm-1', defaultBackend: 'claude' }]);
    const ids = await claudeDefaultTaskIds([task('t-1', { missionId: 'm-1' }), task('t-2', { missionId: 'm-2' })]);
    expect([...ids]).toEqual(['t-1']);
    expect(mockMissionsFindMany).toHaveBeenCalledTimes(1);
  });

  it("a role default of claude ties the role's tasks; the workspace's own row wins over the team's", async () => {
    mockWorkspaceSkillsFindMany.mockImplementation(() => [
      { slug: 'builder', workspaceId: null, teamId: 'team-1', defaultBackend: 'claude' },
      { slug: 'reviewer', workspaceId: 'ws-1', teamId: 'team-1', defaultBackend: 'codex' },
      { slug: 'reviewer', workspaceId: null, teamId: 'team-1', defaultBackend: 'claude' },
    ]);
    const ids = await claudeDefaultTaskIds([task('t-1', { roleSlug: 'builder' }), task('t-2', { roleSlug: 'reviewer' })]);
    expect([...ids]).toEqual(['t-1']);
  });

  it('a task already on Codex is not asked about', async () => {
    expect((await claudeDefaultTaskIds([task('t-1', { backend: 'codex', missionId: 'm-1' })])).size).toBe(0);
    expect(mockMissionsFindMany).not.toHaveBeenCalled();
  });
});
