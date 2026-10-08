/**
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/workflow/delivery-view-kernel-owned.test.ts
 */
import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

mock.module('@buildd/core/db', () => ({ db: {} }));
const { kernelOwnedDeliveryStates } = await import('./delivery-view');

const dialect = new PgDialect();

describe('kernelOwnedDeliveryStates', () => {
  it('reads only kernel-authority deliveries, by owner task, and keeps well-formed rows', async () => {
    let rendered = '';
    let params: unknown[] = [];
    const rows = await kernelOwnedDeliveryStates(['t1', 't2', 't1'], async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      rendered = r.sql;
      params = r.params;
      return { rows: [{ ownerTaskId: 't1', state: 'REPAIRING' }, { ownerTaskId: null, state: 'WORKING' }] };
    });
    expect(rendered).toContain("d.authority = 'kernel'");
    expect(rendered).toContain('d.owner_task_id IN');
    expect(params).toEqual([JSON.stringify(['t1', 't2'])]);
    expect(rows).toEqual([{ ownerTaskId: 't1', state: 'REPAIRING' }]);
  });

  it('no tasks: no read', async () => {
    let called = 0;
    expect(await kernelOwnedDeliveryStates([], async () => { called++; return { rows: [] }; })).toEqual([]);
    expect(called).toBe(0);
  });

  it('a read failure throws, so the caller can fail closed', async () => {
    await expect(kernelOwnedDeliveryStates(['t1'], async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  });
});
