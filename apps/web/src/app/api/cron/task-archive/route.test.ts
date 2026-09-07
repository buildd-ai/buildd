import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbExecute = mock(() => Promise.resolve({ rows: [] as any[] }));

// Age-based prunes go through db.delete(...).where(lt(col, cutoff)).returning().
// The mock records the table, the predicate and the returned rows so a test can
// see WHICH table was pruned and WITH WHAT cutoff. Stubbing `db` with `execute`
// alone (as this file used to) makes db.delete throw, and the route swallows
// prune failures by design — so every prune here was silently untested.
interface CapturedDelete { table: unknown; predicate: any; }
let capturedDeletes: CapturedDelete[] = [];
let deleteRows = new Map<unknown, Array<{ id: string }>>();
let deleteThrows = new Set<unknown>();

const mockDbDelete = mock((table: unknown) => ({
  where: (predicate: any) => ({
    returning: () => {
      capturedDeletes.push({ table, predicate });
      if (deleteThrows.has(table)) return Promise.reject(new Error('prune exploded'));
      return Promise.resolve(deleteRows.get(table) ?? []);
    },
  }),
}));

mock.module('@buildd/core/db', () => ({
  db: { execute: mockDbExecute, delete: mockDbDelete },
}));

mock.module('drizzle-orm', () => ({
  // Operators withCronRun imports. mock.module is process-global, so a
  // partial stub removes them for every other importer too.
  eq: (a: any, b: any) => ({ a, b, op: 'eq' }),
  and: (...args: any[]) => ({ args, op: 'and' }),
  desc: (a: any) => ({ a, op: 'desc' }),
  gt: (a: any, b: any) => ({ a, b, op: 'gt' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values, type: 'sql' }),
    { raw: (s: string) => ({ raw: s, type: 'sql' }) },
  ),
  // Recorded, not evaluated: the route builds the cutoff, and the assertion below
  // reads it back out of here.
  lt: (column: unknown, value: unknown) => ({ op: 'lt', column, value }),
}));

process.env.CRON_SECRET = 'test-secret';

import { GET } from './route';
import { watcherEvents, workerActionEvents } from '@buildd/core/db/schema';

function findDelete(table: unknown): CapturedDelete | undefined {
  return capturedDeletes.find(d => d.table === table);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between `now` and a captured cutoff, rounded to the nearest day. */
function retentionDays(predicate: any, now: number): number {
  return Math.round((now - (predicate.value as Date).getTime()) / DAY_MS);
}

function makeRequest(auth = 'Bearer test-secret'): NextRequest {
  return new NextRequest('http://localhost/api/cron/task-archive', {
    headers: { authorization: auth },
  });
}

describe('GET /api/cron/task-archive', () => {
  beforeEach(() => {
    mockDbExecute.mockReset();
    mockDbExecute.mockResolvedValue({ rows: [] });
    capturedDeletes = [];
    deleteRows = new Map();
    deleteThrows = new Set();
  });

  it('returns 401 without the correct CRON_SECRET', async () => {
    const res = await GET(makeRequest('Bearer wrong'));
    expect(res.status).toBe(401);
    // Must not run the archive UPDATE for an unauthorized caller.
    expect(mockDbExecute).not.toHaveBeenCalled();
    // ...and must not delete anything either.
    expect(capturedDeletes).toEqual([]);
  });

  it('archives stale failed tasks and returns the count', async () => {
    mockDbExecute.mockResolvedValue({ rows: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.archived).toBe(3);
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (archived: 0) when nothing qualifies — idempotent re-runs', async () => {
    mockDbExecute.mockResolvedValue({ rows: [] });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(0);
  });

  it('targets only failed tasks and excludes deps of live tasks in the UPDATE', async () => {
    await GET(makeRequest());
    const call = mockDbExecute.mock.calls[0][0] as any;
    const query = call.strings.join(' ');
    // Only failed rows are archived (completed tasks are history — never touched).
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("SET status = 'cancelled'");
    expect(query).not.toContain("status = 'completed'");
    // Skip tasks still depended on by non-terminal work.
    expect(query).toContain("dependent.status IN ('pending', 'assigned', 'in_progress')");
    expect(query).toContain('depends_on');
    // 30-day staleness window.
    expect(query).toContain("now() - interval");
  });
});

// ── Retention prunes ─────────────────────────────────────────────────────────
// watcher_events is an insert-only uniqueness ledger: the health watcher relies
// on the UNIQUE (project_id, kind, dedupe_key) violation to suppress a duplicate
// task, so the rows are load-bearing rather than telemetry — and nothing pruned
// them, so the table grew without bound. This weekly job is where that stops.

describe('GET /api/cron/task-archive — retention prunes', () => {
  beforeEach(() => {
    mockDbExecute.mockReset();
    mockDbExecute.mockResolvedValue({ rows: [] });
    capturedDeletes = [];
    deleteRows = new Map();
    deleteThrows = new Set();
  });

  it('prunes watcher_events by age and reports the count', async () => {
    const now = Date.now();
    deleteRows.set(watcherEvents, [{ id: 'w1' }, { id: 'w2' }]);
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.prunedWatcherEvents).toBe(2);
    const pruned = findDelete(watcherEvents);
    expect(pruned).toBeDefined();
    // Filtered on fired_at, older-than — not a truncate.
    expect(pruned!.predicate.op).toBe('lt');
    expect(pruned!.predicate.column).toBe(watcherEvents.firedAt);
    expect(pruned!.predicate.value).toBeInstanceOf(Date);
    expect(retentionDays(pruned!.predicate, now)).toBe(90);
  });

  it('keeps the window long enough to outlive a still-current dedupe key', async () => {
    // A `pr-<n>-<headSha>` key stays current while a release PR sits at that SHA,
    // and `stale-<deployId>` while that deploy is still newest. Pruning inside
    // that lifetime re-arms the watcher and re-files a task that already exists,
    // so this floor is the actual product constraint — not the exact number.
    const now = Date.now();
    await GET(makeRequest());
    expect(retentionDays(findDelete(watcherEvents)!.predicate, now)).toBeGreaterThanOrEqual(30);
  });

  it('still prunes worker_action_events, on its own shorter window', async () => {
    const now = Date.now();
    deleteRows.set(workerActionEvents, [{ id: 'a1' }]);
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.prunedActionEvents).toBe(1);
    const pruned = findDelete(workerActionEvents);
    expect(pruned!.predicate.column).toBe(workerActionEvents.ts);
    expect(retentionDays(pruned!.predicate, now)).toBe(45);
  });

  it('survives a failing watcher_events prune without losing the archive', async () => {
    // Retention is hygiene: a prune that throws must leave the rows for next
    // week, never fail the sweep that unblocks dependent tasks.
    deleteThrows.add(watcherEvents);
    mockDbExecute.mockResolvedValue({ rows: [{ id: 't1' }] });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(1);
    expect(body.prunedWatcherEvents).toBe(0);
  });

  it('prunes both ledgers in one run — neither prune shadows the other', async () => {
    deleteThrows.add(workerActionEvents);
    deleteRows.set(watcherEvents, [{ id: 'w1' }]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.prunedActionEvents).toBe(0);
    expect(body.prunedWatcherEvents).toBe(1);
    expect(capturedDeletes.map(d => d.table)).toEqual([workerActionEvents, watcherEvents]);
  });
});
