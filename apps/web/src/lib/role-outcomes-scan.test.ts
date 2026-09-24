import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// The real schema and the real predicate builders; only the executor is
// stubbed. A mocked `db` with stubbed operators makes every WHERE clause
// unobservable, so the clauses are captured and rendered to SQL instead.
const calls: Array<{ table: string; where: any; limit: number | null }> = [];
let workerRows: any[] = [];
let heartbeatRows: any[] = [];

function chain(table: string) {
  const entry = { table, where: null as any, limit: null as number | null };
  calls.push(entry);
  const rows = () => (table === 'workers' ? workerRows : heartbeatRows);
  const q: any = {
    leftJoin: () => q,
    where: (w: any) => {
      entry.where = w;
      return q;
    },
    orderBy: () => q,
    limit: (n: number) => {
      entry.limit = n;
      return Promise.resolve(rows());
    },
    then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
  };
  return q;
}

mock.module('@buildd/core/db', () => ({
  db: {
    select: (cols: Record<string, unknown>) => ({
      from: () => chain('lastHeartbeatAt' in cols ? 'heartbeats' : 'workers'),
    }),
  },
}));

import { MAX_WORKER_ROWS, scanRoleOutcomes } from './role-outcomes-scan';
import { scanStart } from './role-outcomes';

const NOW = new Date('2026-01-02T12:00:00.000Z');
const dialect = new PgDialect();

describe('scanRoleOutcomes', () => {
  beforeEach(() => {
    calls.length = 0;
    workerRows = [];
    heartbeatRows = [];
  });

  it('bounds the worker scan by createdAt and to counted statuses, and caps rows', async () => {
    await scanRoleOutcomes(NOW);
    const w = calls.find(c => c.table === 'workers')!;
    const q = dialect.sqlToQuery(w.where);
    expect(q.sql).toContain('"workers"."created_at" >=');
    expect(q.sql).toContain('"workers"."status" in');
    expect(q.params).toContain(scanStart(NOW).toISOString());
    expect(q.params).toEqual(expect.arrayContaining(['completed', 'failed', 'error']));
    expect(w.limit).toBe(MAX_WORKER_ROWS);
  });

  it('reads only fresh heartbeats', async () => {
    await scanRoleOutcomes(NOW);
    const h = calls.find(c => c.table === 'heartbeats')!;
    const q = dialect.sqlToQuery(h.where);
    expect(q.sql).toContain('"worker_heartbeats"."last_heartbeat_at" >=');
    expect(q.params).toContain(new Date(NOW.getTime() - 10 * 60_000).toISOString());
  });

  it('normalizes rows and reports truncation at the cap', async () => {
    workerRows = Array.from({ length: MAX_WORKER_ROWS }, () => ({
      status: 'failed',
      exitCause: 'code_failure',
      error: 'x',
      roleSlug: null,
      createdAt: '2026-01-02T11:00:00.000Z',
      completedAt: null,
    }));
    heartbeatRows = [{ runnerVersion: '1.0.0', runnerCommit: null, lastHeartbeatAt: '2026-01-02T11:59:00.000Z' }];
    const scan = await scanRoleOutcomes(NOW);
    expect(scan.truncated).toBe(true);
    expect(scan.workers[0]!.createdAt).toBeInstanceOf(Date);
    expect(scan.workers[0]!.completedAt).toBeNull();
    expect(scan.heartbeats[0]!.lastHeartbeatAt).toBeInstanceOf(Date);
  });
});
