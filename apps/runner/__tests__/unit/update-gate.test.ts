/**
 * Unit tests for the shared manual-update gate + orchestration
 * (apps/runner/src/update-gate.ts). Both `/api/update` and `/api/update/apply`
 * are meant to run through this — see update-apply-gates.test.ts for the
 * source-level assertion that they actually do.
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  evaluateManualUpdateGate,
  performManualUpdate,
  type ManualUpdateDeps,
} from '../../src/update-gate';

describe('evaluateManualUpdateGate', () => {
  const clean = { isLocalPeer: true, updating: false, workers: [], treeClean: true };

  test('403s a non-local peer before checking anything else', () => {
    const result = evaluateManualUpdateGate({
      ...clean,
      isLocalPeer: false,
      updating: true, // would also fail on its own — peer check must win
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      body: { error: 'Update can only be triggered from localhost' },
    });
  });

  test('409s while an update is already in progress', () => {
    const result = evaluateManualUpdateGate({ ...clean, updating: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Update already in progress');
    }
  });

  for (const status of ['working', 'waiting', 'stale']) {
    test(`409s with activeWorkers when a worker is ${status}`, () => {
      const result = evaluateManualUpdateGate({ ...clean, workers: [{ status }] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
        expect(result.body.error).toBe('Cannot update while tasks are running');
        expect(result.body.activeWorkers).toBe(1);
      }
    });
  }

  test('does not count an idle/completed worker as active', () => {
    const result = evaluateManualUpdateGate({
      ...clean,
      workers: [{ status: 'idle' }, { status: 'completed' }],
    });
    expect(result.ok).toBe(true);
  });

  test('409s a dirty tree', () => {
    const result = evaluateManualUpdateGate({ ...clean, treeClean: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('Working tree has uncommitted changes');
    }
  });

  test('passes when local, idle, no active workers, and clean', () => {
    expect(evaluateManualUpdateGate(clean)).toEqual({ ok: true });
  });
});

function fakeDeps(overrides: Partial<ManualUpdateDeps> = {}): ManualUpdateDeps {
  return {
    clearSkippedTargets: mock(() => {}),
    setUpdating: mock(() => {}),
    broadcast: mock(() => {}),
    applyUpdate: mock(async () => ({ success: true, previousCommit: 'aaa1111', newCommit: 'bbb2222' })),
    rollbackTo: mock(async () => ({ success: true, previousCommit: 'bbb2222', newCommit: 'aaa1111' })),
    runHealthProbe: mock(async () => ({ ok: true, detail: '' })),
    scheduleGracefulRestart: mock(() => {}),
    abandonUpdateTarget: mock(() => {}),
    getLatestCommit: mock(() => 'bbb2222'),
    isNoProgressUpdate: mock((prev: string | null, next: string | null) => !prev || !next || prev === next),
    ...overrides,
  };
}

describe('performManualUpdate', () => {
  test('happy path: reinstalls, probes healthy, restarts', async () => {
    const deps = fakeDeps();
    const outcome = await performManualUpdate('manual update via /api/update', deps);

    expect(deps.clearSkippedTargets).toHaveBeenCalled();
    expect(deps.setUpdating).toHaveBeenCalledWith(true);
    expect(deps.runHealthProbe).toHaveBeenCalled();
    expect(deps.scheduleGracefulRestart).toHaveBeenCalledWith('manual update via /api/update');
    expect(deps.rollbackTo).not.toHaveBeenCalled();
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ success: true, newCommit: 'bbb2222' });
  });

  test('a failed reinstall clears updating and never probes or restarts', async () => {
    const deps = fakeDeps({
      applyUpdate: mock(async () => ({ success: false, error: 'bun install failed' })),
    });
    const outcome = await performManualUpdate('reason', deps);

    expect(deps.runHealthProbe).not.toHaveBeenCalled();
    expect(deps.scheduleGracefulRestart).not.toHaveBeenCalled();
    expect(deps.setUpdating).toHaveBeenCalledWith(false);
    expect(outcome.status).toBe(500);
    expect(outcome.body).toMatchObject({ success: false, error: 'bun install failed' });
  });

  test('a no-progress reset abandons the target and never probes or restarts', async () => {
    const deps = fakeDeps({
      applyUpdate: mock(async () => ({ success: true, previousCommit: 'aaa1111', newCommit: 'aaa1111' })),
    });
    const outcome = await performManualUpdate('reason', deps);

    expect(deps.abandonUpdateTarget).toHaveBeenCalledWith('bbb2222'); // getLatestCommit()
    expect(deps.runHealthProbe).not.toHaveBeenCalled();
    expect(deps.scheduleGracefulRestart).not.toHaveBeenCalled();
    expect(deps.setUpdating).toHaveBeenCalledWith(false);
    expect(outcome.status).toBe(409);
  });

  test('a failed health probe rolls back to the previous commit and does not restart', async () => {
    const deps = fakeDeps({
      runHealthProbe: mock(async () => ({ ok: false, detail: 'new build never bound the health port' })),
    });
    const outcome = await performManualUpdate('reason', deps);

    expect(deps.rollbackTo).toHaveBeenCalledWith('aaa1111'); // applyUpdate's previousCommit
    expect(deps.scheduleGracefulRestart).not.toHaveBeenCalled();
    expect(deps.setUpdating).toHaveBeenCalledWith(false);
    expect(outcome.status).toBe(500);
    expect(outcome.body).toMatchObject({
      success: false,
      error: 'Update rolled back — new version failed health check',
      rolledBackTo: 'aaa1111',
    });
  });

  test('a failed health probe with no known previous commit skips rollback rather than guessing', async () => {
    const deps = fakeDeps({
      applyUpdate: mock(async () => ({ success: true, previousCommit: undefined, newCommit: 'bbb2222' })),
      runHealthProbe: mock(async () => ({ ok: false, detail: 'crashed' })),
    });
    await performManualUpdate('reason', deps);

    expect(deps.rollbackTo).not.toHaveBeenCalled();
  });
});
