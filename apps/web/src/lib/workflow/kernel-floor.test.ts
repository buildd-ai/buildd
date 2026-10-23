/**
 * The kernel's drain and floor as one pass, and who runs it
 * (docs/specs/workflow-kernel-library.md §3, AC-10): the control plane's cron
 * in own mode, nothing in shadow or on another host; each step isolated.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';

// The per-minute tick's due-queues (effect-timer.ts, trunk-recheck.ts), in memory.
const due = new Map<string, Map<string, number>>();
const queue = (job: string) => { if (!due.has(job)) due.set(job, new Map()); return due.get(job)!; };
const realRedis = await import('@/lib/redis');
mock.module('@/lib/redis', () => ({
  ...realRedis,
  markDueEarliest: async (job: string, member: string, at: number) => { const q = queue(job); const p = q.get(member); if (p === undefined || at < p) q.set(member, at); },
  clearDue: async (job: string, members: string | string[]) => { for (const m of [members].flat()) queue(job).delete(m); },
  countDue: async (job: string, now: number) => [...queue(job).values()].filter((t) => t <= now).length,
  listDue: async (job: string, now: number, limit: number) => [...queue(job).entries()].filter(([, t]) => t <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m),
}));

import { REVIEW_DISPATCH_BACKOFF_MS, REVIEW_DISPATCH_RETRIES } from '@buildd/workflow-kernel/handlers/review';
import { KERNEL_FLOOR_PERIOD_MS, kernelFloorOutcome, runKernelFloor, runScheduledEffectTick, runScheduledKernelFloor, type KernelFloorDeps } from './kernel-floor';
import { TRUNK_RECHECK_QUEUE, scheduleTrunkRecheck } from './trunk-recheck';
import { setKernelHost } from './kernel-host';
import { setKernelSpanSink, type KernelSpanRecord } from './kernel-telemetry';

afterEach(() => { setKernelHost('web'); setKernelSpanSink(null); due.clear(); });

function steps(o: Partial<Record<keyof KernelFloorDeps, () => Promise<unknown>>> = {}) {
  const ran: string[] = [];
  const step = <T>(name: string, value: T) => async () => { ran.push(name); if (o[name as keyof KernelFloorDeps]) return o[name as keyof KernelFloorDeps]!() as Promise<T>; return value; };
  const deps: KernelFloorDeps = {
    drainDueEffects: step('drainDueEffects', { claimed: 2, done: 2, skipped: 0, failed: 0, lost: 0, dead: [] }) as KernelFloorDeps['drainDueEffects'],
    drainDueEpochEffects: step('drainDueEpochEffects', { claimed: 1, done: 1, skipped: 0, failed: 0, lost: 0, dead: 0, ran: [] }),
    reconcileTrunkIncidents: step('reconcileTrunkIncidents', { checked: 1, resolved: 1, recovered: 1, stillRed: 0, errors: 0 }),
    reconcileKernelDeliveries: step('reconcileKernelDeliveries', { checked: 3, imported: 1, enqueued: 1, errors: 0 }),
    restartTreadmillCycles: step('restartTreadmillCycles', { checked: 1, restarted: 1, refused: 0, errors: 0 }) as KernelFloorDeps['restartTreadmillCycles'],
    pruneCommands: step('pruneCommands', 4),
    drainParkedCommands: step('drainParkedCommands', { claimed: 2, done: 1, retried: 1, dead: 0, pruned: 0 }),
    publishOpenPrStatuses: step('publishOpenPrStatuses', {
      repos: 1, checked: 2, published: 1, republished: 1, unchanged: 0, candidates: 0, errors: 0,
      coverage: { context: 'Buildd / Review approval', checked: 2, missing: [], verdict: 'covered' },
    }) as KernelFloorDeps['publishOpenPrStatuses'],
    sweepDeadEffects: step('sweepDeadEffects', { closed: 0, live: 0, oldestAgeS: 0, byKind: {} }) as KernelFloorDeps['sweepDeadEffects'],
    readOutboxDepth: async () => ({ parked: 1, parkedOldestAgeS: 5400, effectsDue: 2, effectsOldestAgeS: 30 }),
  };
  return { ran, deps };
}

describe('the scheduled pass', () => {
  it('runs every step on the control plane in own mode', async () => {
    setKernelHost('control-plane');
    const s = steps();
    const r = await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' }, deps: s.deps });
    expect(r.ran).toBe(true);
    expect(s.ran.sort()).toEqual(['drainDueEffects', 'drainDueEpochEffects', 'drainParkedCommands', 'pruneCommands', 'publishOpenPrStatuses', 'reconcileKernelDeliveries', 'reconcileTrunkIncidents', 'restartTreadmillCycles', 'sweepDeadEffects']);
    expect(kernelFloorOutcome(r.result!)).toEqual({ processed: 12, changed: 10, errors: 0 });
  });

  it('does nothing in shadow, without the command key (not switched over), or on the web host whatever its mode', async () => {
    setKernelHost('control-plane');
    const a = steps();
    expect(await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'shadow', KERNEL_COMMAND_SECRET: 'k1:s' }, deps: a.deps })).toEqual({ ran: false, reason: 'shadow' });
    expect(await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'own', CRON_SECRET: 'c' }, deps: a.deps })).toEqual({ ran: false, reason: 'no_command_key' });
    setKernelHost('web');
    const b = steps();
    expect(await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' }, deps: b.deps })).toEqual({ ran: false, reason: 'not_control_plane' });
    expect([...a.ran, ...b.ran]).toEqual([]);
  });

  it('the liveness fallback: the control plane\'s floor is stale past two periods, or when it never ran', async () => {
    const { controlPlaneFloorStale, KERNEL_FLOOR_STALE_MS } = await import('./kernel-floor');
    const now = Date.now();
    expect(controlPlaneFloorStale(null, now)).toBe(true);
    // Both crons fire at :10. A healthy floor is about one period old when the web host looks (a slow
    // Worker run can land minutes later); one missed tick makes it about two periods old, minus jitter,
    // at the web host's next tick, which must catch it.
    expect(controlPlaneFloorStale(new Date(now - 70 * 60_000), now)).toBe(false);
    expect(controlPlaneFloorStale(new Date(now - (2 * 60 - 5) * 60_000), now)).toBe(true);
    expect(controlPlaneFloorStale(new Date(now - KERNEL_FLOOR_STALE_MS - 1), now)).toBe(true);
  });
});

describe('the treadmill cooldown', () => {
  it('is the landing sweep\'s cycle cooldown', async () => {
    const { LANDING_CYCLE_COOLDOWN_MS } = await import('@/lib/pr-landing-sweep');
    const { TREADMILL_COOLDOWN_MS } = await import('./kernel-floor');
    expect(TREADMILL_COOLDOWN_MS).toBe(LANDING_CYCLE_COOLDOWN_MS);
  });
});

// a81a100f: a review dispatch that cannot file a reviewer is re-queued with a backoff of n x
// REVIEW_DISPATCH_BACKOFF_MS. Nothing wakes a drain for it, so on a quiet PR the floor runs each
// retry. The spec's bound (review_unavailable within about two floor ticks) holds only while every
// retry is due before the next tick.
describe('review dispatch retries', () => {
  it('each retry is due before the next floor tick', () => {
    for (let n = 1; n <= REVIEW_DISPATCH_RETRIES; n++) expect(n * REVIEW_DISPATCH_BACKOFF_MS).toBeLessThan(KERNEL_FLOOR_PERIOD_MS);
  });
});

describe('isolation', () => {
  it('one step failing never discards the others, and counts as an error', async () => {
    const s = steps({ reconcileKernelDeliveries: async () => { throw new Error('github down'); } });
    const r = await runKernelFloor(s.deps);
    expect(r.kernelFloor).toEqual({ error: 'github down' });
    expect(r.kernelOutbox).toMatchObject({ done: 2 });
    expect(r.commandsPruned).toBe(4);
    expect(kernelFloorOutcome(r).errors).toBe(1);
  });

  it('a parked door command given up counts as an error; the parked step failing is isolated like any other', async () => {
    const buried = steps({ drainParkedCommands: async () => ({ claimed: 1, done: 0, retried: 0, dead: 1, pruned: 0 }) });
    expect(kernelFloorOutcome(await runKernelFloor(buried.deps)).errors).toBe(1);
    const failing = steps({ drainParkedCommands: async () => { throw new Error('db down'); } });
    const r = await runKernelFloor(failing.deps);
    expect(r.parkedCommands).toEqual({ error: 'db down' });
    expect(r.kernelOutbox).toMatchObject({ done: 2 });
    expect(kernelFloorOutcome(r).errors).toBe(1);
  });
});

// AC-76: the open-PR status coverage is an alert that can fail: every open head still without
// Buildd / Review approval is an error of the floor run, and a pass that read nothing is not "covered".
describe('open PR status coverage', () => {
  const summary = (coverage: Record<string, unknown>, errors = 0) => async () => ({
    repos: 1, checked: 2, published: 0, republished: 0, unchanged: 2, candidates: 0, errors, coverage: { context: 'Buildd / Review approval', ...coverage },
  });

  it('each open head missing the context counts as an error', async () => {
    const s = steps({ publishOpenPrStatuses: summary({ checked: 2, verdict: 'gaps', missing: [{ repoFullName: 'acme/app', prNumber: 4, sha: 'a'.repeat(40) }, { repoFullName: 'acme/app', prNumber: 5, sha: 'b'.repeat(40) }] }) });
    expect(kernelFloorOutcome(await runKernelFloor(s.deps)).errors).toBe(2);
  });

  it('the step failing is isolated and counts as an error', async () => {
    const s = steps({ publishOpenPrStatuses: async () => { throw new Error('github down'); } });
    const r = await runKernelFloor(s.deps);
    expect(r.openPrStatuses).toEqual({ error: 'github down' });
    expect(r.kernelOutbox).toMatchObject({ done: 2 });
    expect(kernelFloorOutcome(r).errors).toBe(1);
  });

  it('a pass over no open PR reports nothing_checked, which is not an error and not covered', async () => {
    const s = steps({ publishOpenPrStatuses: summary({ checked: 0, verdict: 'nothing_checked', missing: [] }) });
    const r = await runKernelFloor(s.deps);
    expect(r.openPrStatuses).toMatchObject({ coverage: { verdict: 'nothing_checked' } });
    expect(kernelFloorOutcome(r).errors).toBe(0);
  });
});

// The floor's span (workflow-kernel-library.md, Observability): outbox depth after the pass and its repairs per kind.
describe('the floor span', () => {
  it('one kernel.floor span per pass, with the depth left and the repairs', async () => {
    const spans: KernelSpanRecord[] = [];
    setKernelSpanSink((s) => { spans.push(s); });
    setKernelHost('control-plane');
    await runKernelFloor(steps().deps);
    expect(spans.map((s) => s.name)).toEqual(['kernel.floor']);
    expect(spans[0].attributes).toMatchObject({
      'kernel.host': 'control-plane',
      'kernel.outbox.parked': 1, 'kernel.outbox.parked_oldest_age_s': 5400, 'kernel.outbox.effects_due': 2, 'kernel.outbox.effects_oldest_age_s': 30,
      'kernel.floor.repairs.facts_imported': 1, 'kernel.floor.repairs.effects_enqueued': 1, 'kernel.floor.repairs.trunk_recovered': 1,
      'kernel.floor.repairs.treadmill_restarted': 1, 'kernel.floor.repairs.parked_answered': 1, 'kernel.floor.repairs.parked_dead': 0,
      'kernel.floor.errors': 0,
    });
    expect(spans[0].error).toBe(false);
  });

  it('a depth read that fails is reported unread, never as an empty outbox, and the pass still returns', async () => {
    const spans: KernelSpanRecord[] = [];
    setKernelSpanSink((s) => { spans.push(s); });
    const s = steps();
    const realError = console.error;
    console.error = () => {};
    try {
      const r = await runKernelFloor({ ...s.deps, readOutboxDepth: async () => { throw new Error('db down'); } });
      expect(r.kernelOutbox).toMatchObject({ done: 2 });
    } finally {
      console.error = realError;
    }
    expect(spans[0].attributes['kernel.outbox.unread']).toBe(true);
    expect('kernel.outbox.parked' in spans[0].attributes).toBe(false);
  });
});

describe('dead effects', () => {
  it('a sweep that closes rows is a repair; live dead effects ride the floor span and are not an error', async () => {
    const spans: KernelSpanRecord[] = [];
    setKernelSpanSink((r) => spans.push(r));
    const s = steps({ sweepDeadEffects: async () => ({ closed: 2, live: 3, oldestAgeS: 86_400, byKind: { publish_landing_status: 2, dispatch_ci_fix: 1 } }) });
    const r = await runKernelFloor(s.deps);
    expect(kernelFloorOutcome(r)).toEqual({ processed: 12, changed: 12, errors: 0 });
    const floor = spans.find((x) => x.name === 'kernel.floor')!;
    expect(floor.attributes['kernel.floor.dead_effects.closed']).toBe(2);
    expect(floor.attributes['kernel.floor.dead_effects.live']).toBe(3);
    expect(floor.attributes['kernel.floor.dead_effects.oldest_age_s']).toBe(86_400);
    expect(floor.error).toBe(false);
  });

  it('a sweep that fails is isolated and counted as an error', async () => {
    const s = steps({ sweepDeadEffects: async () => { throw new Error('db down'); } });
    const r = await runKernelFloor(s.deps);
    expect(r.deadEffects).toEqual({ error: 'db down' });
    expect(kernelFloorOutcome(r).errors).toBe(1);
  });
});

describe('the per-minute tick: trunk rechecks (§3, T26)', () => {
  const OWN = { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' };
  const recorder = () => {
    const calls: string[][] = [];
    return { calls, recheckTrunk: async (ids: string[]) => { calls.push([...ids]); return { unresolved: [] }; }, drain: async () => null };
  };

  it('on the control plane in own mode, a due incident is rechecked on the next tick, not at the hourly floor', async () => {
    setKernelHost('control-plane');
    await scheduleTrunkRecheck('inc-1', Date.now() - 1);
    const r = recorder();
    const out = await runScheduledEffectTick({ env: OWN, ...r });
    expect(out).toMatchObject({ ran: true, trunk: { due: 1, rechecked: 1, requeued: 0, failed: 0 } });
    expect(r.calls).toEqual([['inc-1']]);
    expect(queue(TRUNK_RECHECK_QUEUE).has('inc-1')).toBe(false);
  });

  it('an idle minute rechecks nothing', async () => {
    setKernelHost('control-plane');
    await scheduleTrunkRecheck('inc-1');
    const r = recorder();
    expect(await runScheduledEffectTick({ env: OWN, ...r })).toMatchObject({ ran: true, trunk: { due: 0 } });
    expect(r.calls).toEqual([]);
  });

  it('shadow, no command key, or the web host: no recheck, and the queue is left for the host that owns it', async () => {
    await scheduleTrunkRecheck('inc-1', Date.now() - 1);
    const r = recorder();
    setKernelHost('control-plane');
    expect(await runScheduledEffectTick({ env: { EXECUTION_MODE: 'shadow', KERNEL_COMMAND_SECRET: 'k1:s' }, ...r })).toEqual({ ran: false, reason: 'shadow' });
    expect(await runScheduledEffectTick({ env: { EXECUTION_MODE: 'own' }, ...r })).toEqual({ ran: false, reason: 'no_command_key' });
    setKernelHost('web');
    expect(await runScheduledEffectTick({ env: OWN, ...r })).toEqual({ ran: false, reason: 'not_control_plane' });
    expect(r.calls).toEqual([]);
    expect(queue(TRUNK_RECHECK_QUEUE).has('inc-1')).toBe(true);
  });

  it('a failing effect drain never skips the trunk recheck', async () => {
    setKernelHost('control-plane');
    queue('kernel-effects').set('d1', Date.now() - 1);
    await scheduleTrunkRecheck('inc-1', Date.now() - 1);
    const r = recorder();
    const out = await runScheduledEffectTick({ env: OWN, recheckTrunk: r.recheckTrunk, drain: async () => { throw new Error('drain down'); } });
    expect(out).toMatchObject({ ran: true, result: { failed: 1 }, trunk: { rechecked: 1 } });
    expect(r.calls).toEqual([['inc-1']]);
  });
});
