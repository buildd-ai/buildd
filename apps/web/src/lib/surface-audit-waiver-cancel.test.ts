// Spec 8e137fdb AC-2: a waiver retires the queued audit, never one an agent started.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { waivableAuditWhere, waiverCancellation } from './surface-audit-waiver-cancel';
import { readCancellation, cancellationLine } from './task-cancellation';

const dialect = new PgDialect();

describe('waivableAuditWhere', () => {
  const q = dialect.sqlToQuery(waivableAuditWhere('m-1'));
  const text = q.sql.replace(/\s+/g, ' ');
  it('scopes to the mission, pending and unclaimed audit rows', () => {
    expect(text).toContain('"tasks"."mission_id" = $');
    expect(text).toContain('"tasks"."status" = $');
    expect(text).toContain('"tasks"."claimed_by" is null');
    expect(text).toContain('"tasks"."title" like $');
    expect(q.params).toContain('m-1');
    expect(q.params).toContain('pending');
    expect(q.params).toContain('[surface audit] %');
  });
  it('skips any audit with a live worker', () => {
    expect(text).toContain('not exists');
    expect(text).toContain('"workers"."task_id" = "tasks"."id"');
    expect(q.params).toContain('running');
  });
});

describe('waiverCancellation', () => {
  it('names the waiver as the reason, in the shape cancels are read back', () => {
    const c = waiverCancellation('Copy-only change, checked by hand', 'user:u1', new Date('2026-10-15T00:00:00Z'));
    expect(readCancellation({ cancellation: c })?.reason).toBe('Visual review waived: Copy-only change, checked by hand');
    expect(cancellationLine({ cancellation: c })).toBe('Cancelled: Visual review waived: Copy-only change, checked by hand');
  });
});
