import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { occupancyWhere } from './fleet-occupancy-query';

const dialect = new PgDialect();
const SINCE = new Date('2026-10-07T12:00:00Z');
const NOW = new Date('2026-10-08T12:00:00Z');

describe('occupancyWhere', () => {
  const q = dialect.sqlToQuery(occupancyWhere(['ws-1', 'ws-2'], SINCE, NOW));

  it('is scoped to the given workspaces, first, so no other team\'s workers are read', () => {
    expect(q.sql).toMatch(/^\("workers"\."workspace_id" in \(\$1, \$2\)/);
    expect(q.params.slice(0, 2)).toEqual(['ws-1', 'ws-2']);
  });

  it('reads only started workers that started before now', () => {
    expect(q.sql).toContain('"workers"."started_at" is not null');
    expect(q.sql).toContain('"workers"."started_at" < $3');
  });

  it('keeps finished-in-window workers, and unfinished ones that are live or were touched in the window', () => {
    expect(q.sql).toContain('"workers"."completed_at" >= $');
    expect(q.sql).toContain('"workers"."completed_at" is null');
    expect(q.sql).toContain('"workers"."status" in (');
    expect(q.sql).toContain('"workers"."updated_at" >= $');
    expect(q.params).toContain('waiting_input');
    expect(q.params).toContain('running');
  });
});
