import { describe, it, expect, mock } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';

/**
 * The readout's four queries, rendered to real SQL.
 *
 * The db client is replaced by drizzle's standalone QueryBuilder, which builds
 * the exact statement the client would send and renders it with the real
 * PgDialect via `.toSQL()` — without a connection. A mocked `drizzle-orm`
 * would accept a cohort filter on the wrong column (or no filter at all), and
 * route tests stub drizzle, so this is the only place an unrendered SQL bug in
 * the readout gets caught.
 */
mock.module('../db/client', () => ({
  db: { select: (fields: any) => new QueryBuilder().select(fields) },
}));

const src = await import('../experiment-readout-source');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const EXP_ID = '5b0f6c1e-0000-4000-8000-00000000000b';

describe('experiment readout queries', () => {
  it('assignments: cohort = experiment AND policy_version, joined to tasks, newest first, capped', () => {
    const q = src.buildAssignmentsQuery(EXP_ID, 3).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('from "experiment_assignments" inner join "tasks" on "tasks"."id" = "experiment_assignments"."task_id"');
    expect(sql).toContain('where ("experiment_assignments"."experiment_id" = $1 and "experiment_assignments"."policy_version" = $2)');
    expect(sql).toContain('order by "experiment_assignments"."assigned_at" desc');
    expect(sql).toContain('"tasks"."status"');
    expect(sql).toContain('"tasks"."kind"');
    expect(q.params).toEqual([EXP_ID, 3, src.EXPERIMENT_READOUT_ROW_LIMIT]);
  });

  it('workers: by task id with inArray (IN list, never ANY(array))', () => {
    const q = src.buildWorkersQuery(['a', 'b']).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('from "workers" where "workers"."task_id" in ($1, $2)');
    expect(sql).not.toContain('any(');
    for (const col of ['pr_url', 'merged_at', 'pr_lifecycle_status', 'turns', 'result_meta', 'created_at']) {
      expect(sql).toContain(`"${col}"`);
    }
    expect(q.params).toEqual(['a', 'b']);
  });

  it('attempt children: parent_task_id IN (...) AND task_class = attempt', () => {
    const q = src.buildAttemptChildrenQuery(['a']).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('where ("tasks"."parent_task_id" in ($1) and "tasks"."task_class" = $2)');
    expect(sql).toContain('select "parent_task_id", "ci_retry_pr_number", "reviewer_retry_pr_number" from "tasks"');
    expect(q.params).toEqual(['a', 'attempt']);
  });

  it('outcomes: by task id, reading the exit_cause column', () => {
    const q = src.buildOutcomesQuery(['a', 'b', 'c']).toSQL();
    const sql = norm(q.sql);
    expect(sql).toContain('from "task_outcomes" where "task_outcomes"."task_id" in ($1, $2, $3)');
    expect(sql).toContain('select "task_id", "exit_cause", "created_at" from "task_outcomes"');
  });
});
