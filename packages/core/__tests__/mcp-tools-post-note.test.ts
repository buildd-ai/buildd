import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

function context(): ActionContext {
  return {
    workerId: 'worker-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
  };
}

describe('post_note', () => {
  it('posts to the mission feed when the current task has a mission', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') {
        return { taskId: 'task-1', task: { id: 'task-1', missionId: 'mission-1' } };
      }
      return { id: 'note-1' };
    });

    await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'warning', title: 'Credentials unavailable' },
      context(),
    );

    expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/api/workers/worker-1',
      '/api/missions/mission-1/notes',
    ]);
  });

  it('posts a task-scoped note when the current task has no mission', async () => {
    const api = mock(async (endpoint: string) => {
      if (endpoint === '/api/workers/worker-1') {
        return { taskId: 'task-1', task: { id: 'task-1', missionId: null } };
      }
      return { id: 'note-1' };
    });

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'post_note',
      { type: 'warning', title: 'Credentials unavailable', body: 'Cue tools are not connected.' },
      context(),
    );

    expect(api.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/api/workers/worker-1',
      '/api/tasks/task-1/notes',
    ]);
    const [, options] = api.mock.calls[1];
    expect(JSON.parse(String(options?.body))).toMatchObject({
      type: 'warning',
      title: 'Credentials unavailable',
      bodyText: 'Cue tools are not connected.',
      taskId: 'task-1',
      workerId: 'worker-1',
    });
    expect(result.content[0].text).toContain('Note posted');
  });
});
