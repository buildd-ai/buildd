/**
 * The kernel's drain and floor as one pass (docs/specs/workflow-kernel-library.md
 * §3): the outbox floor drain (workflow-state-kernel.md §10.3), the trunk
 * circuit breaker's recovery (§6.10), the reconciliation floor (§11), the S15
 * treadmill restart, and pruning the command ledger. Each step is isolated: one
 * failing never discards the others.
 *
 * Hosted by exactly one process per mode: the control plane's cron trigger in
 * `own` (`runScheduledKernelFloor`, apps/control-plane/wrangler.jsonc), and the
 * web host's hourly `/api/cron/pr-reconcile` in `shadow`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { cronRuns } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { withCronRun } from '@/lib/cron-run';
import { drainDueEffects, reconcileKernelDeliveries, reconcileTrunkIncidents, restartTreadmillCycles, type FloorSummary, type TreadmillCycleSummary, type TrunkSweepSummary } from './seam';
import type { DrainSummary } from './effects';
import { postgresCommandLedger } from './command-ledger';
import { kernelHost } from './kernel-host';
import { commandsConfigured, executionModeOf } from './command-api';

type Isolated<T> = T | { error: string };

/**
 * The S15 cooldown before a spent treadmill cycle restarts: the landing sweep's
 * `LANDING_CYCLE_COOLDOWN_MS`, restated here because the kernel (core) never imports
 * the landing module; kernel-floor.test.ts pins the two equal.
 */
export const TREADMILL_COOLDOWN_MS = 60 * 60_000;

export interface KernelFloorResult {
  kernelOutbox: Isolated<DrainSummary>;
  trunk: Isolated<TrunkSweepSummary>;
  kernelFloor: Isolated<FloorSummary>;
  treadmillCycles: Isolated<TreadmillCycleSummary>;
  commandsPruned: Isolated<number>;
}

export interface KernelFloorDeps {
  drainDueEffects?: typeof drainDueEffects;
  reconcileTrunkIncidents?: () => Promise<TrunkSweepSummary>;
  reconcileKernelDeliveries?: () => Promise<FloorSummary>;
  restartTreadmillCycles?: typeof restartTreadmillCycles;
  pruneCommands?: () => Promise<number>;
}

const isolate = <T>(p: () => Promise<T>): Promise<Isolated<T>> =>
  Promise.resolve().then(p).catch((err): { error: string } => ({ error: err instanceof Error ? err.message : String(err) }));

export async function runKernelFloor(deps: KernelFloorDeps = {}): Promise<KernelFloorResult> {
  const [kernelOutbox, trunk, kernelFloor, treadmillCycles, commandsPruned] = await Promise.all([
    isolate(() => (deps.drainDueEffects ?? drainDueEffects)()),
    isolate(() => (deps.reconcileTrunkIncidents ?? (() => reconcileTrunkIncidents()))()),
    isolate(() => (deps.reconcileKernelDeliveries ?? (() => reconcileKernelDeliveries()))()),
    isolate(() => (deps.restartTreadmillCycles ?? restartTreadmillCycles)({ cooldownMs: TREADMILL_COOLDOWN_MS })),
    isolate(() => (deps.pruneCommands ?? (() => postgresCommandLedger().prune()))()),
  ]);
  return { kernelOutbox, trunk, kernelFloor, treadmillCycles, commandsPruned };
}

const ok = <T>(v: Isolated<T>): v is T => !(v && typeof v === 'object' && 'error' in (v as object));

/** The cron-run verdict of one pass: what it moved, and what failed. */
export function kernelFloorOutcome(r: KernelFloorResult): { processed: number; changed: number; errors: number } {
  const outbox = ok(r.kernelOutbox) ? r.kernelOutbox : null;
  const floor = ok(r.kernelFloor) ? r.kernelFloor : null;
  const trunk = ok(r.trunk) ? r.trunk : null;
  const tread = ok(r.treadmillCycles) ? r.treadmillCycles : null;
  return {
    processed: (outbox?.claimed ?? 0) + (floor?.checked ?? 0) + (trunk?.checked ?? 0) + (tread?.checked ?? 0),
    changed: (outbox?.done ?? 0) + (floor ? floor.imported + floor.enqueued : 0) + (trunk?.resolved ?? 0) + (tread?.restarted ?? 0),
    errors: (outbox ? outbox.failed : 1) + (floor ? floor.errors : 1) + (trunk ? trunk.errors : 1) + (tread ? tread.errors : 1) + (ok(r.commandsPruned) ? 0 : 1),
  };
}

export function logKernelFloor(r: KernelFloorResult, where: string): void {
  const line = (label: string, v: Isolated<object | number>) =>
    ok(v) ? console.log(`[${label}] ${where} ${JSON.stringify(v)}`) : console.error(`[${label}] ${where} error:`, (v as { error: string }).error);
  line('KernelOutbox', r.kernelOutbox);
  line('TrunkIncidents', r.trunk);
  line('KernelFloor', r.kernelFloor);
  line('TreadmillCycles', r.treadmillCycles);
  line('KernelCommandsPruned', r.commandsPruned);
}

export const KERNEL_FLOOR_JOB = 'kernel-floor';

/** The control plane's cron period (wrangler.jsonc `10 * * * *`). */
export const KERNEL_FLOOR_PERIOD_MS = 60 * 60_000;
/** Older than two periods, the control plane's floor is presumed not running (a trigger never deployed, a broken Worker). */
export const KERNEL_FLOOR_STALE_MS = 2 * KERNEL_FLOOR_PERIOD_MS;

/** When the control plane's floor last completed: its newest successful `kernel-floor` run, or null for never. */
export async function lastControlPlaneFloorAt(): Promise<Date | null> {
  const row = await db.query.cronRuns.findFirst({
    where: sqlWhere(and(eq(cronRuns.job, KERNEL_FLOOR_JOB), eq(cronRuns.ok, true))),
    columns: { startedAt: true },
    orderBy: sqlOrderBy(desc(cronRuns.startedAt)),
  });
  return row?.startedAt ? new Date(row.startedAt) : null;
}

/**
 * The liveness fallback: the web host runs the drain and floor itself, even cut over,
 * when the control plane's floor has not completed within two periods. A cron trigger
 * that was never deployed, or a Worker that stopped, can then cost two hours, never the drain.
 */
export function controlPlaneFloorStale(lastAt: Date | null, now: number = Date.now()): boolean {
  return !lastAt || now - lastAt.getTime() > KERNEL_FLOOR_STALE_MS;
}

/**
 * The control plane's cron trigger. Runs only on the control plane in `own`;
 * anywhere else it does nothing and touches nothing (no database read, so a
 * shadow-mode Worker's tick costs no Neon wake). Recorded as the
 * `kernel-floor` cron run when `CRON_SECRET` is configured, so a floor that
 * stops changing anything is noticed like any other sweep.
 */
export async function runScheduledKernelFloor(o: { env?: Record<string, string | undefined>; deps?: KernelFloorDeps } = {}): Promise<{ ran: boolean; reason?: string; result?: KernelFloorResult }> {
  const env = o.env ?? process.env;
  if (kernelHost() !== 'control-plane') return { ran: false, reason: 'not_control_plane' };
  if (executionModeOf(env.EXECUTION_MODE) !== 'own') return { ran: false, reason: 'shadow' };
  // Not switched over: without the command key the web host is the kernel's host and drains.
  if (!commandsConfigured(env)) return { ran: false, reason: 'no_command_key' };
  let result: KernelFloorResult | undefined;
  const pass = async () => {
    result = await runKernelFloor(o.deps);
    logKernelFloor(result, 'control-plane');
  };
  if (env.CRON_SECRET) {
    const req = new NextRequest('https://control-plane.internal/__cron/kernel-floor', { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
    await withCronRun(KERNEL_FLOOR_JOB, req, async (report) => {
      await pass();
      report({ ...kernelFloorOutcome(result!), result: { host: 'control-plane', ...result } as Record<string, unknown> });
      return NextResponse.json({ ok: true });
    });
    // withCronRun reads its secret from process.env; a mismatch refuses before the handler. Never skip the floor for that.
    if (!result) {
      console.warn('[kernel-floor] the run could not be recorded; the pass runs unrecorded');
      await pass();
    }
  } else {
    console.warn('[kernel-floor] CRON_SECRET is not configured; the pass runs unrecorded');
    await pass();
  }
  return { ran: true, result };
}
