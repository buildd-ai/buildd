import { describe, it, expect } from 'bun:test';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { workers } from '../db/schema';

/**
 * Every GitHub webhook resolves "which worker owns this PR" by
 * `workers.pr_number` (usually paired with `pr_url` via repo-scope's
 * `workerOwnsPr` / `workerOwnsPrUrl`), and knowledge ingest looks a worker up
 * by `pr_url` alone. Without an index those are sequential scans of the whole
 * workers table on the webhook hot path.
 *
 * Both indexes are partial on IS NOT NULL: most workers never open a PR, and
 * every lookup is an equality on a non-null value, which the planner proves
 * implies the predicate. Rendered with the real dialect so the test reads what
 * the migration generator reads.
 */
const dialect = new PgDialect();
const indexes = getTableConfig(workers as any).indexes.map(i => ({
  name: i.config.name as string,
  columns: i.config.columns.map((c: any) => c.name as string),
  where: i.config.where ? dialect.sqlToQuery(i.config.where as any).sql : '',
}));

describe('workers PR lookup indexes', () => {
  it('indexes pr_number, partial on non-null', () => {
    const idx = indexes.find(i => i.columns[0] === 'pr_number');
    expect(idx).toBeDefined();
    expect(idx!.where).toContain(`"pr_number" IS NOT NULL`);
  });

  it('indexes pr_url, partial on non-null', () => {
    const idx = indexes.find(i => i.columns[0] === 'pr_url');
    expect(idx).toBeDefined();
    expect(idx!.where).toContain(`"pr_url" IS NOT NULL`);
  });
});
