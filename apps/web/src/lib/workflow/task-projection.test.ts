/**
 * S4b (workflow-kernel-library.md §1, AC-2): the owner-task projection T17 embeds, rendered through
 * the real PgDialect. Behaviour on Postgres is tests/db/kernel-pr-projection.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mergeTaskPayloadSql, mergeTaskProjectionCtes, mergeTaskTransitionOf } from './task-projection';

const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => new PgDialect().sqlToQuery(q);

describe('mergeTaskProjectionCtes', () => {
  const ctes = mergeTaskProjectionCtes('d').map((c) => render(c));

  test('own: the PR\'s first worker row of the delivery, by the shared row predicate', () => {
    expect(ctes[0].sql).toContain('own AS (\n  SELECT w.id, w.task_id, w.runner FROM workers w, d');
    expect(ctes[0].sql).toContain("w.workspace_id = d.workspace_id AND w.pr_number = d.pr_number AND lower(w.pr_url) = lower('https://github.com/' || d.repo_full_name || '/pull/' || d.pr_number::text)");
    expect(ctes[0].sql).toContain('ORDER BY w.created_at ASC, w.id ASC\n  LIMIT 1');
  });

  test('t_proj: completes the task unless completed, a local session, or another open PR', () => {
    const { sql: t, params } = ctes[2];
    expect(t).toContain("t_proj AS (\n  UPDATE tasks tk SET status = 'completed', updated_at = now()\n  FROM own, d");
    expect(t).toContain("tk.id = own.task_id AND tk.status <> 'completed'");
    expect(t).toContain('own.runner IS DISTINCT FROM $1::text');
    expect(params[0]).toBe('mcp');
    expect(t).toContain('lower(ow.pr_url) <> lower(');
    expect(t).toContain('ow.pr_lifecycle_status NOT IN ($2::text, $3::text, $4::text)');
    expect(params.slice(1)).toEqual(['merged', 'closed', 'unresolvable']);
    expect(t).toContain('mw.merged_at IS NOT NULL');
  });

  test('the payload names what the statement did and for which row', () => {
    const { sql: p } = render(mergeTaskPayloadSql());
    expect(p).toContain("WHEN EXISTS (SELECT 1 FROM t_proj) THEN 'flipped'");
    expect(p).toContain("WHEN (SELECT status FROM own_task) = 'completed' THEN 'already_completed'");
    expect(p).toContain("'ownerWorkerId', (SELECT id FROM own)");
    expect(render(sql`${mergeTaskPayloadSql()}`).sql).toContain('jsonb_build_object(');
  });
});

describe('mergeTaskTransitionOf', () => {
  test('reads the statement\'s answer; an effect from before S4b has none', () => {
    expect(mergeTaskTransitionOf({ taskTransition: 'flipped', ownerWorkerId: 'w1' })).toEqual({ taskTransition: 'flipped', ownerWorkerId: 'w1' });
    expect(mergeTaskTransitionOf({ taskTransition: 'not_flipped', ownerWorkerId: null })).toEqual({ taskTransition: 'not_flipped', ownerWorkerId: null });
    expect(mergeTaskTransitionOf({ mergeCommitSha: 'x' })).toBeNull();
    expect(mergeTaskTransitionOf(undefined)).toBeNull();
    expect(mergeTaskTransitionOf({ taskTransition: 'bogus' })).toBeNull();
  });
});
