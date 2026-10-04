/**
 * The startAt backfill rendered through the real PgDialect. Its behaviour
 * against Postgres is in apps/web/tests/db/start-at-timer.test.ts; this pins
 * the shape a mocked-`sql` suite could never see.
 */
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { backfillStartAtWakesSql, START_AT_BACKFILL_LIMIT } from './dispatch-repair';

const render = (limit?: number) => new PgDialect().sqlToQuery(backfillStartAtWakesSql(limit));

describe('backfillStartAtWakesSql', () => {
  it('schedules only pending tasks with a future startAt, keyed like the trigger', () => {
    const { sql } = render();
    expect(sql).toContain("t.status = 'pending' AND t.start_at > now()");
    expect(sql).toContain("'start_at:' || floor(extract(epoch FROM t.start_at) * 1000)::bigint::text");
    expect(sql).toContain("'start_at.reached'");
  });

  it('skips a due time that already has an intent in any status, and never overwrites one', () => {
    const { sql } = render();
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM task_dispatch_outbox o WHERE o\.task_id = d\.id AND o\.dedupe_key = d\.key\s*\)/);
    expect(sql).toContain("ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending' DO NOTHING");
  });

  it('binds the bound as a parameter', () => {
    expect(render().params).toEqual([START_AT_BACKFILL_LIMIT]);
    expect(render(7).params).toEqual([7]);
  });
});
