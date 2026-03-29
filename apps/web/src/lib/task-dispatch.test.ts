import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Injected deps — bypass Bun mock.module pollution entirely
const mockTriggerEvent = mock(() => Promise.resolve());
const testDeps = {
  triggerEvent: mockTriggerEvent as any,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
};

// Mock database (not used in basic dispatch)
mock.module('@buildd/core/db', () => ({
  db: { query: { githubInstallations: { findFirst: mock(() => null) }, githubRepos: { findFirst: mock(() => null) } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: {},
  githubRepos: {},
  WorkspaceWebhookConfig: {},
}));
mock.module('drizzle-orm', () => ({
  eq: () => ({}),
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
}));
mock.module('@/lib/github', () => ({
  dispatchToGitHubActions: mock(() => Promise.resolve(false)),
  isGitHubAppConfigured: () => false,
}));

const { dispatchNewTask } = await import('./task-dispatch');

describe('dispatchNewTask', () => {
  beforeEach(() => {
    mockTriggerEvent.mockReset();
    mockTriggerEvent.mockResolvedValue(undefined);
  });

  it('includes missionId in task:created payload when present', async () => {
    const task = {
      id: 'task-1',
      title: 'Test task',
      description: 'A test task',
      workspaceId: 'ws-1',
      mode: 'planning',
      priority: 5,
      missionId: 'mission-1',
    };

    await dispatchNewTask(task, { name: 'test-ws', repo: 'org/repo' }, undefined, testDeps);

    expect(mockTriggerEvent).toHaveBeenCalled();
    const [channel, event, payload] = mockTriggerEvent.mock.calls[0] as [string, string, any];
    expect(channel).toBe('workspace-ws-1');
    expect(event).toBe('task:created');
    expect(payload.task.missionId).toBe('mission-1');
  });

  it('omits missionId from payload when not present', async () => {
    const task = {
      id: 'task-2',
      title: 'Standalone task',
      description: null,
      workspaceId: 'ws-1',
    };

    await dispatchNewTask(task, { name: 'test-ws', repo: null }, undefined, testDeps);

    const [, event, payload] = mockTriggerEvent.mock.calls[0] as [string, string, any];
    expect(event).toBe('task:created');
    expect(payload.task.missionId).toBeUndefined();
  });

  it('includes missionId in task:assigned fallback payload', async () => {
    const task = {
      id: 'task-3',
      title: 'Mission task',
      description: 'With mission',
      workspaceId: 'ws-1',
      missionId: 'mission-2',
    };

    await dispatchNewTask(task, { name: 'test-ws', repo: null }, undefined, testDeps);

    expect(mockTriggerEvent.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, event, payload] = mockTriggerEvent.mock.calls[1] as [string, string, any];
    expect(event).toBe('task:assigned');
    expect(payload.task.missionId).toBe('mission-2');
  });
});
