/**
 * RecoveryManager cancel_queued — verifies that abort(workerId, _, true) calls
 * queryInstance.request() with {subtype:'interrupt', cancel_queued:true} rather
 * than the no-op interrupt() wrapper.
 *
 * SDK 0.3.238 interrupt() hardcodes request({subtype:'interrupt'}) and never
 * forwards opts, so we bypass it via (queryInstance as any).request(). This
 * test would have caught the original bug.
 *
 * Run: bun test apps/runner/__tests__/unit/cancel-queued.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { RecoveryManager } from '../../src/recovery';
import type { RecoveryDeps } from '../../src/recovery';

function makeDeps(sessions: Map<string, any>): RecoveryDeps {
  return {
    workers: new Map(),
    sessions,
    buildd: {} as any,
    resolver: {} as any,
    pendingPermissionRequests: new Map(),
    emit: mock(() => {}),
    addMilestone: mock(() => {}),
    unsubscribeFromWorker: mock(() => {}),
    startSession: mock(async () => {}),
  };
}

describe('RecoveryManager abort — cancel_queued', () => {
  let requestMock: ReturnType<typeof mock>;
  let interruptMock: ReturnType<typeof mock>;
  let abortController: AbortController;
  let sessions: Map<string, any>;

  beforeEach(() => {
    requestMock = mock(async () => ({ response: {} }));
    interruptMock = mock(async () => undefined);
    abortController = new AbortController();
    sessions = new Map([
      [
        'w-1',
        {
          inputStream: { end: mock(() => {}) },
          abortController,
          queryInstance: {
            rewindFiles: mock(async () => {}),
            interrupt: interruptMock,
            // Simulates the SDK Query runtime method not declared in the TS types.
            request: requestMock,
          },
        },
      ],
    ]);
  });

  test('calls request({subtype:interrupt, cancel_queued:true}) when cancelQueued=true', async () => {
    const deps = makeDeps(sessions);
    const rm = new RecoveryManager(deps);

    await rm.abort('w-1', undefined, true);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toMatchObject({
      subtype: 'interrupt',
      cancel_queued: true,
    });
    // Should NOT call the SDK interrupt() wrapper — it ignores opts.
    expect(interruptMock).not.toHaveBeenCalled();
  });

  test('does NOT call request() or interrupt() when cancelQueued=false', async () => {
    const deps = makeDeps(sessions);
    const rm = new RecoveryManager(deps);

    await rm.abort('w-1', undefined, false);

    expect(requestMock).not.toHaveBeenCalled();
    expect(interruptMock).not.toHaveBeenCalled();
  });

  test('does NOT call request() or interrupt() when cancelQueued is absent', async () => {
    const deps = makeDeps(sessions);
    const rm = new RecoveryManager(deps);

    await rm.abort('w-1');

    expect(requestMock).not.toHaveBeenCalled();
    expect(interruptMock).not.toHaveBeenCalled();
  });

  test('does NOT call request() when queryInstance is absent', async () => {
    // Session exists but has no queryInstance (e.g., Codex backend).
    const noQiSessions = new Map([
      [
        'w-1',
        {
          inputStream: { end: mock(() => {}) },
          abortController,
          queryInstance: undefined,
        },
      ],
    ]);
    const deps = makeDeps(noQiSessions);
    const rm = new RecoveryManager(deps);

    await rm.abort('w-1', undefined, true);

    expect(requestMock).not.toHaveBeenCalled();
  });
});
