import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, isNull } from 'drizzle-orm';

// Several worker rows can carry one PR: a CI-retry attempt pushes to its
// parent's branch and adopts the PR number when it completes. The merge used to
// be stamped on one of them (the webhook's findFirst), so every reader that
// judged rows one at a time still saw the PR open ("Merge PR #N" after it
// merged). These tests pin both halves of the fix: the write stamps every row
// carrying the PR, and the read treats a PR as merged when any row saw it.
//
// Predicates are rendered through PgDialect, not asserted against a mocked
// `db`: a mocked db cannot see what a WHERE clause actually scopes to.

let captured: { set?: Record<string, unknown>; where?: unknown } = {};
const returned: Array<{ id: string; taskId: string | null }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => {
        captured.set = set;
        return {
          where: (where: unknown) => {
            captured.where = where;
            return { returning: async () => returned };
          },
        };
      },
    }),
  },
}));

const { stampPrMergedOnAllRows, noRowOfPrMerged, oneRowPerPr } = await import('./pr-merge-stamp');
const { workers } = await import('@buildd/core/db/schema');

const dialect = new PgDialect();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const PR_URL = 'https://github.com/example-org/example-repo/pull/416';

beforeEach(() => {
  captured = {};
  returned.length = 0;
});

describe('stampPrMergedOnAllRows', () => {
  it('scopes the update to every unmerged row carrying the PR, not to one worker id', async () => {
    const mergedAt = new Date('2026-09-01T12:00:00Z');
    await stampPrMergedOnAllRows({ prUrl: PR_URL, prNumber: 416, mergedAt });

    const q = dialect.sqlToQuery(captured.where as any);
    const text = norm(q.sql);
    expect(text).toContain('"workers"."pr_number" = $');
    expect(text).toContain('"workers"."pr_url" = $');
    expect(text).toContain('"workers"."merged_at" is null');
    // Never keyed on a single row.
    expect(text).not.toContain('"workers"."id"');
    expect(q.params).toContain(416);
    expect(q.params).toContain(PR_URL);

    expect(captured.set?.mergedAt).toEqual(mergedAt);
    expect(captured.set?.prLifecycleStatus).toBe('merged');
  });

  it('carries extra columns (the heal paths stamp verification times too)', async () => {
    const now = new Date('2026-09-01T12:05:00Z');
    await stampPrMergedOnAllRows({
      prUrl: PR_URL, prNumber: 416, mergedAt: now, extra: { prLastVerifiedAt: now, prCheckFailureCount: 0 },
    });
    expect(captured.set?.prLastVerifiedAt).toEqual(now);
    expect(captured.set?.prCheckFailureCount).toBe(0);
    expect(captured.set?.prLifecycleStatus).toBe('merged');
  });

  it('returns the rows it stamped', async () => {
    returned.push({ id: 'w-owner', taskId: 't-owner' }, { id: 'w-retry', taskId: 't-retry' });
    const rows = await stampPrMergedOnAllRows({ prUrl: PR_URL, prNumber: 416, mergedAt: new Date() });
    expect(rows.map(r => r.id)).toEqual(['w-owner', 'w-retry']);
  });

  it('refuses a PR identity it cannot scope (never an unscoped UPDATE)', async () => {
    const rows = await stampPrMergedOnAllRows({ prUrl: '', prNumber: 416, mergedAt: new Date() });
    expect(rows).toEqual([]);
    expect(captured.where).toBeUndefined();
  });
});

describe('oneRowPerPr', () => {
  it("keeps the PR owner's row (earliest created), so a retry row cannot mask the owner's CI state", () => {
    const owner = { id: 'w-owner', prUrl: PR_URL, createdAt: new Date('2026-09-01T10:00:00Z'), prLifecycleStatus: 'ci_running' };
    const retry = { id: 'w-retry', prUrl: PR_URL, createdAt: new Date('2026-09-01T10:10:00Z'), prLifecycleStatus: null };
    expect(oneRowPerPr([retry, owner]).map(r => r.id)).toEqual(['w-owner']);
    expect(oneRowPerPr([owner, retry]).map(r => r.id)).toEqual(['w-owner']);
  });

  it('keeps distinct PRs and rows without a PR, in input order', () => {
    const a = { id: 'a', prUrl: PR_URL, createdAt: new Date('2026-09-01T10:00:00Z') };
    const b = { id: 'b', prUrl: `${PR_URL.slice(0, -3)}417`, createdAt: new Date('2026-09-01T09:00:00Z') };
    const c = { id: 'c', prUrl: null, createdAt: new Date('2026-09-01T08:00:00Z') };
    expect(oneRowPerPr([a, b, c]).map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('noRowOfPrMerged', () => {
  it('excludes a row when ANY row with the same PR url and number recorded the merge', () => {
    const q = dialect.sqlToQuery(noRowOfPrMerged() as any);
    const text = norm(q.sql);
    expect(text).toMatch(/^not exists \(select 1 from "workers" "pr_row" where/i);
    // Correlated to the outer row's PR identity...
    expect(text).toContain('"pr_row"."pr_url" = "workers"."pr_url"');
    expect(text).toContain('"pr_row"."pr_number" = "workers"."pr_number"');
    // ...and satisfied by any sibling's merge.
    expect(text).toContain('"pr_row"."merged_at" is not null');
    expect(q.params).toEqual([]);
  });

  it('correlates to the relation alias inside a nested relational `with` (the blocker-card query)', async () => {
    const { drizzle } = await import('drizzle-orm/pg-proxy');
    const schema = await import('@buildd/core/db/schema');
    const offline = drizzle(async () => ({ rows: [] }), { schema });
    const q = offline.query.tasks.findMany({
      columns: { id: true },
      with: { workers: { where: and(isNull(workers.mergedAt), noRowOfPrMerged()), columns: { prUrl: true } } },
    }).toSQL();
    const text = norm(q.sql);
    const m = text.match(/"pr_row"\."pr_url" = "([^"]+)"\."pr_url"/);
    expect(m).not.toBeNull();
    // The outer reference must be the nested relation's alias, which is also
    // what its own merged_at filter uses. Pointing at a different table would
    // make the subquery constant.
    expect(text).toContain(`"${m![1]}"."merged_at" is null`);
  });

  it('composes with the column references of the outer query', () => {
    const outer = dialect.sqlToQuery(and(isNull(workers.mergedAt), noRowOfPrMerged()) as any);
    expect(norm(outer.sql)).toContain('"workers"."merged_at" is null and not exists');
  });
});
