/**
 * The kill switch's SQL half rendered through the real PgDialect. That it agrees with
 * `kernelEnabled` value for value, on real Postgres, is tests/db/workflow-kill-switch-reading.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { kernelEnabled, kernelOnSql, workspaceKernelOnSql } from './kill-switch';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('the one reading of gitConfig.workflowKernel', () => {
  test('kernelOnSql: absent, null, true and on read as on', () => {
    expect(render(kernelOnSql(sql.raw('w.git_config'))).sql).toBe("(COALESCE((w.git_config)->>'workflowKernel', 'true') IN ('true', 'on'))");
  });

  test('workspaceKernelOnSql: no workspace row reads as on', () => {
    expect(render(workspaceKernelOnSql(sql.raw('d.workspace_id'))).sql)
      .toBe("NOT EXISTS (SELECT 1 FROM workspaces kw WHERE kw.id = d.workspace_id AND NOT (COALESCE((kw.git_config)->>'workflowKernel', 'true') IN ('true', 'on')))");
  });

  test('kernelEnabled: the TypeScript half fails toward legacy', () => {
    expect(kernelEnabled(null)).toBe(true);
    expect(kernelEnabled({ workflowKernel: 'on' })).toBe(true);
    expect(kernelEnabled({ workflowKernel: false })).toBe(false);
    expect(kernelEnabled({ workflowKernel: 'disabled' })).toBe(false);
  });
});
