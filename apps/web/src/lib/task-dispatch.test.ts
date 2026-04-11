import { describe, it, expect } from 'bun:test';
import { buildTaskPayload } from './task-dispatch';

describe('buildTaskPayload', () => {
  it('includes missionId when present', () => {
    const payload = buildTaskPayload(
      { id: 'task-1', title: 'Test', description: 'A test', workspaceId: 'ws-1', mode: 'planning', priority: 5, missionId: 'mission-1' },
      { name: 'test-ws', repo: 'org/repo' },
    );

    expect(payload.id).toBe('task-1');
    expect(payload.missionId).toBe('mission-1');
    expect(payload.workspace).toEqual({ name: 'test-ws', repo: 'org/repo' });
  });

  it('omits missionId when not present', () => {
    const payload = buildTaskPayload(
      { id: 'task-2', title: 'Standalone', description: null, workspaceId: 'ws-1' },
      { name: 'test-ws', repo: null },
    );

    expect(payload.missionId).toBeUndefined();
    expect(payload.workspace).toEqual({ name: 'test-ws', repo: null });
  });

  it('omits missionId when null', () => {
    const payload = buildTaskPayload(
      { id: 'task-3', title: 'Task', description: null, workspaceId: 'ws-1', missionId: null },
      { name: 'ws' },
    );

    expect(payload.missionId).toBeUndefined();
  });

  it('omits workspace when name not provided', () => {
    const payload = buildTaskPayload(
      { id: 'task-4', title: 'Task', description: null, workspaceId: 'ws-1' },
      {},
    );

    expect(payload.workspace).toBeUndefined();
  });

  it('includes all task fields in payload', () => {
    const payload = buildTaskPayload(
      { id: 't1', title: 'Full', description: 'desc', workspaceId: 'ws-1', mode: 'execution', priority: 10, missionId: 'm1' },
      { name: 'ws', repo: 'org/repo' },
    );

    expect(payload).toEqual({
      id: 't1',
      title: 'Full',
      description: 'desc',
      workspaceId: 'ws-1',
      mode: 'execution',
      priority: 10,
      missionId: 'm1',
      workspace: { name: 'ws', repo: 'org/repo' },
    });
  });
});
