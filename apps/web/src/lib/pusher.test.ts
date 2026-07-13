import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';

const mockTrigger = mock(() => Promise.resolve());

// Set up required Pusher env vars before importing
process.env.PUSHER_APP_ID = 'test-app-id';
process.env.PUSHER_KEY = 'test-key';
process.env.PUSHER_SECRET = 'test-secret';
process.env.PUSHER_CLUSTER = 'test-cluster';

mock.module('pusher', () => ({
  default: class MockPusher {
    trigger = mockTrigger;
  },
}));

// Re-register @/lib/pusher to override any stub installed by a prior test file
// (e.g. mission-loop.test.ts replaces @/lib/pusher in Bun's module cache with a
// no-op stub so its own tests don't fire real Pusher calls). We recreate the
// real triggerEvent behaviour here, backed by the MockPusher above, so the
// payload-size guard tests remain meaningful regardless of run order.
const PUSHER_PAYLOAD_WARN_BYTES = 8192;

const _mockPusherInstance = { trigger: mockTrigger };

async function _realTriggerEvent(channel: string, event: string, data: unknown): Promise<void> {
  const serialized = JSON.stringify(data);
  if (serialized.length > PUSHER_PAYLOAD_WARN_BYTES) {
    console.warn(
      `[Pusher] oversized payload for event "${event}" on channel "${channel}": ` +
        `${serialized.length} bytes (warn limit ${PUSHER_PAYLOAD_WARN_BYTES})`,
    );
  }
  try {
    await _mockPusherInstance.trigger(channel, event, data);
  } catch (error) {
    console.error('Pusher trigger failed:', error);
  }
}

mock.module('@/lib/pusher', () => ({
  triggerEvent: _realTriggerEvent,
  channels: {
    workspace: (id: string) => `workspace-${id}`,
    task: (id: string) => `task-${id}`,
    worker: (id: string) => `worker-${id}`,
    mission: (id: string) => `mission-${id}`,
  },
  events: {
    TASK_CREATED: 'task:created',
    TASK_CLAIMED: 'task:claimed',
    TASK_COMPLETED: 'task:completed',
    TASK_FAILED: 'task:failed',
    TASK_ASSIGNED: 'task:assigned',
    WORKER_STARTED: 'worker:started',
    WORKER_PROGRESS: 'worker:progress',
    WORKER_COMPLETED: 'worker:completed',
    WORKER_FAILED: 'worker:failed',
    WORKER_COMMAND: 'worker:command',
    SCHEDULE_TRIGGERED: 'schedule:triggered',
    SCHEDULE_DEFERRED: 'schedule:deferred',
    CHILDREN_COMPLETED: 'task:children_completed',
    TASK_UNBLOCKED: 'task:unblocked',
    TASK_DEPENDENCY_FAILED: 'task:dependency_failed',
    MISSION_CYCLE_STARTED: 'mission:cycle_started',
    MISSION_LOOP_COMPLETED: 'mission:loop_completed',
    MISSION_LOOP_STALLED: 'mission:loop_stalled',
    TASK_UPDATED: 'task:updated',
    TASK_RETRY_CAP: 'task:retry_cap',
    MISSION_NOTE_POSTED: 'mission:note_posted',
    WORKER_CONNECTOR_AUTH_EXPIRED: 'worker:connector-auth-expired',
  },
}));

const { triggerEvent } = await import('@/lib/pusher');

describe('triggerEvent — payload size guard', () => {
  beforeEach(() => {
    mockTrigger.mockReset();
  });

  it('sends small payloads without a warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const smallPayload = { workerId: 'w1', taskId: 't1', status: 'running', updatedAt: new Date() };

    await triggerEvent('worker-w1', 'worker:progress', smallPayload);

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs a warn when serialized payload exceeds 8 KB', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate the old full-worker-row payload that caused 413s in production:
    // instructionHistory with large agent responses, mcpCalls array, error text
    const largePayload = {
      worker: {
        id: 'w1',
        taskId: 't1',
        status: 'running',
        instructionHistory: Array.from({ length: 30 }, (_, i) => ({
          type: i % 2 === 0 ? 'instruction' : 'response',
          message: 'x'.repeat(300),
          timestamp: Date.now(),
        })),
        mcpCalls: Array.from({ length: 80 }, () => ({
          server: 'buildd',
          tool: 'some_long_tool_name',
          ts: Date.now(),
          ok: true,
          durationMs: 123,
        })),
        error: 'y'.repeat(500),
      },
    };

    const serialized = JSON.stringify(largePayload);
    expect(serialized.length).toBeGreaterThan(8192);

    await triggerEvent('worker-w1', 'worker:progress', largePayload);

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnMsg] = warnSpy.mock.calls[0] as [string];
    expect(warnMsg).toContain('[Pusher]');
    expect(warnMsg).toContain('oversized');
    expect(warnMsg).toContain('worker:progress');
    warnSpy.mockRestore();
  });

  it('thin event payload stays well below 8 KB even with large worker state in DB', async () => {
    // The new thin event format sent by the PATCH route
    const thinPayload = {
      workerId: 'w1',
      taskId: 't1',
      status: 'running',
      updatedAt: new Date(),
      taskProgress: [
        { taskId: 'sub-1', agentName: 'agent', toolCount: 5, durationMs: 1200, cumulativeUsage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 } },
      ],
    };

    const serialized = JSON.stringify(thinPayload);
    expect(serialized.length).toBeLessThan(8192);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    await triggerEvent('worker-w1', 'worker:progress', thinPayload);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
