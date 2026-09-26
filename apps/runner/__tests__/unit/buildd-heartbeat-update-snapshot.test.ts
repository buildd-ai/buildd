/**
 * Unit tests for BuilddClient.sendHeartbeat's update-snapshot payload fields
 * (currentCommit/diskCommit/commitDrift/updating/updateAvailable/trackedBranch)
 * — the same live state the runner already reports on its own local
 * /api/version, now reaching the platform so a runner's drift/update status is
 * observable without SSH.
 *
 * Run: bun test apps/runner/__tests__/unit/buildd-heartbeat-update-snapshot.test.ts
 *
 * Reimplements the payload-shaping logic rather than importing BuilddClient —
 * see buildd-heartbeat-runner-version.test.ts for why.
 */

import { describe, test, expect } from 'bun:test';

interface RunnerUpdateSnapshot {
  currentCommit: string | null;
  diskCommit: string | null;
  commitDrift: boolean;
  updating: boolean;
  updateAvailable: boolean;
  trackedBranch: string;
}

function buildHeartbeatPayload(opts: {
  localUiUrl: string;
  activeWorkerCount: number;
  updateSnapshot?: RunnerUpdateSnapshot | null;
}): Record<string, unknown> {
  const { localUiUrl, activeWorkerCount, updateSnapshot } = opts;
  const payload: Record<string, unknown> = { localUiUrl, activeWorkerCount };
  if (updateSnapshot) {
    payload.currentCommit = updateSnapshot.currentCommit;
    payload.diskCommit = updateSnapshot.diskCommit;
    payload.commitDrift = updateSnapshot.commitDrift;
    payload.updating = updateSnapshot.updating;
    payload.updateAvailable = updateSnapshot.updateAvailable;
    payload.trackedBranch = updateSnapshot.trackedBranch;
  }
  return payload;
}

describe('sendHeartbeat update-snapshot payload', () => {
  test('includes all six fields when a snapshot is available', () => {
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
      updateSnapshot: {
        currentCommit: 'aaa1111',
        diskCommit: 'bbb2222',
        commitDrift: true,
        updating: false,
        updateAvailable: true,
        trackedBranch: 'main',
      },
    });
    expect(payload.currentCommit).toBe('aaa1111');
    expect(payload.diskCommit).toBe('bbb2222');
    expect(payload.commitDrift).toBe(true);
    expect(payload.updating).toBe(false);
    expect(payload.updateAvailable).toBe(true);
    expect(payload.trackedBranch).toBe('main');
  });

  test('sends null commit fields as literal null, not omitted, when the disk read failed', () => {
    // Unlike runnerCommit/runnerVersion (omitted when falsy), a snapshot that
    // IS present asserts its fields verbatim — `diskCommit: null` is a real
    // fact ("git rev-parse failed just now"), not "no data".
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
      updateSnapshot: {
        currentCommit: null,
        diskCommit: null,
        commitDrift: false,
        updating: false,
        updateAvailable: false,
        trackedBranch: 'dev',
      },
    });
    expect('diskCommit' in payload).toBe(true);
    expect(payload.diskCommit).toBeNull();
    expect(payload.currentCommit).toBeNull();
  });

  test('omits all six fields when no snapshot is available (legacy runner, or provider unregistered)', () => {
    const payload = buildHeartbeatPayload({
      localUiUrl: 'http://localhost:8766',
      activeWorkerCount: 1,
      updateSnapshot: null,
    });
    for (const key of ['currentCommit', 'diskCommit', 'commitDrift', 'updating', 'updateAvailable', 'trackedBranch']) {
      expect(key in payload).toBe(false);
    }
  });
});
