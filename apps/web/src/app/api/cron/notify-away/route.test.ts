import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

const reports: unknown[] = [];
mock.module('@/lib/cron-run', () => ({
  withCronRun: async (job: string, req: NextRequest, handler: (report: (o: unknown) => void) => Promise<Response>) => {
    if (req.headers.get('authorization') !== 'Bearer s3cret') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return handler(o => { reports.push({ job, ...(o as object) }); });
  },
}));

let dueCount: number | null = 0;
let holdDue: number | null = 0;
mock.module('@/lib/cron-due-queue', () => ({
  gateOnDueQueue: async (job: string, params: URLSearchParams) => {
    if (params.get('gate') !== 'due') return { proceed: true, reason: 'floor', dueCount: null, reseed: true };
    const dueCount = job === 'question-hold' ? holdDue : dueCountAway();
    if (dueCount === null) return { proceed: true, reason: 'redis_unavailable', dueCount, reseed: false };
    return dueCount > 0
      ? { proceed: true, reason: 'work_due', dueCount, reseed: false }
      : { proceed: false, reason: 'nothing_due', dueCount: 0, reseed: false };
  },
}));

const dueCountAway = () => dueCount;

const holdRuns: Array<{ floor: boolean }> = [];
mock.module('@/lib/question-hold', () => ({
  HOLD_QUEUE: 'question-hold',
  resurfaceHeldQuestions: async (opts: { floor: boolean }) => {
    holdRuns.push(opts);
    return { held: 1, resurfaced: 1, dropped: 0, ahead: 0, lost: 0, failed: 0 };
  },
}));

let runs = 0;
mock.module('@/lib/away-delivery', () => ({
  AWAY_QUEUE: 'notify-away',
  deliverAwayNotifications: async () => {
    runs++;
    return { rows: 3, people: 1, sent: 1, delivered: 3, present: 0, noKey: 0, notReady: 0, held: 0, failed: 0 };
  },
}));

const { GET } = await import('./route');
const call = (query = '', auth = 'Bearer s3cret') =>
  GET(new NextRequest(`http://localhost/api/cron/notify-away${query}`, { headers: { authorization: auth } }));

beforeEach(() => { reports.length = 0; runs = 0; dueCount = 0; holdDue = 0; holdRuns.length = 0; });

describe('GET /api/cron/notify-away', () => {
  it('requires the cron secret', async () => {
    expect((await call('', 'Bearer nope')).status).toBe(401);
    expect(runs).toBe(0);
  });

  it('gated tick with nothing due returns without running delivery', async () => {
    const res = await call('?gate=due');
    expect((await res.json()).gated).toBe(true);
    expect(runs).toBe(0);
  });

  it('gated tick with work due runs delivery and reports messages sent as changed', async () => {
    dueCount = 2;
    const body = await (await call('?gate=due')).json();
    expect(runs).toBe(1);
    expect(body.sent).toBe(1);
    expect(reports[0]).toMatchObject({ processed: 3, changed: 1, errors: 0 });
  });

  it('Redis unavailable fails open: delivery runs', async () => {
    dueCount = null;
    await call('?gate=due');
    expect(runs).toBe(1);
  });

  it('the floor tick always runs', async () => {
    await call();
    expect(runs).toBe(1);
  });

  // Held questions (lib/question-hold.ts) ride this route's ticks instead of a cron of their own.
  it('gated tick with nothing due on either queue touches neither', async () => {
    await call('?gate=due');
    expect(runs).toBe(0);
    expect(holdRuns).toHaveLength(0);
  });

  it('gated tick with only a held question due resurfaces it without running away delivery', async () => {
    holdDue = 1;
    const body = await (await call('?gate=due')).json();
    expect(holdRuns).toEqual([{ floor: false }]);
    expect(runs).toBe(0);
    expect(body.hold.resurfaced).toBe(1);
    expect(reports[0]).toMatchObject({ changed: 1 });
  });

  it('the floor tick runs both, and the resurface pass re-seeds', async () => {
    await call();
    expect(runs).toBe(1);
    expect(holdRuns).toEqual([{ floor: true }]);
  });
});
