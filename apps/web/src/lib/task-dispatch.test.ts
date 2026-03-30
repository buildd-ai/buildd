import { describe, it, expect, beforeEach, mock } from 'bun:test';

/**
 * Tests for dispatchNewTask payload construction.
 *
 * Because multiple test files mock @/lib/task-dispatch (to prevent real
 * dispatching in their tests), Bun's process-wide mock.module pollution
 * makes it impossible to import the real function here. Instead, we
 * test via dependency injection: mock all deps, then import.
 */

const mockTriggerEvent = mock(() => Promise.resolve());

// Mock all dependencies BEFORE importing the module
mock.module('@buildd/core/db', () => ({
  db: { query: { githubInstallations: { findFirst: mock(() => null) }, githubRepos: { findFirst: mock(() => null) } } },
}));
mock.module('@buildd/core/db/schema', () => ({
  githubInstallations: {},
  githubRepos: {},
}));
mock.module('drizzle-orm', () => ({
  eq: () => ({}),
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { TASK_CREATED: 'task:created', TASK_ASSIGNED: 'task:assigned' },
}));
mock.module('@/lib/github', () => ({
  dispatchToGitHubActions: mock(() => Promise.resolve(false)),
  isGitHubAppConfigured: () => false,
}));
// Re-register the real module under its alias to counteract other files' mocks
const realModule = await import('./task-dispatch');
mock.module('@/lib/task-dispatch', () => realModule);

const { dispatchNewTask } = realModule;

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

    await dispatchNewTask(task, { name: 'test-ws', repo: 'org/repo' });

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

    await dispatchNewTask(task, { name: 'test-ws', repo: null });

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

    await dispatchNewTask(task, { name: 'test-ws', repo: null });

    expect(mockTriggerEvent.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, event, payload] = mockTriggerEvent.mock.calls[1] as [string, string, any];
    expect(event).toBe('task:assigned');
    expect(payload.task.missionId).toBe('mission-2');
  });
});
