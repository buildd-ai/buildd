import { describe, it, expect } from 'bun:test';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { tasks } from '../db/schema';

/**
 * Rebase-storm dedup for CI retries.
 *
 * A force-rebasing bot fires several failing check_suites for one PR within
 * minutes, each with a distinct head SHA, so the exact (workspace, PR, headSha)
 * index lets every one through. The guard is a partial unique index allowing at
 * most one still-PENDING webhook CI retry per PR.
 *
 * It must be scoped to CI retries. Reviewer passes and conflict retries are also
 * `taskClass: 'attempt'` children of the same parent, and the reviewer insert has
 * no ON CONFLICT clause — an index keyed on parent_task_id across every attempt
 * kind makes that insert throw whenever a CI retry is pending, and makes a
 * pending reviewer or conflict retry silently swallow every later CI failure.
 *
 * The WHERE clauses are rendered to SQL with the real dialect, so these tests
 * read what the migration generator reads.
 */
const dialect = new PgDialect();
const uniqueIndexes = getTableConfig(tasks as any).indexes
  .filter(i => i.config.unique)
  .map(i => ({
    name: i.config.name as string,
    columns: i.config.columns.map((c: any) => c.name as string),
    where: i.config.where ? dialect.sqlToQuery(i.config.where as any).sql : '',
  }));

const pendingScoped = uniqueIndexes.filter(i => /"status" = 'pending'/.test(i.where));

describe('pending CI-retry dedup index', () => {
  it('allows at most one pending webhook CI retry per (workspace, PR), whatever the head SHA', () => {
    const idx = pendingScoped.find(
      i => i.columns.join(',') === 'workspace_id,ci_retry_pr_number',
    );
    expect(idx).toBeDefined();
    expect(idx!.where).toContain(`"ci_retry_pr_number" IS NOT NULL`);
    expect(idx!.where).toContain(`"creation_source" = 'webhook'`);
    // head SHA is deliberately NOT part of the key — that is the whole point.
    expect(idx!.columns).not.toContain('ci_retry_head_sha');
  });

  it('does not constrain reviewer passes or conflict retries (no ci_retry_pr_number)', () => {
    // Every pending-scoped unique index that touches attempt rows must require a
    // CI-retry PR number, so rows without one — reviewer and conflict attempts —
    // fall outside it entirely.
    const overBroad = pendingScoped.filter(
      i => !i.where.includes(`"ci_retry_pr_number" IS NOT NULL`) && i.columns.includes('parent_task_id'),
    );
    expect(overBroad.map(i => i.name)).toEqual([]);
  });
});
