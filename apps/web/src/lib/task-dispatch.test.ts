import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockTriggerEvent = mock(() => Promise.resolve());

// Mock pusher
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_ASSIGNED: 'task:assigned',
  },
}));

// Mock database (not used in basic dispatch)
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
mock.module('@/lib/github', () => ({
  dispatchToGitHubActions: mock(() => Promise.resolve(false)),
  isGitHubAppConfigured: () => false,
}));

// Get the actual triggerEvent reference that the module system resolves
// (may differ from mockTriggerEvent due to Bun mock.module pollution)
const pusher = await import('@/lib/pusher');
const getEffectiveMock = () => pusher.triggerEvent as ReturnType<typeof mock>;

const { dispatchNewTask } = await import('./task-dispatch');

describe('dispatchNewTask', () => {
  beforeEach(() => {
    const fn = getEffectiveMock();
    fn.mockReset?.();
    fn.mockResolvedValue?.(undefined);
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

    const fn = getEffectiveMock();
    expect(fn).toHaveBeenCalled();
    const [channel, event, payload] = fn.mock.calls[0] as [string, string, any];
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

    const fn = getEffectiveMock();
    const [, event, payload] = fn.mock.calls[0] as [string, string, any];
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

    const fn = getEffectiveMock();
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, event, payload] = fn.mock.calls[1] as [string, string, any];
    expect(event).toBe('task:assigned');
    expect(payload.task.missionId).toBe('mission-2');
  });
});
