/**
 * Unit tests for BuilddClient.sendHeartbeat's runnerCommit/runnerVersion payload
 * fields — added so the platform can distinguish a runner instance still
 * serving pre-fix code from one that picked up a merged fix, without SSH.
 *
 * Run: bun test apps/runner/__tests__/unit/buildd-heartbeat-runner-version.test.ts
 *
 * Note: We avoid importing BuilddClient directly because other test files
 * (worker-manager-state.test.ts) mock '../../src/buildd' with a partial class.
 * Instead we test the HTTP contract by reimplementing the payload-shaping logic.
 * See buildd-skills.test.ts for the same pattern.
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';

// Reimplementation of BuilddClient.sendHeartbeat's payload shaping for isolated testing.
function buildHeartbeatPayload(opts: {
  localUiUrl: string;
  activeWorkerCount: number;
  environment?: unknown;
  activeWorkerIds?: string[];
  redactionCounts?: Record<string, number>;
  sandboxEnabled?: boolean | null;
  sandboxProbeAt?: string | null;
  runnerCommit?: string | null;
  runnerVersion?: string | null;
}): Record<string, unknown> {
  const { localUiUrl, activeWorkerCount, environment, activeWorkerIds, redactionCounts, sandboxEnabled, sandboxProbeAt, runnerCommit, runnerVersion } = opts;
  const payload: Record<string, unknown> = { localUiUrl, activeWorkerCount, environment };
  if (activeWorkerIds) payload.activeWorkerIds = activeWorkerIds;
  if (redactionCounts && Object.keys(redactionCounts).length > 0) payload.redactionCounts = redactionCounts;
  if (sandboxProbeAt !== null && sandboxProbeAt !== undefined) {
    payload.sandboxEnabled = sandboxEnabled;
    payload.sandboxProbeAt = sandboxProbeAt;
  }
  if (runnerCommit) payload.runnerCommit = runnerCommit;
  if (runnerVersion) payload.runnerVersion = runnerVersion;
  return payload;
}

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('sendHeartbeat runnerCommit/runnerVersion payload', () => {
  test('includes runnerCommit and runnerVersion when both are truthy', () => {
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
      runnerCommit: '5bfaeef',
      runnerVersion: '0.206.0',
    });
    expect(payload.runnerCommit).toBe('5bfaeef');
    expect(payload.runnerVersion).toBe('0.206.0');
  });

  test('omits runnerCommit when the disk read fails (null)', () => {
    // getCurrentCommit() returns null when `git rev-parse HEAD` fails — must
    // not send the literal string "null" as a commit.
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
      runnerCommit: null,
      runnerVersion: '0.206.0',
    });
    expect('runnerCommit' in payload).toBe(false);
    expect(payload.runnerVersion).toBe('0.206.0');
  });

  test('omits both fields when neither is provided (legacy caller)', () => {
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
    });
    expect('runnerCommit' in payload).toBe(false);
    expect('runnerVersion' in payload).toBe(false);
  });
});
