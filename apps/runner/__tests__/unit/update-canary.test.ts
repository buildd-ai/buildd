/**
 * Post-update canary (apps/runner/src/update-canary.ts).
 *
 * A runner that just updated watches its own terminal outcomes per role and,
 * if one role starts failing deterministically, rolls itself back. Every git /
 * process operation here is faked — nothing touches a real checkout.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  UpdateCanary,
  applyBoot,
  classifyWorkerOutcome,
  emptyCanaryState,
  errorSignature,
  readCanaryConfig,
  recordOutcome,
  runCanaryTrip,
  type CanaryConfig,
  type CanaryOutcome,
  type CanaryState,
  type CanaryTripDeps,
} from '../../src/update-canary';
import { rollbackTo, type UpdateExecOps } from '../../src/updater';

const GOOD = 'a'.repeat(40);
const BAD = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);

const cfg: CanaryConfig = { enabled: true, tripCount: 3, windowMs: 6 * 60 * 60_000 };

function onProbation(now = 1_000): CanaryState {
  const booted = applyBoot({ ...emptyCanaryState(), lastBootCommit: GOOD }, BAD, now);
  return booted;
}

function fail(role: string, error: string, workspaceId = 'ws-1'): CanaryOutcome {
  return { role, workspaceId, ...classifyWorkerOutcome({ status: 'error', error }) };
}
function ok(role: string): CanaryOutcome {
  return { role, workspaceId: 'ws-1', ...classifyWorkerOutcome({ status: 'done' }) };
}

function feed(state: CanaryState, outcomes: CanaryOutcome[], now = 2_000) {
  let s = state;
  const decisions = [];
  for (const o of outcomes) {
    const r = recordOutcome(s, o, cfg, now);
    s = r.state;
    decisions.push(r);
  }
  return { state: s, decisions, last: decisions[decisions.length - 1] };
}

describe('readCanaryConfig', () => {
  test('defaults ON with trip count 3', () => {
    const c = readCanaryConfig({});
    expect(c.enabled).toBe(true);
    expect(c.tripCount).toBe(3);
    expect(c.windowMs).toBeGreaterThan(0);
  });

  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    test(`kill switch BUILDD_UPDATE_CANARY=${off} disables it`, () => {
      expect(readCanaryConfig({ BUILDD_UPDATE_CANARY: off }).enabled).toBe(false);
    });
  }

  test('trip count is configurable but never below 2', () => {
    expect(readCanaryConfig({ BUILDD_UPDATE_CANARY_TRIP_COUNT: '5' }).tripCount).toBe(5);
    expect(readCanaryConfig({ BUILDD_UPDATE_CANARY_TRIP_COUNT: '1' }).tripCount).toBe(2);
    expect(readCanaryConfig({ BUILDD_UPDATE_CANARY_TRIP_COUNT: 'nope' }).tripCount).toBe(3);
  });
});

describe('applyBoot — entering probation', () => {
  test('a boot on a different commit than last boot records the previous SHA as rollback target', () => {
    const s = onProbation(1_000);
    expect(s.probation).not.toBeNull();
    expect(s.probation!.fromCommit).toBe(GOOD);
    expect(s.probation!.toCommit).toBe(BAD);
    expect(s.lastBootCommit).toBe(BAD);
  });

  test('first ever boot (no prior commit) is not a probation', () => {
    const s = applyBoot(emptyCanaryState(), GOOD, 1_000);
    expect(s.probation).toBeNull();
    expect(s.lastBootCommit).toBe(GOOD);
  });

  test('a restart on the same commit keeps the probation and its tallies', () => {
    const { state } = feed(onProbation(), [fail('reviewer', 'boom')]);
    const again = applyBoot(state, BAD, 5_000);
    expect(again.probation!.roles.reviewer.failureStreak).toBe(1);
    expect(again.probation!.startedAt).toBe(1_000);
  });
});

describe('recordOutcome — probation pass', () => {
  test('a role that succeeded once can no longer trip', () => {
    const { state, decisions } = feed(onProbation(), [
      ok('reviewer'),
      fail('reviewer', 'boom'),
      fail('reviewer', 'boom'),
      fail('reviewer', 'boom'),
    ]);
    expect(decisions.every(d => d.event !== 'trip')).toBe(true);
    expect(state.probation!.roles.reviewer.successes).toBe(1);
  });

  test('probation passes once the time bound elapses with no trip', () => {
    const { state } = feed(onProbation(1_000), [ok('builder'), fail('reviewer', 'x')]);
    const r = recordOutcome(state, ok('builder'), cfg, 1_000 + cfg.windowMs + 1);
    expect(r.event).toBe('passed');
    expect(r.state.probation).toBeNull();
  });

  test('outcomes outside probation are ignored', () => {
    const s = applyBoot(emptyCanaryState(), GOOD, 1_000);
    const r = recordOutcome(s, fail('reviewer', 'boom'), cfg, 2_000);
    expect(r.event).toBe('none');
  });
});

describe('recordOutcome — trip rule', () => {
  test('trips on 3 identical failures of the same role with zero successes', () => {
    const { last, state } = feed(onProbation(), [
      fail('reviewer', 'TypeError: cannot read properties of undefined (reading "diff")'),
      fail('reviewer', 'TypeError: cannot read properties of undefined (reading "diff")'),
      fail('reviewer', 'TypeError: cannot read properties of undefined (reading "diff")'),
    ]);
    expect(last.event).toBe('trip');
    expect(last.trip!.role).toBe('reviewer');
    expect(last.trip!.rollbackTo).toBe(GOOD);
    expect(last.trip!.badCommit).toBe(BAD);
    expect(last.trip!.failures).toBe(3);
    expect(last.trip!.rollback).toBe(true);
    expect(state.lastTrip!.badCommit).toBe(BAD);
  });

  test('signature ignores ids/numbers so the same bug in different tasks still matches', () => {
    expect(errorSignature('worker 3f2a9c1e-1111-2222-3333-444455556666 failed at line 42'))
      .toBe(errorSignature('worker 9e8d7c6b-aaaa-bbbb-cccc-ddddeeeeffff failed at line 97'));
  });

  test('other roles interleaving do not break a role\'s streak', () => {
    const { last } = feed(onProbation(), [
      fail('reviewer', 'boom'),
      ok('builder'),
      fail('reviewer', 'boom'),
      ok('builder'),
      fail('reviewer', 'boom'),
    ]);
    expect(last.event).toBe('trip');
  });

  test('does not trip twice in one probation', () => {
    const { decisions } = feed(onProbation(), [
      fail('reviewer', 'boom'), fail('reviewer', 'boom'), fail('reviewer', 'boom'), fail('reviewer', 'boom'),
    ]);
    expect(decisions.filter(d => d.event === 'trip').length).toBe(1);
  });

  test('no trip on mixed signatures', () => {
    const { decisions } = feed(onProbation(), [
      fail('reviewer', 'boom'),
      fail('reviewer', 'ENOENT: no such file tests/x.ts'),
      fail('reviewer', 'boom'),
      fail('reviewer', 'assertion failed: expected 2'),
    ]);
    expect(decisions.every(d => d.event !== 'trip')).toBe(true);
  });

  test('no trip across different roles with the same signature', () => {
    const { decisions } = feed(onProbation(), [
      fail('reviewer', 'boom'), fail('builder', 'boom'), fail('researcher', 'boom'),
    ]);
    expect(decisions.every(d => d.event !== 'trip')).toBe(true);
  });

  const infra = [
    'Invalid API key · Please run /login',
    "You've hit your session limit · resets 8:40pm (UTC)",
    "You're out of extra usage · resets 11:20am (UTC)",
    'Session cost cap reached',
    'Worker was never started by a runner (claimed but no session began)',
    'fetch failed: ECONNRESET',
    'connect ETIMEDOUT',
    'Process restarted',
    'Terminated by server',
    'Task failed or was cancelled on remote server',
    'Deferred: another codex worker is active',
    'needs_input: which branch?',
  ];
  for (const text of infra) {
    test(`no trip on infra-class failure: ${text.slice(0, 40)}`, () => {
      expect(classifyWorkerOutcome({ status: 'error', error: text }).kind).toBe('infra');
      const { decisions } = feed(onProbation(), [fail('reviewer', text), fail('reviewer', text), fail('reviewer', text)]);
      expect(decisions.every(d => d.event !== 'trip')).toBe(true);
    });
  }

  test('infra failures neither advance nor reset a streak', () => {
    const { last } = feed(onProbation(), [
      fail('reviewer', 'boom'),
      fail('reviewer', 'fetch failed: ECONNRESET'),
      fail('reviewer', 'boom'),
      fail('reviewer', 'boom'),
    ]);
    expect(last.event).toBe('trip');
  });

  test('re-applied bad SHA trips without a second automatic rollback', () => {
    const first = feed(onProbation(), [fail('reviewer', 'boom'), fail('reviewer', 'boom'), fail('reviewer', 'boom')]);
    // rollback landed, then someone re-applied BAD anyway
    let s = applyBoot({ ...first.state, pendingRollbackTo: GOOD }, GOOD, 10_000);
    s = applyBoot(s, BAD, 20_000);
    const again = feed(s, [fail('reviewer', 'boom'), fail('reviewer', 'boom'), fail('reviewer', 'boom')], 21_000);
    expect(again.last.event).toBe('trip');
    expect(again.last.trip!.rollback).toBe(false);
  });
});

describe('skip latch', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'canary-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('after a rollback lands, the bad SHA stays skipped and the good SHA is not a new probation', () => {
    const file = join(dir, 'update-canary.json');
    const c1 = new UpdateCanary({ file, config: cfg, now: () => 1_000 });
    c1.boot(GOOD);
    const c2 = new UpdateCanary({ file, config: cfg, now: () => 2_000 });
    c2.boot(BAD);
    expect(c2.onProbation()).toBe(true);
    let trip = null;
    for (let i = 0; i < 3; i++) trip = c2.recordOutcome(fail('reviewer', 'boom')).trip ?? trip;
    expect(trip).not.toBeNull();
    c2.markRollbackStarted(trip!);

    // restart after the rollback — on GOOD
    const c3 = new UpdateCanary({ file, config: cfg, now: () => 3_000 });
    c3.boot(GOOD);
    expect(c3.onProbation()).toBe(false);
    expect(c3.isSkipped(BAD)).toBe(true);
    expect(c3.report().lastTrip?.rollbackStatus).toBe('succeeded');
  });

  test('a newer SHA than the skipped one is not skipped, and booting it clears the latch', () => {
    const s: CanaryState = { ...emptyCanaryState(), lastBootCommit: GOOD, skippedCommit: BAD };
    const file = join(dir, 'update-canary.json');
    const c = new UpdateCanary({ file, config: cfg, now: () => 1_000, initialState: s });
    expect(c.isSkipped(BAD)).toBe(true);
    expect(c.isSkipped(NEWER)).toBe(false);
    c.boot(NEWER);
    expect(c.isSkipped(BAD)).toBe(false);
    expect(c.onProbation()).toBe(true);
  });

  test('kill switch: skip latch and probation are inert', () => {
    const file = join(dir, 'update-canary.json');
    const off = { ...cfg, enabled: false };
    const c = new UpdateCanary({ file, config: off, now: () => 1_000, initialState: { ...emptyCanaryState(), lastBootCommit: GOOD, skippedCommit: BAD } });
    c.boot(BAD);
    expect(c.isSkipped(BAD)).toBe(false);
    expect(c.onProbation()).toBe(false);
    expect(c.recordOutcome(fail('reviewer', 'boom')).event).toBe('none');
  });

  test('state persists in the state dir file, not the repo', () => {
    const file = join(dir, 'update-canary.json');
    const c = new UpdateCanary({ file, config: cfg, now: () => 1_000 });
    c.boot(GOOD);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).lastBootCommit).toBe(GOOD);
  });

  test('a corrupt state file fails open to an empty state', () => {
    const file = join(dir, 'update-canary.json');
    require('fs').writeFileSync(file, '{not json');
    const c = new UpdateCanary({ file, config: cfg, now: () => 1_000 });
    c.boot(GOOD);
    expect(c.onProbation()).toBe(false);
  });
});

describe('runCanaryTrip — rollback mechanics', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'canary-trip-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function trippedCanary() {
    const file = join(dir, 'update-canary.json');
    const c = new UpdateCanary({ file, config: cfg, now: () => 2_000, initialState: { ...emptyCanaryState(), lastBootCommit: GOOD } });
    c.boot(BAD);
    let trip = null;
    for (let i = 0; i < 3; i++) trip = c.recordOutcome(fail('reviewer', 'boom', 'ws-42')).trip ?? trip;
    return { c, trip: trip!, file };
  }

  function deps(overrides: Partial<CanaryTripDeps> = {}) {
    const calls: string[] = [];
    const d: CanaryTripDeps = {
      emit: (e) => { calls.push(`emit:${e.type}`); },
      reportFriction: async (f) => { calls.push(`friction:${f.workspaceId}:${f.signature}`); },
      waitForIdle: async () => { calls.push('idle'); },
      rollbackTo: async (sha) => { calls.push(`rollback:${sha}`); return { success: true, newCommit: sha }; },
      restart: (reason) => { calls.push(`restart:${reason.slice(0, 15)}`); },
      setUpdating: (on) => { calls.push(`updating:${on}`); },
      ...overrides,
    };
    return { d, calls };
  }

  test('halts claims, reports friction, waits idle, rolls back to the recorded SHA, then restarts', async () => {
    const { c, trip } = trippedCanary();
    const { d, calls } = deps();
    await runCanaryTrip(c, trip, d);
    expect(calls).toContain(`rollback:${GOOD}`);
    expect(calls.findIndex(x => x.startsWith('friction:ws-42:'))).toBeLessThan(calls.indexOf(`rollback:${GOOD}`));
    expect(calls.indexOf('idle')).toBeLessThan(calls.indexOf(`rollback:${GOOD}`));
    expect(calls[calls.length - 1].startsWith('restart:')).toBe(true);
    expect(c.claimsHalted()).toBe(true);
    // the skip latch is persisted BEFORE the reset, so a crash mid-rollback cannot re-apply it
    expect(c.isSkipped(BAD)).toBe(true);
  });

  test('the rollback goes through updater.rollbackTo: reset --hard <recorded sha> + clean reinstall', async () => {
    const { c, trip } = trippedCanary();
    const gitCalls: string[][] = [];
    let installed = false;
    const exec: UpdateExecOps = {
      git: async (args) => { gitCalls.push(args); return ''; },
      bunVersion: async () => {},
      bunInstall: async () => { installed = true; },
    };
    const install = join(dir, 'install');
    const { d } = deps({ rollbackTo: (sha) => rollbackTo(sha, install, { rmSync: () => {} } as any, exec) });
    await runCanaryTrip(c, trip, d);
    expect(gitCalls).toContainEqual(['reset', '--hard', GOOD]);
    expect(installed).toBe(true);
  });

  test('friction carries a stable signature (same bad SHA + role dedupes across runners)', async () => {
    const a = trippedCanary();
    const seen: string[] = [];
    await runCanaryTrip(a.c, a.trip, deps({ reportFriction: async (f) => { seen.push(f.signature); expect(f.title.startsWith('[friction] ')).toBe(true); } }).d);
    expect(seen[0]).toContain('runner-update-regression');
    expect(seen[0]).toContain('reviewer');
    expect(seen[0]).toContain(BAD.slice(0, 7));
  });

  test('a failed rollback does not restart and keeps claims halted', async () => {
    const { c, trip } = trippedCanary();
    const { d, calls } = deps({ rollbackTo: async () => ({ success: false, error: 'bun install failed' }) });
    await runCanaryTrip(c, trip, d);
    expect(calls.some(x => x.startsWith('restart:'))).toBe(false);
    expect(c.claimsHalted()).toBe(true);
    expect(c.report().lastTrip?.rollbackStatus).toBe('failed');
    expect(calls).toContain('updating:false');
  });

  test('a friction-report failure does not block the rollback', async () => {
    const { c, trip } = trippedCanary();
    const { d, calls } = deps({ reportFriction: async () => { throw new Error('401'); } });
    await runCanaryTrip(c, trip, d);
    expect(calls).toContain(`rollback:${GOOD}`);
  });

  test('a trip flagged no-rollback reports and halts but never resets', async () => {
    const { c, trip } = trippedCanary();
    const { d, calls } = deps();
    await runCanaryTrip(c, { ...trip, rollback: false }, d);
    expect(calls.some(x => x.startsWith('rollback:'))).toBe(false);
    expect(calls.some(x => x.startsWith('friction:'))).toBe(true);
    expect(c.claimsHalted()).toBe(true);
  });

  test('report() exposes the trip for the heartbeat', async () => {
    const { c, trip } = trippedCanary();
    await runCanaryTrip(c, trip, deps().d);
    const r = c.report();
    expect(r.enabled).toBe(true);
    expect(r.claimsHalted).toBe(true);
    expect(r.lastTrip?.role).toBe('reviewer');
    expect(r.lastTrip?.badCommit).toBe(BAD.slice(0, 12));
  });
});
