import { describe, it, expect } from 'bun:test';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { tasks } from '../db/schema';

/**
 * One review producer per (PR, head SHA).
 *
 * Two producers file a reviewer for a freshly opened PR — the create_pr
 * auto-review and the pull_request `opened` webhook — and they fire within
 * milliseconds of each other. `createReviewerTask` probes for a live reviewer
 * first, but both probes can run before either insert lands, so the probe alone
 * lets both through. The partial unique index is the idempotency key that makes
 * the loser's insert a no-op.
 *
 * Scoped to `pending`: at insert time every reviewer row is pending, so that is
 * the whole race window, and a pending row has no worker, so the migration can
 * collapse any existing duplicate without interrupting anything. Claimed rows
 * are covered by the live probe.
 *
 * The WHERE clause is rendered with the real dialect, so this reads what the
 * migration generator reads.
 */
const dialect = new PgDialect();
const uniqueIndexes = getTableConfig(tasks as any).indexes
  .filter(i => i.config.unique)
  .map(i => ({
    name: i.config.name as string,
    columns: i.config.columns.map((c: any) => c.name as string),
    where: i.config.where ? dialect.sqlToQuery(i.config.where as any).sql : '',
  }));

describe('pending reviewer dedup index', () => {
  const idx = uniqueIndexes.find(
    i => i.columns.join(',') === 'workspace_id,subject_pr_number,subject_head_sha',
  );

  it('keys a pending review on (workspace, PR, head SHA)', () => {
    expect(idx).toBeDefined();
    expect(idx!.where).toContain(`"category" = 'review'`);
    expect(idx!.where).toContain(`"status" = 'pending'`);
    expect(idx!.where).toContain(`"subject_pr_number" IS NOT NULL`);
    expect(idx!.where).toContain(`"subject_head_sha" IS NOT NULL`);
  });

  it('constrains only webhook-filed reviewer rows, not human or API filings', () => {
    // POST /api/tasks auto-classifies any title matching /\breview\b/ as
    // category 'review' and derives the same subject anchor from legacy
    // context keys. Those rows must not collide with a pending reviewer (the
    // route would surface a raw 23505 as an opaque 500). createReviewerTask is
    // the only producer that files with creation_source = 'webhook'.
    expect(idx!.where).toContain(`"creation_source" = 'webhook'`);
    // Reviewer rows always point at the task whose PR they review; other
    // webhook producers (external ingest) file parentless rows.
    expect(idx!.where).toContain(`"parent_task_id" IS NOT NULL`);
  });

  it('keys on the subject anchor, not on the conflict/CI retry columns', () => {
    // Conflict and CI retries carry their own dedup indexes keyed on their own
    // PR columns; this index must not be one of those under another name.
    expect(idx!.where).not.toContain('ci_retry_pr_number');
    expect(idx!.where).not.toContain('conflict_retry_pr_number');
  });
});
