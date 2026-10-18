/**
 * The kernel's drain and floor as one pass, and who runs it
 * (docs/specs/workflow-kernel-library.md §3, AC-10): the control plane's cron
 * in own mode, nothing in shadow or on another host; each step isolated.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { REVIEW_DISPATCH_BACKOFF_MS, REVIEW_DISPATCH_RETRIES } from '@buildd/workflow-kernel/handlers/review';
import { KERNEL_FLOOR_PERIOD_MS, kernelFloorOutcome, runKernelFloor, runScheduledKernelFloor, type KernelFloorDeps } from './kernel-floor';
import { setKernelHost } from './kernel-host';

afterEach(() => setKernelHost('web'));

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
  };
  return { ran, deps };
}

describe('the scheduled pass', () => {
  it('runs every step on the control plane in own mode', async () => {
    setKernelHost('control-plane');
    const s = steps();
    const r = await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' }, deps: s.deps });
    expect(r.ran).toBe(true);
    expect(s.ran.sort()).toEqual(['drainDueEffects', 'drainDueEpochEffects', 'drainParkedCommands', 'pruneCommands', 'publishOpenPrStatuses', 'reconcileKernelDeliveries', 'reconcileTrunkIncidents', 'restartTreadmillCycles']);
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
