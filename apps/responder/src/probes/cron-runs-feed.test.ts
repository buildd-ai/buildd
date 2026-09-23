import { describe, expect, test } from 'bun:test';
import { CRON_RUNS_QUERY, normalizeCronRunRow, readCronRuns } from './cron-runs-feed';

describe('cron_runs feed is read-only by construction', () => {
  test('the query is a bare SELECT with no mutating verb anywhere in it', () => {
    expect(CRON_RUNS_QUERY.trimStart().toLowerCase().startsWith('select')).toBe(true);
    for (const verb of ['insert', 'update', 'delete', 'truncate', 'alter', 'drop', 'grant']) {
      expect(CRON_RUNS_QUERY.toLowerCase()).not.toContain(verb);
    }
  });

  test('it selects only the documented columns and never touches alerted_at as a write', () => {
    // alerted_at is READ (it tells us whether the cron health check paged) but
    // the responder must never stamp it -- that column belongs to withCronRun.
    expect(CRON_RUNS_QUERY).toContain('alerted_at');
    expect(CRON_RUNS_QUERY).not.toContain('set ');
  });

  test('it is a single statement — no semicolon-separated second statement', () => {
    expect(CRON_RUNS_QUERY.split(';').filter(s => s.trim()).length).toBe(1);
  });
});

describe('normalizeCronRunRow', () => {
  test('coerces driver timestamps and numerics to the snapshot shape', () => {
    const row = normalizeCronRunRow({
      job: 'queue-stall:fleet-idle',
      started_at: new Date('2026-01-02T03:00:00.000Z'),
      finished_at: new Date('2026-01-02T03:00:04.000Z'),
      ok: true,
      processed: 4,
      changed: 2,
      errors: 0,
      result: { alarms: 2 },
      alerted_at: null,
    });
    expect(row.started_at).toBe('2026-01-02T03:00:00.000Z');
    expect(row.finished_at).toBe('2026-01-02T03:00:04.000Z');
    expect(row.ok).toBe(true);
    expect(row.changed).toBe(2);
    expect(row.result).toEqual({ alarms: 2 });
    expect(row.alerted_at).toBeNull();
  });

  test('a null counter stays null rather than becoming zero', () => {
    // withCronRun records null when the route reported nothing. Zero would be
    // a claim that the job found nothing, which is a different statement.
    const row = normalizeCronRunRow({
      job: 'x',
      started_at: '2026-01-02T03:00:00.000Z',
      finished_at: null,
      ok: false,
      processed: null,
      changed: null,
      errors: null,
      result: null,
      alerted_at: null,
    });
    expect(row.changed).toBeNull();
    expect(row.processed).toBeNull();
    expect(row.finished_at).toBeNull();
  });
});

describe('readCronRuns', () => {
  test('passes the window as a bound parameter, not string interpolation', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const rows = await readCronRuns(
      async (sql, params) => {
        calls.push({ sql, params });
        return [];
      },
      { sinceIso: '2026-01-01T00:00:00.000Z', limit: 500 },
    );
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual(['2026-01-01T00:00:00.000Z', 500]);
    expect(calls[0]!.sql).not.toContain('2026-01-01');
  });

  test('rows come back oldest-first so streak walking has a defined direction', async () => {
    const rows = await readCronRuns(
      async () => [
        { job: 'a', started_at: '2026-01-02T02:00:00.000Z', finished_at: null, ok: true, processed: 0, changed: 0, errors: 0, result: null, alerted_at: null },
        { job: 'a', started_at: '2026-01-02T01:00:00.000Z', finished_at: null, ok: true, processed: 0, changed: 0, errors: 0, result: null, alerted_at: null },
      ],
      { sinceIso: '2026-01-01T00:00:00.000Z', limit: 10 },
    );
    expect(rows.map(r => r.started_at)).toEqual([
      '2026-01-02T01:00:00.000Z',
      '2026-01-02T02:00:00.000Z',
    ]);
  });
});
