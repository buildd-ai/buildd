process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

// ─── DB mocks ─────────────────────────────────────────────────────────────────

let inserted: Record<string, unknown>[] = [];
let updated: Record<string, unknown>[] = [];

const mockInsert = mock(() => ({
  values: mock((v: any) => {
    inserted.push(v);
    return { returning: mock(() => [{ id: 'run-1' }]) };
  }),
}));
const mockUpdate = mock(() => ({
  set: mock((v: any) => {
    updated.push(v);
    return { where: mock(() => Promise.resolve()) };
  }),
}));
const mockDelete = mock(() => ({ where: mock(() => Promise.resolve()) }));
const mockFindMany = mock(() => [] as any[]);

mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => mockInsert(),
    update: () => mockUpdate(),
    delete: () => mockDelete(),
    query: { cronRuns: { findMany: mockFindMany } },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  lt: (a: any, b: any) => ({ a, b, op: 'lt' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  desc: (a: any) => ({ a, op: 'desc' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ op: 'sql', strings: [...strings], values }),
    { raw: (v: string) => ({ op: 'sql.raw', v }) },
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  cronRuns: { id: 'id', job: 'job', startedAt: 'startedAt', alertedAt: 'alertedAt' },
}));

const mockNotify = mock(() => {});
mock.module('@/lib/pushover', () => ({ notify: mockNotify }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { withCronRun } from './cron-run';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET = 'test-cron-secret';

function reqWith(token?: string): NextRequest {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new NextRequest('http://localhost:3000/api/cron/example', { headers });
}

const HOUR = 60 * 60 * 1000;
/** A run of the shape a dead sweep produces. */
const deadRun = (agoHours: number) => ({
  ok: true, errors: 40, changed: 0, alertedAt: null,
  startedAt: new Date(Date.now() - agoHours * HOUR),
});

describe('withCronRun', () => {
  beforeEach(() => {
    inserted = [];
    updated = [];
    mockInsert.mockClear();
    mockUpdate.mockClear();
    mockDelete.mockClear();
    mockFindMany.mockReset();
    mockFindMany.mockResolvedValue([]);
    mockNotify.mockClear();
    process.env.CRON_SECRET = SECRET;
  });

  // ── Auth is unchanged ──────────────────────────────────────────────────────

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const res = await withCronRun('example', reqWith(SECRET), async () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(500);
  });

  it('returns 401 for a wrong or missing token', async () => {
    expect((await withCronRun('example', reqWith('nope'), async () => NextResponse.json({}))).status).toBe(401);
    expect((await withCronRun('example', reqWith(), async () => NextResponse.json({}))).status).toBe(401);
  });

  it('records nothing for an unauthorized request', async () => {
    // Otherwise anyone who can reach the URL can write rows into the table the
    // health check reads, and drown a real signal.
    await withCronRun('example', reqWith('nope'), async () => NextResponse.json({}));
    expect(inserted).toHaveLength(0);
  });

  it('does not run the handler when unauthorized', async () => {
    const handler = mock(async () => NextResponse.json({}));
    await withCronRun('example', reqWith('nope'), handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not honour a platform cron header in place of the secret', async () => {
    // Platform-native cron does not fire in this project (vercel.json declares
    // no crons; cron-manifest.json says so outright), so this header can only
    // come from a caller that is not the scheduler. Two routes used to accept
    // it as an alternative to the secret; nothing does now, and the wrapper
    // must not offer a way back to that.
    const headers = new Headers({ 'x-vercel-cron': '1' });
    const req = new NextRequest('http://localhost:3000/api/cron/example', { headers });

    const res = await withCronRun('example', req, async () => NextResponse.json({ ok: true }));

    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  // ── Recording ──────────────────────────────────────────────────────────────

  it('records the verdict the handler reports', async () => {
    const res = await withCronRun('example', reqWith(SECRET), async (report) => {
      report({ processed: 40, changed: 12, errors: 1, result: { stamped: 12 } });
      return NextResponse.json({ ok: true });
    });

    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      job: 'example', ok: true, processed: 40, changed: 12, errors: 1,
    });
    expect(inserted[0].result).toEqual({ stamped: 12 });
    expect(typeof inserted[0].durationMs).toBe('number');
  });

  it('records a heartbeat even when the handler reports nothing', async () => {
    await withCronRun('example', reqWith(SECRET), async () => NextResponse.json({ ok: true }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ job: 'example', ok: true, processed: null, changed: null, errors: null });
  });

  it('records ok=false and the message when the handler throws, and still fails the request', async () => {
    const res = await withCronRun('example', reqWith(SECRET), async () => {
      throw new Error('boom');
    });

    expect(res.status).toBe(500);
    expect(inserted[0]).toMatchObject({ job: 'example', ok: false, error: 'boom' });
    // Surfaced in the response too: the endpoint is secret-gated, and curling a
    // failing cron by hand is the first diagnostic step.
    expect(await res.json()).toMatchObject({ error: 'boom' });
  });

  // ── Monitoring must never break what it monitors ───────────────────────────

  it('still returns the handler result when recording the run fails', async () => {
    // A monitoring table that can take down every scheduled job is worse than
    // no monitoring table.
    mockInsert.mockImplementationOnce(() => { throw new Error('db down'); });

    const res = await withCronRun('example', reqWith(SECRET), async () =>
      NextResponse.json({ ok: true, work: 'done' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ work: 'done' });
  });

  it('still returns the handler result when the health check fails', async () => {
    mockFindMany.mockImplementationOnce(() => { throw new Error('query blew up'); });
    const res = await withCronRun('example', reqWith(SECRET), async () => NextResponse.json({ ok: true }));
    expect(res.status).toBe(200);
  });

  // ── Alerting ───────────────────────────────────────────────────────────────

  it('alerts and stamps alertedAt when the job is consistently failing', async () => {
    mockFindMany.mockResolvedValue([deadRun(1), deadRun(2), deadRun(3)]);

    await withCronRun('example', reqWith(SECRET), async (report) => {
      report({ processed: 40, changed: 0, errors: 40 });
      return NextResponse.json({ ok: true });
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const opts = mockNotify.mock.calls[0][0] as any;
    expect(opts.app).toBe('alerts');
    expect(opts.title).toContain('example');
    expect(opts.message).toContain('0 changed');
    // Stamped so the next few runs stay quiet.
    expect(updated.some(u => u.alertedAt instanceof Date)).toBe(true);
  });

  it('stays silent for a healthy job', async () => {
    mockFindMany.mockResolvedValue([
      { ok: true, errors: 0, changed: 3, alertedAt: null, startedAt: new Date() },
    ]);
    await withCronRun('example', reqWith(SECRET), async (report) => {
      report({ processed: 3, changed: 3, errors: 0 });
      return NextResponse.json({ ok: true });
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('scopes the job name so two cadences of one route are separate signals', async () => {
    await withCronRun('pr-reconcile:merge-state', reqWith(SECRET), async () => NextResponse.json({}));
    expect(inserted[0].job).toBe('pr-reconcile:merge-state');
  });
});
