// Cron endpoint: GET /api/cron/dispatch-drain
//
// The timer and the repair loop for the dispatch outbox
// (lib/dispatch-authority.ts, docs/specs/task-dispatch-authority.md). The
// normal path does not come through here: a state change writes its intent
// and kicks delivery in the same request. This route covers the two things a
// kick cannot:
//
//   - `?gate=due`, every minute: the timer. Intents due in the future (a
//     deferred `startAt`, a delivery retry's backoff) are published to the
//     Redis due-queue `buildd:due:dispatch`. The tick asks Redis whether any
//     are due and returns without touching Postgres — not even the run log —
//     when none are. When some are, it drains until nothing due is left (or
//     the budget runs out), then clears what it answered and re-publishes
//     what is still ahead.
//   - no param, hourly: the floor, and the only place reconciliation lives.
//     Drains anything a kick missed, re-seeds the due-queue from the table
//     (so a lost publish costs an hour, not the wake), backfills startAt
//     wakes for tasks deferred before the outbox existed, wakes pending tasks
//     whose dependencies resolved with no wake recorded, re-publishes rows the
//     Dispatch transport never acked, reconciles handed-off rows with no
//     terminal receipt against the Worker (lib/dispatch-reconcile.ts), and
//     reports outbox health: overdue, stuck, failed, unacked and orphaned
//     intents. Repair, not the path. Any repair it does is a bug signal, so
//     it pages the operator (lib/dispatch-alerts.ts), deduped; a terminal
//     delivery failure pages from the receipts route when it happens.
//
// This replaces lib/deferred-dispatch-sweep.ts, the hourly "nudge tasks whose
// startAt has passed" pass on pr-reconcile: the tasks trigger now writes a
// scheduled wake for every future startAt, and this tick fires it on time.
//
// Auth + run recording: withCronRun (lib/cron-run.ts). The two cadences are
// separate health signals, so they record under separate job names.

import { NextRequest, NextResponse } from 'next/server';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import {
  DISPATCH_DUE_QUEUE,
  DRAIN_BATCH,
  drainDispatchOutbox,
  reseedDispatchTimer,
} from '@/lib/dispatch-authority';
import {
  backfillStartAtWakes,
  dispatchOutboxHealth,
  markDispatchBacklog,
  repairDependencyWakes,
  settleDispatchTimer,
} from '@/lib/dispatch-repair';
import { publishPendingDispatches } from '@/lib/dispatch-transport';
import { reconcileOrphans, type ReconcileCounts } from '@/lib/dispatch-reconcile';
import type { DispatchOutboxHealth } from '@buildd/core/dispatch-outbox';
import { alertFloorRepair, floorRepairConditions } from '@/lib/dispatch-alerts';

export const maxDuration = 60;

/** Leaves headroom under maxDuration for the timer and repair work after the drain. */
const DRAIN_BUDGET_MS = 45_000;
/** 40 × DRAIN_BATCH rows per tick; a larger backlog continues on the next minute. */
const MAX_DRAIN_ROUNDS = 40;
/** One publish batch (MAX_PUBLISH_BATCH) of unacked rows per floor tick. */
const FLOOR_PUBLISH_LIMIT = 100;

export async function GET(req: NextRequest) {
  const job = req.nextUrl.searchParams.get('gate') === 'due' ? 'dispatch-drain:due' : 'dispatch-drain';
  return withCronRun(job, req, report => run(req, report));
}

interface DrainTotals {
  claimed: number;
  delivered: number;
  skipped: number;
  failed: number;
  rounds: number;
  /** The last round took less than a full batch: nothing due was left. */
  exhausted: boolean;
}

async function drainDue(): Promise<{ totals: DrainTotals; lastClaimAtMs: number }> {
  const started = Date.now();
  const totals: DrainTotals = { claimed: 0, delivered: 0, skipped: 0, failed: 0, rounds: 0, exhausted: false };
  let lastClaimAtMs = started;
  while (totals.rounds < MAX_DRAIN_ROUNDS) {
    lastClaimAtMs = Date.now();
    const r = await drainDispatchOutbox({ limit: DRAIN_BATCH });
    totals.rounds++;
    totals.claimed += r.claimed;
    totals.delivered += r.delivered;
    totals.skipped += r.skipped;
    totals.failed += r.failed;
    // A failed row is rescheduled with backoff, so it is not re-taken here;
    // a short batch means the due set is empty.
    if (r.claimed < DRAIN_BATCH) { totals.exhausted = true; break; }
    if (Date.now() - started > DRAIN_BUDGET_MS) break;
  }
  return { totals, lastClaimAtMs };
}

type Isolated<T> = T | { error: string };
const isolate = <T>(p: Promise<T>): Promise<Isolated<T>> =>
  p.catch(err => ({ error: err instanceof Error ? err.message : String(err) }));
const failed = (r: Isolated<unknown>): boolean => typeof r === 'object' && r !== null && 'error' in r;

async function run(req: NextRequest, report: CronReport): Promise<NextResponse> {
  const gate = await gateOnDueQueue(DISPATCH_DUE_QUEUE, req.nextUrl.searchParams);
  if (!gate.proceed) {
    // Every idle minute would otherwise write a cron_runs row and keep Neon
    // awake around the clock. The floor tick is this route's health signal.
    report({ unrecorded: true });
    return NextResponse.json({ gated: true, reason: gate.reason });
  }

  if (!gate.reseed) {
    const { totals, lastClaimAtMs } = await drainDue();
    const timer = await isolate(totals.exhausted ? settleDispatchTimer(lastClaimAtMs) : markDispatchBacklog());
    const result = { gate: gate.reason, drain: totals, timer: failed(timer) ? timer : 'ok' };
    report({
      processed: totals.claimed,
      changed: totals.delivered,
      errors: totals.failed + (failed(timer) ? 1 : 0),
      result,
    });
    return NextResponse.json(result);
  }

  // Floor tick. Repairs run before the drain: the dependency repair adds wakes
  // due now, which this drain then sends; the startAt backfill adds only future
  // ones, which the reseed below publishes.
  const startAtBackfilled = await isolate(backfillStartAtWakes());
  const dependencyWakes = await isolate(repairDependencyWakes());
  // Dispatch transport: re-publish rows Dispatch never acked (a no-op unless
  // configured and some workspace opted in) before the drain, so the drain
  // only takes what is still unacked past the publish grace.
  const published = await isolate(publishPendingDispatches({ limit: FLOOR_PUBLISH_LIMIT }));
  // Then handed-off rows with no terminal receipt: re-publish what the Worker
  // lost, project receipts it closed, and take back what it cannot deliver
  // (unreachable, or past the ceiling). Before the drain, so a row taken back
  // is delivered in-app in this same tick.
  const reconciled = await isolate(reconcileOrphans());
  const { totals } = await drainDue();
  const timer = await isolate((async () => {
    await reseedDispatchTimer();
    if (!totals.exhausted) await markDispatchBacklog();
  })());
  const health = await isolate(dispatchOutboxHealth());

  if (!failed(health)) {
    const h = health as DispatchOutboxHealth;
    if (h.overdue + h.stuck + h.failed + h.unacked + h.orphaned > 0) {
      // Overdue or stuck means kicks and the gated tick both missed rows the
      // floor then had to pick up; failed means a consumer is rejecting wakes;
      // unacked means Dispatch is not acking publishes; orphaned means
      // handed-off rows with no terminal receipt an hour past due.
      console.warn(`[dispatch-drain] outbox needs attention: overdue=${h.overdue} stuck=${h.stuck} failed=${h.failed} unacked=${h.unacked} orphaned=${h.orphaned}`);
    }
  }

  // The floor should find nothing: anything it repaired is a missed
  // transition. Called with no conditions too, so a clear is reported.
  const conditions = floorRepairConditions({
    reconcile: reconciled as Isolated<ReconcileCounts>,
    health: health as Isolated<DispatchOutboxHealth>,
  });
  const alert = await isolate(alertFloorRepair(conditions));

  const backfilledCount = failed(startAtBackfilled) ? 0 : (startAtBackfilled as number);
  const dependencyCount = failed(dependencyWakes) ? 0 : (dependencyWakes as number);
  const rc = failed(reconciled) ? null : (reconciled as ReconcileCounts);
  const reconcileChanged = rc ? rc.republished + rc.projected + rc.fellBack : 0;
  const repairErrors = [startAtBackfilled, dependencyWakes, published, reconciled, timer, health].filter(failed).length
    + (rc?.workerErrors ?? 0);
  const result = {
    gate: gate.reason,
    drain: totals,
    timer: failed(timer) ? timer : 'reseeded',
    repair: { startAtBackfilled, dependencyWakes, published, reconciled, health, alert },
  };
  console.log(
    `[dispatch-drain] floor claimed=${totals.claimed} delivered=${totals.delivered} skipped=${totals.skipped}` +
    ` failed=${totals.failed} rounds=${totals.rounds} startAtBackfilled=${backfilledCount}` +
    ` dependencyWakes=${dependencyCount} repairErrors=${repairErrors}`,
  );
  report({
    processed: totals.claimed,
    changed: totals.delivered + backfilledCount + dependencyCount + reconcileChanged,
    errors: totals.failed + repairErrors,
    result,
  });
  return NextResponse.json(result);
}
