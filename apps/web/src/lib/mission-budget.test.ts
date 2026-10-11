import { expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let captured: any = null;
const chain = {
  select: () => chain,
  from: () => chain,
  innerJoin: () => chain,
  where: (w: unknown) => { captured = w; return Promise.resolve([{ spend: '3.5' }]); },
};
mock.module('@buildd/core/db', () => ({ db: chain }));
mock.module('@/lib/notify', () => ({ notifyTeamOf: async () => {} }));
const { getMissionSpendUsd } = await import('./mission-budget');

// docs/specs/real-and-virtual-cost.md: the mission budget guards money, so
// virtual (plan) usage never counts toward it.
it('sums mission spend excluding virtual-basis workers', async () => {
  expect(await getMissionSpendUsd('m-1')).toBe(3.5);
  const q = new PgDialect().sqlToQuery(captured);
  expect(q.sql).toMatch(/"cost_basis" is distinct from \$\d+/i);
  expect(q.params).toContain('virtual');
  expect(q.params).toContain('m-1');
});
