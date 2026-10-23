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
  DEFAULT_BOOT_HOLD_SEC,
  planDrain,
  resumingSnapshot,
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

    expect(tick(d, { busy: 2, now: 0 })).toEqual({ action: 'wait', started: true });
    expect(d.claimsHalted()).toBe(true);
    expect(d.isDraining()).toBe(true);
    expect(lines.some((l) => l.includes('drain started') && l.includes('2 worker(s)'))).toBe(true);

    expect(tick(d, { busy: 1, now: 5 * MIN })).toEqual({ action: 'wait' });
    expect(d.claimsHalted()).toBe(true);

    const done = tick(d, { busy: 0, now: 12 * MIN });
    expect(done).toEqual({ action: 'apply', reason: 'drained', inFlight: 0, waitedMs: 12 * MIN });
    expect(lines.some((l) => l.includes('drain ended: every agent finished or paused'))).toBe(true);
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
    expect(tick(d, { busy: 1, now: 2 * MIN })).toEqual({ action: 'wait', started: true });
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

describe('UpdateDrain.snapshot (reported on the heartbeat)', () => {
  test('null until a drain opens, then since/endsAt/busy, null again after reset', () => {
    const d = new UpdateDrain({ windowMs: WINDOW }, capture().logger);
    expect(d.snapshot()).toBeNull();
    d.tick({ eligible: true, busy: 3, now: 1000 });
    expect(d.snapshot()).toEqual({ since: 1000, endsAt: 1000 + WINDOW, busy: 3, phase: 'draining', targetVersion: null, paused: [] });
    d.tick({ eligible: true, busy: 2, now: 1000 + MIN });
    expect(d.snapshot()?.busy).toBe(2);
    d.tick({ eligible: false, busy: 2, now: 1000 + 2 * MIN });
    expect(d.snapshot()).toBeNull();
  });
});

// ── Living Spec 47c97f48 "Runner updates in minutes" (r1) ──────────────────

describe('R-1: the window is short', () => {
  test('10 minutes by default; the env override is kept', () => {
    expect(DEFAULT_DRAIN_WINDOW_MIN).toBe(10);
    expect(readDrainConfig({}).windowMs).toBe(10 * MIN);
    expect(readDrainConfig({ BUILDD_UPDATE_DRAIN_WINDOW_MIN: '60' }).windowMs).toBe(60 * MIN);
  });

  test('the module no longer says running sessions die at the deadline', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/update-drain.ts'), 'utf-8');
    expect(src).not.toMatch(/sessions die/);
    expect(src).not.toMatch(/"Process restarted"\)/);
  });
});

describe('R-2 / AC-1 / AC-2: who finishes and who pauses, by estimate', () => {
  const W = 10 * MIN;
  test('AC-2: 4 minutes left by its estimate finishes; no estimate pauses', () => {
    const now = 100 * MIN;
    const plan = planDrain([
      { workerId: 'short', startedAt: now - 26 * MIN, estimateMinutes: 30 },
      { workerId: 'none', startedAt: now - 5 * MIN, estimateMinutes: null },
    ], now, W);
    expect(plan.finish).toEqual(['short']);
    expect(plan.pause).toEqual(['none']);
    expect(plan.why.short).toBe('4min left by its estimate');
    expect(plan.why.none).toBe('no estimate');
  });

  test('AC-1: an agent with 2h left is paused now', () => {
    const now = 100 * MIN;
    const plan = planDrain([{ workerId: 'long', startedAt: now - 10 * MIN, estimateMinutes: 130 }], now, W);
    expect(plan.pause).toEqual(['long']);
    expect(plan.why.long).toBe('2h left by its estimate');
  });

  test('past its estimate, or no start time: paused (nothing says when it ends)', () => {
    const now = 100 * MIN;
    const plan = planDrain([
      { workerId: 'over', startedAt: now - 50 * MIN, estimateMinutes: 30 },
      { workerId: 'nostart', startedAt: null, estimateMinutes: 5 },
      { workerId: 'edge', startedAt: now, estimateMinutes: 10 },
    ], now, W);
    expect(plan.pause).toEqual(['over', 'nostart']);
    expect(plan.finish).toEqual(['edge']); // exactly the window still fits
  });

  test('AC-1: once the long agent has paused the update applies, well inside the window', () => {
    const { d } = drain();
    expect(tick(d, { busy: 1, now: 0 })).toEqual({ action: 'wait', started: true });
    // Paused at its next safe point: no longer busy.
    expect(tick(d, { busy: 0, now: 40_000 })).toMatchObject({ action: 'apply', reason: 'drained', waitedMs: 40_000 });
  });
});

describe('R-5: the heartbeat says the runner is updating, not free', () => {
  test('draining names the target and the paused agents; applying reports updating with the apply time as the window end', () => {
    const d = new UpdateDrain({ windowMs: 10 * MIN }, capture().logger);
    const paused = [{ workerId: 'w-1', taskId: 't-1', title: 'Long task', since: 20_000 }];
    d.tick({ eligible: true, busy: 1, now: 1_000 });
    expect(d.snapshot({ targetVersion: 'abc1234', paused })).toEqual({
      since: 1_000, endsAt: 1_000 + 10 * MIN, busy: 1, phase: 'draining', targetVersion: 'abc1234', paused,
    });
    d.tick({ eligible: true, busy: 0, now: 60_000 });
    expect(d.isApplying()).toBe(true);
    expect(d.snapshot({ targetVersion: 'abc1234', paused })).toEqual({
      since: 1_000, endsAt: 60_000, busy: 0, phase: 'updating', targetVersion: 'abc1234', paused,
    });
  });

  test('after the restart: updating while agents paused for it have not continued, then nothing', () => {
    const paused = [{ workerId: 'w-1', taskId: 't-1', title: 'Long task', since: 5_000 }];
    expect(resumingSnapshot(paused, 9_000, '0.377.0')).toEqual({ since: 5_000, endsAt: 9_000, busy: 0, phase: 'updating', targetVersion: '0.377.0', paused });
    expect(resumingSnapshot([], 9_000, '0.377.0')).toBeNull();
  });
});

describe('boot hold: a fresh start learns about a waiting update before it claims', () => {
  test('claims are halted from boot until released', () => {
    const c = capture();
    const d = new UpdateDrain({ windowMs: WINDOW, bootHoldMs: 90_000 }, c.logger);
    d.holdForBoot(0);
    expect(d.claimsHalted(1_000)).toBe(true);
    d.releaseBootHold('version known, no update');
    expect(d.claimsHalted(2_000)).toBe(false);
    expect(c.lines.some(l => l.includes('boot hold released'))).toBe(true);
  });

  test('an update found at boot applies as idle and stays halted after the release', () => {
    const d = new UpdateDrain({ windowMs: WINDOW, bootHoldMs: 90_000 }, capture().logger);
    d.holdForBoot(0);
    expect(d.tick({ eligible: true, busy: 0, now: 5_000 })).toMatchObject({ action: 'apply', reason: 'idle' });
    d.releaseBootHold('version known');
    expect(d.claimsHalted(6_000)).toBe(true);
  });

  test('the hold lapses at its bound and says so once', () => {
    const c = capture();
    const d = new UpdateDrain({ windowMs: WINDOW, bootHoldMs: 90_000 }, c.logger);
    d.holdForBoot(0);
    expect(d.claimsHalted(89_999)).toBe(true);
    expect(d.claimsHalted(90_000)).toBe(false);
    expect(d.claimsHalted(91_000)).toBe(false);
    expect(c.lines.filter(l => l.includes('boot hold expired'))).toHaveLength(1);
  });

  test('a zero hold holds nothing', () => {
    const d = new UpdateDrain({ windowMs: WINDOW, bootHoldMs: 0 }, capture().logger);
    d.holdForBoot(0);
    expect(d.claimsHalted(1)).toBe(false);
  });

  test('BUILDD_UPDATE_BOOT_HOLD_SEC: default 90, 0 is off, junk is the default', () => {
    expect(DEFAULT_BOOT_HOLD_SEC).toBe(90);
    expect(readDrainConfig({}).bootHoldMs).toBe(90_000);
    expect(readDrainConfig({ BUILDD_UPDATE_BOOT_HOLD_SEC: '0' }).bootHoldMs).toBe(0);
    expect(readDrainConfig({ BUILDD_UPDATE_BOOT_HOLD_SEC: '30' }).bootHoldMs).toBe(30_000);
    expect(readDrainConfig({ BUILDD_UPDATE_BOOT_HOLD_SEC: 'soon' }).bootHoldMs).toBe(90_000);
    expect(readDrainConfig({ BUILDD_UPDATE_BOOT_HOLD_SEC: '-5' }).bootHoldMs).toBe(90_000);
  });

  test('index.ts holds at boot and runs the update tick before releasing the hold', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf-8');
    expect(src).toContain('updateDrain.holdForBoot(');
    const body = src.slice(src.indexOf('async function setLatestCommit('), src.indexOf('async function setLatestCommit(') + 6000);
    const tickAt = body.indexOf('void updateTick()');
    const releaseAt = body.indexOf('releaseBootHold(');
    expect(tickAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(tickAt);
  });
});

describe('R-3 / R-4: the update restart goes through the pause path', () => {
  test('index.ts pauses, checkpoints and pushes before applying, and restarts with the update cause', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf-8');
    const tick = src.slice(src.indexOf('async function updateTick('));
    const prepare = tick.indexOf('prepareAgentsForUpdate(');
    const apply = tick.indexOf('await applyUpdate()');
    expect(prepare).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(prepare);
    expect(tick).toContain("scheduleGracefulRestart('idle auto-update', { pauseCause: 'update' })");
  });
});
