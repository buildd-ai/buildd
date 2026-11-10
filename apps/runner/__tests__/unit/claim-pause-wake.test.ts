/**
 * Every temporary global claimsPaused pause must arm a resume poll at
 * claimsPausedUntil; otherwise recovery waits for the hourly fallback poll.
 */
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

mock.module('../../src/git-operations', () => ({
  setupWorktree: mock(async () => ({})), removeWorktreeIfUnowned: mock(async () => ({})),
  removeWorktreeIfUnownedSync: mock(() => ({})), cleanupWorktree: mock(async () => ({})), collectGitStats: async () => ({}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [], __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {},
}));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({}), checkMcpPreFlight: () => ({ warnings: [] }),
  parseMcpJson: () => [], scanMcpServersRich: () => [],
  checkBwrapSupport: () => true, checkBwrapMountIsolationSupport: () => true,
}));
const { WorkerManager } = await import('../../src/workers');

function harness() {
  const wakes: Array<{ at: number; reason: string }> = [];
  const m = Object.create(WorkerManager.prototype) as any;
  Object.assign(m, {
    claimsPaused: false, claimsPausedUntil: 0, consecutiveAuthFailures: 0,
    workerTeamKeys: new Map(), workerAuthContexts: new Map(),
    credCache: { invalidate: () => {} },
    contextBreaker: { pause: () => {} },
    emit: () => {},
    scheduleResumeAt: (at: number, reason: string) => { wakes.push({ at, reason }); },
  });
  return { m, wakes };
}

describe('global claim pause schedules a wake at claimsPausedUntil', () => {
  test('handleAuthFailure', () => {
    const { m, wakes } = harness();
    m.handleAuthFailure('w1');
    expect(m.claimsPaused).toBe(true);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].at).toBe(m.claimsPausedUntil);
  });

  test('handleAuthFailure keeps the later existing pause as the wake target', () => {
    const { m, wakes } = harness();
    const far = Date.now() + 60 * 60_000;
    m.claimsPausedUntil = far;
    m.handleAuthFailure('w1');
    expect(wakes[0].at).toBe(far);
  });

  test('provider rejected-limit global pause wakes at nextLift, not the limit reset', () => {
    const { m, wakes } = harness();
    const now = Date.now();
    const reset = now + 3 * 3_600_000;
    const lift = now + 600_000;
    Object.assign(m, {
      providerLimits: {
        heldUntil: () => reset, hold: () => {}, allHeld: () => true, nextLift: () => lift, report: () => [],
      },
      startableProviders: () => ['anthropic'],
      noteClaimOutcome: () => {},
    });
    m.holdProvider({ provider: 'anthropic', status: 'rejected', kind: 'five_hour', untilMs: reset }, { id: 'w', taskId: 't' });
    expect(m.claimsPausedUntil).toBe(lift);
    expect(wakes.some(w => w.at === lift)).toBe(true);
  });

  // The classified-failure and rapid-failure pauses live inside the worker
  // completion callback, which cannot be driven in isolation: pin the wiring.
  test('classified global pause and rapid-failure breaker arm a wake right after setting the pause', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf8');
    expect(src).toMatch(/this\.claimsPausedUntil = untilMs;\s*this\.consecutiveQuickFailures = 0;\s*this\.scheduleResumeAt\(this\.claimsPausedUntil,/);
    expect(src).toMatch(/this\.claimsPausedUntil = Date\.now\(\) \+ 5 \* 60 \* 1000;\s*this\.scheduleResumeAt\(this\.claimsPausedUntil,/);
  });
});
