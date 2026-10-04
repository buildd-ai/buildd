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
//     wakes for tasks deferred before the outbox existed, and reports outbox
//     health: overdue, stuck and failed intents. Repair, not the path.
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
  settleDispatchTimer,
} from '@/lib/dispatch-repair';

export const maxDuration = 60;

/** Leaves headroom under maxDuration for the timer and repair work after the drain. */
const DRAIN_BUDGET_MS = 45_000;
/** 40 × DRAIN_BATCH rows per tick; a larger backlog continues on the next minute. */
const MAX_DRAIN_ROUNDS = 40;

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

  // Floor tick. The backfill runs first so its scheduled rows are published by
  // the reseed below; it never adds anything due now, so the drain is unaffected.
  const startAtBackfilled = await isolate(backfillStartAtWakes());
  const { totals } = await drainDue();
  const timer = await isolate((async () => {
    await reseedDispatchTimer();
    if (!totals.exhausted) await markDispatchBacklog();
  })());
  // TODO(dispatch-deps backstop): call the resolved-dependency repair here
  // (pending tasks whose dependencies resolved with no wake recorded) once the
  // dependency slice ships it. Until then a lost dependency wake waits for a
  // runner's poll, exactly as before the outbox.
  const dependencyRepair = { skipped: 'not_wired' as const };
  const health = await isolate(dispatchOutboxHealth());

  if (!failed(health)) {
    const h = health as { overdue: number; stuck: number; failed: number };
    if (h.overdue + h.stuck + h.failed > 0) {
      // Overdue or stuck means kicks and the gated tick both missed rows the
      // floor then had to pick up; failed means a consumer is rejecting wakes.
      console.warn(`[dispatch-drain] outbox needs attention: overdue=${h.overdue} stuck=${h.stuck} failed=${h.failed}`);
    }
  }

  const backfilledCount = failed(startAtBackfilled) ? 0 : (startAtBackfilled as number);
  const repairErrors = [startAtBackfilled, timer, health].filter(failed).length;
  const result = {
    gate: gate.reason,
    drain: totals,
    timer: failed(timer) ? timer : 'reseeded',
    repair: { startAtBackfilled, dependencyRepair, health },
  };
  console.log(
    `[dispatch-drain] floor claimed=${totals.claimed} delivered=${totals.delivered} skipped=${totals.skipped}` +
    ` failed=${totals.failed} rounds=${totals.rounds} startAtBackfilled=${backfilledCount} repairErrors=${repairErrors}`,
  );
  report({
    processed: totals.claimed,
    changed: totals.delivered + backfilledCount,
    errors: totals.failed + repairErrors,
    result,
  });
  return NextResponse.json(result);
}
