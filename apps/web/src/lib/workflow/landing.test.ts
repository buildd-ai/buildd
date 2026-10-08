/**
 * The landing sweep's legacy floor keeps kernel PRs out of its "no verdict
 * yet" arms (landing.ts#notKernelOwnedPr): a kernel PR is a candidate only
 * through its APPROVED delivery. The statement runs on real Postgres in
 * apps/web/tests/db/workflow-matrix.test.ts (S10 sweep).
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { notKernelOwnedPr } from './landing';

describe('notKernelOwnedPr', () => {
  test('excludes a PR a live kernel delivery owns, scoped to its workspace and PR number', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(notKernelOwnedPr(sql`${'w1'}::uuid`, sql`${7}`));
    expect(text).toContain('NOT EXISTS (');
    expect(text).toContain('FROM workflow_deliveries kd JOIN workspaces kw ON kw.id = kd.workspace_id');
    expect(text).toContain("kd.workspace_id = $1::uuid AND kd.pr_number = $2 AND kd.authority = 'kernel'");
    // The kill switch hands the PR back to the legacy floor.
    expect(text).toContain("COALESCE(kw.git_config->>'workflowKernel', '') NOT IN ('false', 'off')");
    expect(params).toEqual(['w1', 7]);
  });
});
