/**
 * Guards the READ side of the feedback-digest type contract.
 *
 * feedback-digest.ts saves memories with type='pattern'.
 * searchFeedbackMemories() must query with type=pattern — not type=decision.
 *
 * See also: apps/web/src/lib/feedback-digest.test.ts (write side).
 */

import { describe, it, expect, mock } from 'bun:test';

// ── Transport mock ────────────────────────────────────────────────────────────

const capturedRoutes: string[] = [];

mock.module('@buildd/core/buildd-transport', () => ({
  BuilddTransport: class {
    async request(route: string): Promise<Response> {
      capturedRoutes.push(route);
      return new Response(JSON.stringify({ memories: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
}));

mock.module('@buildd/core/redaction', () => ({
  createRedactionInterceptor: () => ({}),
}));

const { BuilddClient } = await import('./buildd');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('searchFeedbackMemories — read filter type', () => {
  it('queries memory API with type=pattern (not type=decision)', async () => {
    capturedRoutes.length = 0;

    const client = new BuilddClient({
      builddServer: 'http://test.local',
      apiKey: 'test-key',
    } as any);

    await client.searchFeedbackMemories('ws-1');

    const memoryRoute = capturedRoutes.find((r) => r.includes('/memory'));
    expect(memoryRoute).toBeDefined();
    expect(memoryRoute).toContain('type=pattern');
    expect(memoryRoute).not.toContain('type=decision');
  });
});
