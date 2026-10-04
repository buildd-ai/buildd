/**
 * The visual review's query builders, rendered through drizzle's QueryBuilder
 * (PgDialect): a mocked db would hide every predicate. Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE } from '@buildd/core/surface-audit';
import {
  WORKSPACE_AWAITING_MISSIONS_LIMIT,
  visualReviewTasksQuery,
  visualReviewWorkersQuery,
  workspaceAwaitingMissionsQuery,
} from './visual-review-query';

const WS = '22222222-2222-4222-8222-222222222222';
const MISSION = '11111111-1111-4111-8111-111111111111';
const qb = () => new QueryBuilder();

describe('workspaceAwaitingMissionsQuery', () => {
  const { sql, params } = workspaceAwaitingMissionsQuery(qb(), WS, ['team-a', 'team-b']).toSQL();

  it('reads missions, scoped to the workspace and the caller teams', () => {
    expect(sql).toMatch(/from "missions" where/);
    expect(sql).toContain('"missions"."workspace_id" = $1');
    expect(sql).toMatch(/"missions"\."team_id" in \(\$2, \$3\)/);
    expect(params.slice(0, 3)).toEqual([WS, 'team-a', 'team-b']);
  });

  it('candidate: an auditor-scoped unsure screenshot with no active review', () => {
    expect(sql).toContain(`"a"."type" = 'screenshot'`);
    expect(sql).toContain(`"a"."metadata" -> 'qa' ->> 'verdict' = 'unsure'`);
    expect(sql).toMatch(/"a"\."worker_id" in \(select "w"\."id" from "workers" "w" inner join "tasks" "t" on "t"\."id" = "w"\."task_id" where "t"\."mission_id" = "missions"\."id" and "t"\."role_slug" = \$\d+\)/);
    expect(params).toContain('visual-auditor');
    expect(sql).toContain('not exists (select 1 from "visual_shot_reviews" "r" where "r"."artifact_id" = "a"."id" and "r"."superseded_at" is null)');
  });

  it('candidate: the open round-cap question, or an auditor worker waiting on a question', () => {
    expect(sql).toMatch(/exists \(select 1 from "mission_notes" "n" where "n"\."mission_id" = "missions"\."id" and "n"\."title" = \$\d+ and "n"\."status" = 'open'\)/);
    expect(params).toContain(SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE);
    expect(sql).toMatch(/"w"\."status" = 'waiting_input'/);
    expect(sql).toMatch(/\) or exists \(/);
  });

  it('newest first, one past the limit so the caller can say more exist', () => {
    expect(sql).toContain('order by "missions"."updated_at" desc');
    expect(params[params.length - 1]).toBe(WORKSPACE_AWAITING_MISSIONS_LIMIT + 1);
  });
});

describe('audit why columns', () => {
  it('projects the audit result summary only, never the whole result', () => {
    const { sql } = visualReviewTasksQuery(qb(), MISSION).toSQL();
    expect(sql).toContain(`then left("result" ->> 'summary', 500) else null end as "result_summary"`);
    expect(sql).not.toMatch(/"result"(,| from)/);
  });

  it('reads the worker error and base ref for audits', () => {
    const { sql } = visualReviewWorkersQuery(qb(), MISSION).toSQL();
    expect(sql).toMatch(/"merged_at", "pr_base_ref", "error" from "workers"/);
  });
});
