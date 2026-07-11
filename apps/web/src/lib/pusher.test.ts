import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';

const mockTrigger = mock(() => Promise.resolve());

// Mock the pusher npm package so pusher.ts can be imported without real credentials.
// Belt-and-suspenders for Bun version differences:
//   - trigger=mockTrigger on MockPusher covers when mock.module intercepts static imports
//   - _setPusherClientForTesting in beforeEach covers when it doesn't
mock.module('pusher', () => ({
  default: class MockPusher {
    trigger = mockTrigger;
  },
}));

// Set up env vars so getPusher() doesn't short-circuit on missing config
process.env.PUSHER_APP_ID = 'test-app-id';
process.env.PUSHER_KEY = 'test-key';
process.env.PUSHER_SECRET = 'test-secret';
process.env.PUSHER_CLUSTER = 'test-cluster';

const { triggerEvent, _setPusherClientForTesting } = await import('./pusher');

const mockPusherClient = { trigger: mockTrigger } as any;

beforeEach(() => {
  // Reset first, then inject — ensures mockPusherClient.trigger always points
  // to the current (reset) mockTrigger, regardless of Bun version behavior.
  mockTrigger.mockReset();
  mockTrigger.mockImplementation(() => Promise.resolve());
  _setPusherClientForTesting(mockPusherClient);
});

afterAll(() => {
  _setPusherClientForTesting(null);
});

describe('triggerEvent — payload size guard', () => {
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
