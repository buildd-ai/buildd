import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { approvedAttachmentsSql } from './attachment-pins';

/**
 * The approval record's binding attachments (living-specs.md §21, R-47),
 * rendered through the real dialect. Its behaviour against Postgres is pinned
 * in apps/web/tests/db/spec-attachments.test.ts; this pins the shape: the
 * snake_case columns, the revision window, one row per name before the kind
 * filter (a newer reference under a name hides an older binding one), and
 * the spec and revision as bound parameters.
 */
describe('approvedAttachmentsSql', () => {
  const spec = '11111111-2222-4333-8444-555555555555';
  const { sql, params } = new PgDialect().sqlToQuery(approvedAttachmentsSql(spec, 3));

  it('reads the attachment columns by their database names', () => {
    for (const col of ['sa.added_in_revision', 'sa.removed_from_revision', 'sa.artifact_id', 'ar.current_revision', 'sa.created_at']) expect(sql).toContain(col);
    expect(sql).not.toMatch(/addedInRevision|removedFromRevision|currentRevision/);
  });

  it('applies the revision window, dedupes by name, then keeps binding only', () => {
    expect(sql).toMatch(/sa\.added_in_revision <= \$\d/);
    expect(sql).toMatch(/sa\.removed_from_revision IS NULL OR sa\.removed_from_revision > \$\d/);
    expect(sql).toContain('DISTINCT ON (sa.name)');
    expect(sql.indexOf('DISTINCT ON')).toBeLessThan(sql.indexOf("x.kind = 'binding'"));
    expect(sql).toContain("'[]'::jsonb");
  });

  it('binds the spec and the revision', () => {
    expect(params).toEqual([spec, 3, 3]);
  });
});
