import { describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { tasks } from '@buildd/core/db/schema';
import { workspaceActivityFields } from './activity';

// Rendered through drizzle itself (a mocked db never renders SQL): the list's
// one aggregate query, as loadWorkspaceActivity builds it.
const query = new QueryBuilder()
  .select(workspaceActivityFields)
  .from(tasks)
  .where(inArray(tasks.workspaceId, ['ws-a', 'ws-b']))
  .groupBy(tasks.workspaceId)
  .toSQL();
const text = query.sql.replace(/\s+/g, ' ');

describe('workspaceActivityFields', () => {
  it('is one select over tasks, grouped by workspace, scoped to the listed ids', () => {
    expect(text).toMatch(/from "tasks" where "tasks"\."workspace_id" in \(\$\d+, \$\d+\) group by "tasks"\."workspace_id"/);
    expect(query.params.slice(-2)).toEqual(['ws-a', 'ws-b']);
  });

  it('counts open and stuck tasks over the open statuses', () => {
    expect(text).toContain('max("created_at")');
    expect((text.match(/"status" in \(\$\d+, \$\d+, \$\d+\)/g) ?? []).length).toBe(2);
    expect(query.params).toContain('pending');
    expect(query.params).toContain('in_progress');
    expect(text).toContain(`"updated_at" < now() - interval '24 hours'`);
  });

  it('correlates the red-PR subquery to the outer task by qualified id', () => {
    const exists = text.slice(text.indexOf('exists'));
    expect(exists).toContain('w.task_id = "tasks"."id"');
    expect(exists).toContain(`w.pr_lifecycle_status = 'ci_failed'`);
    expect(exists).not.toMatch(/=\s*"id"/);
  });
});
