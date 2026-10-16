/**
 * The PR fact funnel's scope for terminal facts (docs/specs/workflow-kernel-library.md §1, S4a),
 * rendered through the real PgDialect: the predicate is what keeps a delivery-owned worker row
 * out of the funnel, so it is pinned as SQL rather than as a mocked call. Real-Postgres
 * behaviour is in apps/web/tests/db/kernel-pr-projection.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as sqlTag } from 'drizzle-orm';
import { recordPrFactSql } from '@buildd/core/pr-facts';
import { deliveryOwnedTaskSql, factFunnelScope, kernelOwnedRowSql, kernelProjectionScope, prRowOfDeliverySql } from './pr-fact-scope';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('factFunnelScope: a delivery-owned row takes only what its delivery already says', () => {
  test('merged: excluded while a kernel-owned delivery of the PR is anything but MERGED', () => {
    const { sql, params } = render(factFunnelScope.where('merged')!);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw ON kw.id = kd.workspace_id');
    expect(sql).toContain('AND kd.state NOT IN (SELECT jsonb_array_elements_text($');
    expect(sql).toContain("kd.authority = 'kernel'");
    // The kill switch: a workspace with the kernel off is legacy's, so the funnel writes as before.
    expect(sql).toContain("(COALESCE((kw.git_config)->>'workflowKernel', 'true') IN ('true', 'on'))");
    expect(sql).toContain("w.workspace_id = kd.workspace_id AND w.pr_number = kd.pr_number AND lower(w.pr_url) = lower('https://github.com/' || kd.repo_full_name || '/pull/' || kd.pr_number::text)");
    expect(sql).toContain('kd.state NOT IN (SELECT jsonb_array_elements_text($');
    expect(params).toContain(JSON.stringify(['MERGED']));
  });

  test('closed: agrees with a delivery that is closed, superseded or abandoned, never with a merged one', () => {
    const { params } = render(factFunnelScope.where('closed')!);
    expect(params).toContain(JSON.stringify(['CLOSED_UNMERGED', 'SUPERSEDED', 'ABANDONED']));
  });

  test('the funnel statement carries the scope in its row lock and its UPDATE', () => {
    const q = recordPrFactSql({ prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7 }, { kind: 'merged', mergedAt: '2026-10-01T00:00:00Z' }, {}, factFunnelScope.where('merged'));
    expect(render(q!).sql.match(/FROM workflow_deliveries kd/g)?.length).toBe(2);
  });

  test("the kernel's own projection is unscoped: it is the writer", () => {
    expect(kernelProjectionScope.where('merged')).toBeNull();
    expect(kernelProjectionScope.where('closed')).toBeNull();
  });

  test('one reading of "this worker row carries that delivery\'s PR", for the projection and the exclusion', () => {
    expect(render(prRowOfDeliverySql('d')).sql).toBe("w.workspace_id = d.workspace_id AND w.pr_number = d.pr_number AND lower(w.pr_url) = lower('https://github.com/' || d.repo_full_name || '/pull/' || d.pr_number::text)");
  });

  test('kernelOwnedRowSql is the one "delivery-owned": kernel authority, switch on, the PR matched; legacy and switch-off are not', () => {
    const { sql } = render(kernelOwnedRowSql());
    expect(sql.startsWith('EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw')).toBe(true);
    expect(sql).toContain("kd.authority = 'kernel'");
    expect(sql).toContain("'workflowKernel'");
    expect(sql).not.toContain('owner_task_id');
  });
});

describe('deliveryOwnedTaskSql (S4b): the task-side definition of delivery-owned', () => {
  test('the owner of a kernel-authority delivery bound to a PR, kill switch on', () => {
    const { sql } = render(deliveryOwnedTaskSql(sqlTag`t.id`));
    expect(sql).toContain('EXISTS (SELECT 1 FROM workflow_deliveries kd JOIN workspaces kw ON kw.id = kd.workspace_id');
    expect(sql).toContain("kd.owner_task_id = t.id AND kd.authority = 'kernel' AND kd.pr_number IS NOT NULL");
    expect(sql).toContain("(COALESCE((kw.git_config)->>'workflowKernel', 'true') IN ('true', 'on'))");
    expect(sql).not.toContain('kd.state');
  });

  test('live: only while the delivery has not reached a terminal state', () => {
    const { sql, params } = render(deliveryOwnedTaskSql(sqlTag`t.id`, { live: true }));
    expect(sql).toContain('AND kd.state NOT IN (SELECT jsonb_array_elements_text($1::jsonb))');
    expect(JSON.parse(params[0] as string).sort()).toEqual(['ABANDONED', 'FAILED', 'MERGED', 'SUPERSEDED']);
  });
});
