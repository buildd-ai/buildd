import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

const reports: Array<Record<string, unknown>> = [];
mock.module('@/lib/cron-run', () => ({
  withCronRun: async (job: string, req: NextRequest, handler: (report: (o: unknown) => void) => Promise<Response>) => {
    if (req.headers.get('authorization') !== 'Bearer s3cret') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return handler(o => { reports.push({ job, ...(o as object) }); });
  },
}));

let dueCount: number | null = 0;
mock.module('@/lib/cron-due-queue', () => ({
  gateOnDueQueue: async (_job: string, params: URLSearchParams) => {
    if (params.get('gate') !== 'due') return { proceed: true, reason: 'floor', dueCount: null, reseed: true };
    if (dueCount === null) return { proceed: true, reason: 'redis_unavailable', dueCount, reseed: false };
    return dueCount > 0
      ? { proceed: true, reason: 'work_due', dueCount, reseed: false }
      : { proceed: false, reason: 'nothing_due', dueCount: 0, reseed: false };
  },
}));

const DRAIN_BATCH = 25;
/** Each drain call shifts one result; empty queue = a drain that found nothing. */
let drainResults: Array<{ claimed: number; delivered: number; skipped: number; failed: number }> = [];
const drainDispatchOutbox = mock(async () => drainResults.shift() ?? { claimed: 0, delivered: 0, skipped: 0, failed: 0 });
const reseedDispatchTimer = mock(async () => {});
mock.module('@/lib/dispatch-authority', () => ({
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH,
  drainDispatchOutbox,
  reseedDispatchTimer,
  wakeTask: mock(async () => {}),
  wakeTasks: mock(async () => {}),
  announceTaskCreated: mock(async () => {}),
  kickDispatch: mock(() => {}),
  enqueueTaskDispatch: mock(async () => {}),
  deliverTaskDispatch: mock(async () => 'pusher'),
  routeForCause: mock(() => ({})),
  webhookWants: mock(() => false),
  primaryCause: mock((_c: string[], f: string) => f),
}));

const publishPendingDispatches = mock(async (_o: unknown) => ({ status: 'unconfigured' }) as Record<string, unknown>);
mock.module('@/lib/dispatch-transport', () => ({ publishPendingDispatches }));

const ZERO = { checked: 0, republished: 0, projected: 0, fellBack: 0, left: 0, workerErrors: 0 };
const reconcileOrphans = mock(async () => ({ ...ZERO }) as Record<string, number>);
mock.module('@/lib/dispatch-reconcile', () => ({ reconcileOrphans }));

const realAlerts = await import('@/lib/dispatch-alerts');
const alertFloorRepair = mock(async (_c: unknown[]) => 'quiet' as string);
mock.module('@/lib/dispatch-alerts', () => ({ ...realAlerts, alertFloorRepair }));

let health: Record<string, number> = { overdue: 0, stuck: 0, failed: 0, unacked: 0, orphaned: 0, unackedStale: 0 };
const backfillStartAtWakes = mock(async () => 0);
const settleDispatchTimer = mock(async (_ms: number) => {});
const markDispatchBacklog = mock(async () => {});
const repairDependencyWakes = mock(async () => 0);
mock.module('@/lib/dispatch-repair', () => ({
  START_AT_BACKFILL_LIMIT: 500,
  DISPATCH_BACKLOG_MEMBER: 'backlog',
  backfillStartAtWakes,
  backfillStartAtWakesSql: () => ({}),
  dispatchOutboxHealth: async () => health,
  settleDispatchTimer,
  markDispatchBacklog,
  repairDependencyWakes,
}));

const sweepEntitlementBlockedTasks = mock(async () => ({ teams: 0, woken: 0 }));
mock.module('@/lib/entitlements/managed-runner', () => ({ sweepEntitlementBlockedTasks }));

const { GET } = await import('./route');
const call = (query = '', auth = 'Bearer s3cret') =>
  GET(new NextRequest(`http://localhost/api/cron/dispatch-drain${query}`, { headers: { authorization: auth } }));

const batch = (claimed: number, failed = 0) => ({ claimed, delivered: claimed - failed, skipped: 0, failed });

beforeEach(() => {
  reports.length = 0;
  dueCount = 0;
  drainResults = [];
  health = { overdue: 0, stuck: 0, failed: 0, unacked: 0, orphaned: 0, unackedStale: 0 };
  for (const m of [alertFloorRepair, publishPendingDispatches, reconcileOrphans, drainDispatchOutbox, reseedDispatchTimer, backfillStartAtWakes, settleDispatchTimer, markDispatchBacklog, repairDependencyWakes]) m.mockClear();
});

describe('GET /api/cron/dispatch-drain', () => {
  it('requires the cron secret', async () => {
    expect((await call('?gate=due', 'Bearer nope')).status).toBe(401);
    expect(drainDispatchOutbox).not.toHaveBeenCalled();
  });

  it('gated tick with nothing due touches neither Postgres nor the run log', async () => {
    const body = await (await call('?gate=due')).json();
    expect(body.gated).toBe(true);
    expect(drainDispatchOutbox).not.toHaveBeenCalled();
    expect(settleDispatchTimer).not.toHaveBeenCalled();
    expect(reports).toEqual([{ job: 'dispatch-drain:due', unrecorded: true }]);
  });

  it('gated tick with work due drains until the outbox is empty, then settles the timer', async () => {
    dueCount = 3;
    drainResults = [batch(DRAIN_BATCH), batch(4, 1)];
    const body = await (await call('?gate=due')).json();
    expect(drainDispatchOutbox).toHaveBeenCalledTimes(2);
    expect(body.drain).toMatchObject({ claimed: 29, delivered: 28, failed: 1, rounds: 2, exhausted: true });
    expect(settleDispatchTimer).toHaveBeenCalledTimes(1);
    expect(markDispatchBacklog).not.toHaveBeenCalled();
    // Repair is the floor tick's job, not the timer's.
    expect(reseedDispatchTimer).not.toHaveBeenCalled();
    expect(backfillStartAtWakes).not.toHaveBeenCalled();
    expect(repairDependencyWakes).not.toHaveBeenCalled();
    expect(reports[0]).toMatchObject({ job: 'dispatch-drain:due', processed: 29, changed: 28, errors: 1 });
  });

  it('a stale due member (already delivered by a kick) is cleared, so the gate stops firing', async () => {
    dueCount = 1;
    await call('?gate=due');
    expect(drainDispatchOutbox).toHaveBeenCalledTimes(1);
    expect(settleDispatchTimer).toHaveBeenCalledTimes(1);
  });

  it('Redis unavailable fails open: the drain runs', async () => {
    dueCount = null;
    drainResults = [batch(2)];
    await call('?gate=due');
    expect(drainDispatchOutbox).toHaveBeenCalledTimes(1);
  });

  it('stops at the round cap and leaves the queue due instead of clearing it', async () => {
    dueCount = 999;
    drainResults = Array.from({ length: 100 }, () => batch(DRAIN_BATCH));
    const body = await (await call('?gate=due')).json();
    expect(body.drain.exhausted).toBe(false);
    expect(drainDispatchOutbox.mock.calls.length).toBeLessThan(100);
    expect(settleDispatchTimer).not.toHaveBeenCalled();
    expect(markDispatchBacklog).toHaveBeenCalledTimes(1);
  });

  it('floor tick repairs dependency and startAt wakes, drains, reseeds the timer and reports outbox health', async () => {
    drainResults = [batch(1)];
    backfillStartAtWakes.mockResolvedValueOnce(2);
    repairDependencyWakes.mockResolvedValueOnce(4);
    health = { overdue: 1, stuck: 0, failed: 3, unacked: 0, orphaned: 0 };
    const body = await (await call()).json();
    expect(backfillStartAtWakes).toHaveBeenCalledTimes(1);
    expect(drainDispatchOutbox).toHaveBeenCalledTimes(1);
    expect(reseedDispatchTimer).toHaveBeenCalledTimes(1);
    expect(repairDependencyWakes).toHaveBeenCalledTimes(1);
    // Repaired wakes are queued before the drain, so the same tick sends them.
    expect(repairDependencyWakes.mock.invocationCallOrder[0]).toBeLessThan(drainDispatchOutbox.mock.invocationCallOrder[0]);
    expect(body.repair).toMatchObject({ startAtBackfilled: 2, dependencyWakes: 4, health: { overdue: 1, stuck: 0, failed: 3, unacked: 0, orphaned: 0 } });
    expect(reports[0]).toMatchObject({ job: 'dispatch-drain', changed: 7 });
    expect(reports[0].unrecorded).toBeUndefined();
  });

  it('floor tick re-publishes unacked rows to the Dispatch transport before the drain; the gated tick does not', async () => {
    drainResults = [batch(1)];
    publishPendingDispatches.mockResolvedValueOnce({ status: 'ok', published: 3, acked: 3, merged: 0, rejected: 0 });
    const body = await (await call()).json();
    expect(publishPendingDispatches).toHaveBeenCalledWith({ limit: 100 });
    expect(publishPendingDispatches.mock.invocationCallOrder[0]).toBeLessThan(drainDispatchOutbox.mock.invocationCallOrder[0]);
    expect(body.repair.published).toMatchObject({ status: 'ok', acked: 3 });
    publishPendingDispatches.mockClear();
    dueCount = 1;
    await call('?gate=due');
    expect(publishPendingDispatches).not.toHaveBeenCalled();
  });

  it('floor tick reconciles orphans after the publish and before the drain, so a fallen-back row is delivered this tick', async () => {
    drainResults = [batch(2)];
    reconcileOrphans.mockResolvedValueOnce({ checked: 5, republished: 1, projected: 1, fellBack: 2, left: 1, workerErrors: 1 });
    const body = await (await call()).json();
    expect(reconcileOrphans).toHaveBeenCalledTimes(1);
    expect(publishPendingDispatches.mock.invocationCallOrder[0]).toBeLessThan(reconcileOrphans.mock.invocationCallOrder[0]);
    expect(reconcileOrphans.mock.invocationCallOrder[0]).toBeLessThan(drainDispatchOutbox.mock.invocationCallOrder[0]);
    expect(body.repair.reconciled).toEqual({ checked: 5, republished: 1, projected: 1, fellBack: 2, left: 1, workerErrors: 1 });
    // Re-publishes, projected receipts and fallbacks are changes; Worker errors are errors.
    expect(reports[0]).toMatchObject({ changed: 2 + 1 + 1 + 2, errors: 1 });
    reconcileOrphans.mockClear();
    dueCount = 1;
    await call('?gate=due');
    expect(reconcileOrphans).not.toHaveBeenCalled();
  });

  it('a reconcile that throws is isolated: the drain still runs', async () => {
    drainResults = [batch(1)];
    reconcileOrphans.mockRejectedValueOnce(new Error('candidate read failed'));
    const res = await call();
    const body = await res.json();
    expect(body.drain.delivered).toBe(1);
    expect(body.repair.reconciled).toEqual({ error: 'candidate read failed' });
    expect(reports[0].errors).toBe(1);
  });

  it('a failing repair pass does not lose the drain', async () => {
    drainResults = [batch(2)];
    backfillStartAtWakes.mockRejectedValueOnce(new Error('backfill query failed'));
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.drain.delivered).toBe(2);
    expect(body.repair.startAtBackfilled).toEqual({ error: 'backfill query failed' });
    expect(reseedDispatchTimer).toHaveBeenCalledTimes(1);
    expect(reports[0].errors).toBe(1);
  });

  it('a quiet floor still calls the alert with no conditions, so a cleared condition can be reported', async () => {
    drainResults = [batch(0)];
    await call();
    expect(alertFloorRepair).toHaveBeenCalledTimes(1);
    expect(alertFloorRepair.mock.calls[0][0]).toEqual([]);
  });

  it('a floor that had to repair alerts with each non-zero condition', async () => {
    drainResults = [batch(2)];
    reconcileOrphans.mockResolvedValueOnce({ checked: 5, republished: 1, projected: 0, fellBack: 2, left: 2, workerErrors: 1 });
    health = { overdue: 0, stuck: 0, failed: 4, unacked: 3, orphaned: 1, unackedStale: 2 };
    const body = await (await call()).json();
    expect(alertFloorRepair.mock.calls[0][0]).toEqual([
      { key: 'republished', count: 1 }, { key: 'fellBack', count: 2 }, { key: 'workerErrors', count: 1 },
      { key: 'orphaned', count: 1 }, { key: 'unackedStale', count: 2 },
    ]);
    expect(body.repair.alert).toBe('quiet');
  });

  it('the gated tick never alerts', async () => {
    dueCount = 2;
    drainResults = [batch(1)];
    await call('?gate=due');
    expect(alertFloorRepair).not.toHaveBeenCalled();
  });

  it('an alert that throws does not fail the floor', async () => {
    drainResults = [batch(1)];
    alertFloorRepair.mockRejectedValueOnce(new Error('redis'));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).repair.alert).toEqual({ error: 'redis' });
  });
});
