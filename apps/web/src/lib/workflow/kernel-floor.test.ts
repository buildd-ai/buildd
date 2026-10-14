/**
 * The kernel's drain and floor as one pass, and who runs it
 * (docs/specs/workflow-kernel-library.md §3, AC-10): the control plane's cron
 * in own mode, nothing in shadow or on another host; each step isolated.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { kernelFloorOutcome, runKernelFloor, runScheduledKernelFloor, type KernelFloorDeps } from './kernel-floor';
import { setKernelHost } from './kernel-host';

afterEach(() => setKernelHost('web'));

function steps(o: Partial<Record<keyof KernelFloorDeps, () => Promise<unknown>>> = {}) {
  const ran: string[] = [];
  const step = <T>(name: string, value: T) => async () => { ran.push(name); if (o[name as keyof KernelFloorDeps]) return o[name as keyof KernelFloorDeps]!() as Promise<T>; return value; };
  const deps: KernelFloorDeps = {
    drainDueEffects: step('drainDueEffects', { claimed: 2, done: 2, skipped: 0, failed: 0, lost: 0, dead: [] }) as KernelFloorDeps['drainDueEffects'],
    reconcileTrunkIncidents: step('reconcileTrunkIncidents', { checked: 1, resolved: 1, recovered: 1, stillRed: 0, errors: 0 }),
    reconcileKernelDeliveries: step('reconcileKernelDeliveries', { checked: 3, imported: 1, enqueued: 1, errors: 0 }),
    restartTreadmillCycles: step('restartTreadmillCycles', { checked: 1, restarted: 1, refused: 0, errors: 0 }) as KernelFloorDeps['restartTreadmillCycles'],
    pruneCommands: step('pruneCommands', 4),
  };
  return { ran, deps };
}

describe('the scheduled pass', () => {
  it('runs every step on the control plane in own mode', async () => {
    setKernelHost('control-plane');
    const s = steps();
    const r = await runScheduledKernelFloor({ env: { EXECUTION_MODE: 'own', KERNEL_COMMAND_SECRET: 'k1:s' }, deps: s.deps });
    expect(r.ran).toBe(true);
    expect(s.ran.sort()).toEqual(['drainDueEffects', 'pruneCommands', 'reconcileKernelDeliveries', 'reconcileTrunkIncidents', 'restartTreadmillCycles']);
    expect(kernelFloorOutcome(r.result!)).toEqual({ processed: 7, changed: 6, errors: 0 });
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
    expect(KERNEL_FLOOR_STALE_MS).toBe(2 * 60 * 60_000);
    expect(controlPlaneFloorStale(null, now)).toBe(true);
    expect(controlPlaneFloorStale(new Date(now - KERNEL_FLOOR_STALE_MS - 1), now)).toBe(true);
    expect(controlPlaneFloorStale(new Date(now - 65 * 60_000), now)).toBe(false);
  });
});

describe('the treadmill cooldown', () => {
  it('is the landing sweep\'s cycle cooldown', async () => {
    const { LANDING_CYCLE_COOLDOWN_MS } = await import('@/lib/pr-landing-sweep');
    const { TREADMILL_COOLDOWN_MS } = await import('./kernel-floor');
    expect(TREADMILL_COOLDOWN_MS).toBe(LANDING_CYCLE_COOLDOWN_MS);
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
});
