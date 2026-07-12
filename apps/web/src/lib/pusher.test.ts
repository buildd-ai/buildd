import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';

const mockTrigger = mock(() => Promise.resolve());

// Mock the pusher npm package — handles envs where the package isn't installed
// and serves as a fallback for Bun versions where mock.module intercepts
// transitive imports (the package import inside pusher.ts).
mock.module('pusher', () => ({
  default: class MockPusher {
    trigger = mockTrigger;
  },
}));

// Set up required Pusher env vars before importing
process.env.PUSHER_APP_ID = 'test-app-id';
process.env.PUSHER_KEY = 'test-key';
process.env.PUSHER_SECRET = 'test-secret';
process.env.PUSHER_CLUSTER = 'test-cluster';

// Import a FRESH copy of the real module via a cache-busting query specifier.
//
// Why: Bun's mock.module has no unmock, and registrations leak across test
// files within a `bun test` run. Many other test files (mission-loop.test.ts,
// artifact-helpers.test.ts, a dozen route tests, ...) register
// mock.module('@/lib/pusher', ...) stubs. When any of them runs before this
// file, a plain import of './pusher' (same resolved module as '@/lib/pusher')
// returns a namespace whose `triggerEvent` has been patched IN PLACE to that
// other file's stub — while exports their factory omits (like _resetPusher)
// stay real. The tests then assert on our mockTrigger while calling a foreign
// stub, and fail with "0 calls".
//
// The `?payload-guard` query gives this import a distinct module-registry key
// that no mock.module registration can ever match (they target the plain
// path), so we always evaluate the genuine implementation regardless of which
// test files ran first — including files added by future PRs.
const { triggerEvent, _resetPusher } =
  (await import('./pusher?payload-guard' as string)) as typeof import('./pusher');

// Pre-built mock client — injected via _resetPusher so tests don't rely on
// mock.module intercepting the pusher import inside pusher.ts (which broke in
// Bun 1.3.14 when the real package is installed and tests run together).
const mockPusherClient = { trigger: mockTrigger } as any;

describe('triggerEvent — payload size guard', () => {
  beforeEach(() => {
    mockTrigger.mockReset();
    _resetPusher(mockPusherClient);
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
