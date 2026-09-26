import { describe, it, expect } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { tasks } from '@buildd/core/db/schema';
import { terminalAuditFields } from './audit-fields';

// Render through drizzle itself: a single-table select strips table names from
// the select list, so a `${tasks.id}` inside a correlated subquery comes out as
// a bare "id" — ambiguous against workers.id / artifacts.id. A mocked db never
// renders SQL, which is how this 500'd every ?status=<terminal> list in prod.
describe('terminalAuditFields', () => {
  const rendered = new QueryBuilder().select({ id: tasks.id, ...terminalAuditFields }).from(tasks).toSQL().sql;

  it('correlates the hasArtifact subquery to the outer tasks row by qualified name', () => {
    const exists = rendered.slice(rendered.indexOf('EXISTS'));
    expect(exists).toContain('"tasks"."id"');
    expect(exists).not.toMatch(/=\s*"id"/);
  });
});
