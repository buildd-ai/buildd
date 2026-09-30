import { expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
let predicate: any;
mock.module('@buildd/core/db', () => ({ db: {
 select: () => ({ from: () => ({ where: (where: any) => {
  predicate = where;
  return { orderBy: () => ({ limit: async () => [] }) };
 } }) }),
} }));
const { fetchGateEventRows } = await import('./gate-analytics-query');
it('filters successful path checks in Postgres before applying the ledger row cap', async () => {
 await fetchGateEventRows(['workspace'], '7d', new Date('2026-09-30T00:00:00Z'));
 const query = new PgDialect().sqlToQuery(predicate);
 expect(query.sql).toContain('"gate_events"."outcome" <>');
 expect(query.params).toContain('accepted');
});
