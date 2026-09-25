/**
 * Drain-before-restart (apps/runner/src/update-drain.ts).
 *
 * A busy runner used to never apply an update: the auto-updater waited for
 * five idle minutes that a steadily-claiming runner never has. Now an eligible
 * update halts claims at once and applies when the runner is idle, drained, or
 * out of drain time.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  UpdateDrain,
  readDrainConfig,
  initUpdateDrain,
  claimsHaltedForUpdate,
  DEFAULT_DRAIN_WINDOW_MIN,
  type DrainTickInput,
} from '../../src/update-drain';
import { canAttemptAutoUpdate, isAutoUpdateDisabled } from '../../src/updater';
import { applyBoot, emptyCanaryState, isInfraClassFailure } from '../../src/update-canary';

const WINDOW = 30 * 60_000;
const MIN = 60_000;

function capture() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (...a: unknown[]) => { lines.push(a.join(' ')); },
      warn: (...a: unknown[]) => { lines.push(a.join(' ')); },
    },
  };
}

function drain() {
  const c = capture();
  return { d: new UpdateDrain({ windowMs: WINDOW }, c.logger), lines: c.lines };
}

const tick = (d: UpdateDrain, i: Partial<DrainTickInput> & { now: number }) =>
  d.tick({ eligible: true, busy: 0, ...i });

describe('readDrainConfig', () => {
  test('defaults to the documented window', () => {
    expect(readDrainConfig({}).windowMs).toBe(DEFAULT_DRAIN_WINDOW_MIN * MIN);
  });
  test('BUILDD_UPDATE_DRAIN_WINDOW_MIN overrides; junk falls back to the default', () => {
    expect(readDrainConfig({ BUILDD_UPDATE_DRAIN_WINDOW_MIN: '15' }).windowMs).toBe(15 * MIN);
    expect(readDrainConfig({ BUILDD_UPDATE_DRAIN_WINDOW_MIN: 'abc' }).windowMs).toBe(DEFAULT_DRAIN_WINDOW_MIN * MIN);
    expect(readDrainConfig({ BUILDD_UPDATE_DRAIN_WINDOW_MIN: '0' }).windowMs).toBe(DEFAULT_DRAIN_WINDOW_MIN * MIN);
  });
});

describe('update detected while busy', () => {
  test('claiming stops at once, and the update applies only after workers finish', () => {
    const { d, lines } = drain();
    expect(d.claimsHalted()).toBe(false);

    expect(tick(d, { busy: 2, now: 0 })).toEqual({ action: 'wait' });
    expect(d.claimsHalted()).toBe(true);
    expect(d.isDraining()).toBe(true);
    expect(lines.some((l) => l.includes('drain started') && l.includes('2 worker(s)'))).toBe(true);

    expect(tick(d, { busy: 1, now: 5 * MIN })).toEqual({ action: 'wait' });
    expect(d.claimsHalted()).toBe(true);

    const done = tick(d, { busy: 0, now: 12 * MIN });
    expect(done).toEqual({ action: 'apply', reason: 'drained', inFlight: 0, waitedMs: 12 * MIN });
    expect(lines.some((l) => l.includes('drain ended: completed'))).toBe(true);
    // Claims stay halted through the apply: the process is about to restart.
    expect(d.claimsHalted()).toBe(true);
    expect(tick(d, { busy: 0, now: 13 * MIN })).toEqual({ action: 'none' });
  });

  test('the drain clock starts at detection, not at each tick', () => {
    const { d } = drain();
    tick(d, { busy: 1, now: 1_000 });
    expect(d.drainStartedAt()).toBe(1_000);
    tick(d, { busy: 1, now: 2 * MIN });
    expect(d.drainStartedAt()).toBe(1_000);
  });
});

describe('drain timeout', () => {
  test('restarts anyway once the window expires, reporting what was still running', () => {
    const { d, lines } = drain();
    tick(d, { busy: 3, now: 0 });
    expect(tick(d, { busy: 3, now: WINDOW - 1 })).toEqual({ action: 'wait' });

    const r = tick(d, { busy: 2, now: WINDOW });
    expect(r).toEqual({ action: 'apply', reason: 'timeout', inFlight: 2, waitedMs: WINDOW });
    expect(lines.some((l) => l.includes('drain ended: timeout') && l.includes('2 worker(s)'))).toBe(true);
  });

  test('work killed by the timeout restart is reported as infra, so the new build is not blamed for it', () => {
    // worker-sync reports a killed session as exactly this error on the next boot.
    expect(isInfraClassFailure('Process restarted')).toBe(true);
  });
});

describe('idle runner (regression)', () => {
  test('applies on the first eligible tick with no drain wait and no idle delay', () => {
    const { d, lines } = drain();
    expect(tick(d, { busy: 0, now: 0 })).toEqual({ action: 'apply', reason: 'idle', inFlight: 0, waitedMs: 0 });
    expect(d.claimsHalted()).toBe(true);
    expect(d.isDraining()).toBe(false);
    expect(lines.some((l) => l.includes('drain started'))).toBe(false);
  });

  test('eligibility no longer depends on idle time — a runner busy until this very tick is eligible', () => {
    const now = 1_000_000;
    expect(canAttemptAutoUpdate({
      target: 'a'.repeat(40), skipped: new Set(), retriesSpent: 0, spentAgainstCommit: null,
      lastIdleAt: now, now, idleDelayMs: 0,
    })).toBe(true);
  });
});

describe('manual mode / kill switch', () => {
  test('BUILDD_DISABLE_AUTO_UPDATE makes nothing eligible, so claims continue and nothing restarts', () => {
    expect(isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: '1' })).toBe(true);
    const { d } = drain();
    for (const busy of [0, 2]) {
      expect(d.tick({ eligible: !isAutoUpdateDisabled({ BUILDD_DISABLE_AUTO_UPDATE: '1' }), busy, now: 10 * WINDOW })).toEqual({ action: 'none' });
    }
    expect(d.claimsHalted()).toBe(false);
  });

  test('switching to manual mode mid-drain cancels the drain and resumes claims', () => {
    const { d, lines } = drain();
    tick(d, { busy: 1, now: 0 });
    expect(d.claimsHalted()).toBe(true);
    expect(d.tick({ eligible: false, busy: 1, now: 2 * WINDOW })).toEqual({ action: 'none' });
    expect(d.claimsHalted()).toBe(false);
    expect(lines.some((l) => l.includes('drain cancelled'))).toBe(true);
  });
});

describe('apply that does not restart', () => {
  test('releases the claim halt so the runner goes back to work', () => {
    const { d, lines } = drain();
    tick(d, { busy: 1, now: 0 });
    tick(d, { busy: 0, now: MIN });
    expect(d.claimsHalted()).toBe(true);
    d.applyFailed('health probe failed');
    expect(d.claimsHalted()).toBe(false);
    expect(lines.some((l) => l.includes('resuming claims'))).toBe(true);
    // A later eligible tick can start a fresh drain.
    expect(tick(d, { busy: 1, now: 2 * MIN })).toEqual({ action: 'wait' });
    expect(d.drainStartedAt()).toBe(2 * MIN);
  });
});

describe('claim gate', () => {
  beforeEach(() => { initUpdateDrain({ windowMs: WINDOW }, capture().logger); });

  test('claimsHaltedForUpdate follows the singleton drain', () => {
    const d = initUpdateDrain({ windowMs: WINDOW }, capture().logger);
    expect(claimsHaltedForUpdate()).toBe(false);
    d.tick({ eligible: true, busy: 1, now: 0 });
    expect(claimsHaltedForUpdate()).toBe(true);
  });

  test('both claim paths in WorkerManager consult it', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf-8');
    const poll = src.slice(src.indexOf('async claimPendingTasks('), src.indexOf('async claimPendingTasks(') + 1500);
    const push = src.slice(src.indexOf('async claimAndStart('), src.indexOf('async claimAndStart(') + 1500);
    expect(poll).toContain('claimsHaltedForUpdate()');
    expect(push).toContain('claimsHaltedForUpdate()');
  });
});

describe('post-update canary', () => {
  test('a boot after a drained update still records the previous SHA as the rollback target', () => {
    const PREV = 'a'.repeat(40);
    const NEXT = 'b'.repeat(40);
    const before = applyBoot(emptyCanaryState(), PREV, 0);
    const { d } = drain();
    tick(d, { busy: 1, now: 0 });
    expect(tick(d, { busy: 0, now: MIN }).action).toBe('apply');
    const after = applyBoot(before, NEXT, 2 * MIN);
    expect(after.probation?.fromCommit).toBe(PREV);
    expect(after.probation?.toCommit).toBe(NEXT);
  });
});
