/**
 * The visual review's query builders, rendered through drizzle's QueryBuilder
 * (PgDialect): a mocked db would hide every predicate. Illustrative ids only.
 */
import { describe, expect, it } from 'bun:test';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE, SURFACE_AUDIT_TITLE_PREFIX } from '@buildd/core/surface-audit';
import {
  WORKSPACE_AWAITING_MISSIONS_LIMIT,
  visualReviewTasksQuery,
  visualReviewWorkersQuery,
  visualReviewWorkersForMissionsQuery,
  visualShotsForMissionsQuery,
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
    expect(sql).toMatch(/"a"\."worker_id" in \(select "w"\."id" from "workers" "w" inner join "tasks" "t" on "t"\."id" = "w"\."task_id" where "t"\."mission_id" = "missions"\."id" and \("t"\.role_slug = \$\d+ or "t"\.title like \$\d+\)\)/);
    expect(params).toContain(VISUAL_AUDITOR_ROLE_SLUG);
    expect(params).toContain(`${SURFACE_AUDIT_TITLE_PREFIX}%`);
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

describe('one audit identity in SQL', () => {
  // Each audit predicate is `(<alias>.role_slug = $a or <alias>.title like $b)`. Resolve $a and $b
  // against the bound params, so a swapped, shared or wrong value fails, not only a missing one.
  const boundPairs = (sql: string, params: unknown[], col: string) =>
    [...sql.matchAll(new RegExp(`\\(${col}\\.role_slug = \\$(\\d+) or ${col}\\.title like \\$(\\d+)\\)`, 'g'))]
      .map(m => ({ role: params[Number(m[1]) - 1], title: params[Number(m[2]) - 1] }));
  const EXPECTED = { role: VISUAL_AUDITOR_ROLE_SLUG, title: `${SURFACE_AUDIT_TITLE_PREFIX}%` };

  it('every task-scoped audit predicate binds the role slug and the title prefix', () => {
    const queries = [
      visualReviewWorkersQuery(qb(), MISSION).toSQL(),
      workspaceAwaitingMissionsQuery(qb(), WS, ['t']).toSQL(),
      visualShotsForMissionsQuery(qb(), [MISSION]).toSQL(),
      visualReviewWorkersForMissionsQuery(qb(), [MISSION]).toSQL(),
    ];
    for (const { sql, params } of queries) {
      const pairs = boundPairs(sql, params, '"t"');
      expect(pairs.length).toBeGreaterThan(0);
      for (const pair of pairs) expect(pair).toEqual(EXPECTED);
    }
    // The awaiting query carries two audit predicates: the candidate shot and the open audit.
    expect(boundPairs(queries[1].sql, queries[1].params, '"t"')).toHaveLength(2);
  });
  it('the audit context, summary and dependency-failure projections bind both values', () => {
    const { sql, params } = visualReviewTasksQuery(qb(), MISSION).toSQL();
    const pairs = [...sql.matchAll(/\("tasks"\."role_slug" = \$(\d+) or "tasks"\."title" like \$(\d+)\) (?:then|and)/g)]
      .map(m => ({ role: params[Number(m[1]) - 1], title: params[Number(m[2]) - 1] }));
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) expect(pair).toEqual(EXPECTED);
  });
});

describe('audit why columns', () => {
  it('projects the audit result summary only, never the whole result', () => {
    const { sql } = visualReviewTasksQuery(qb(), MISSION).toSQL();
    expect(sql).toContain(`then left("result" ->> 'summary', 500) else null end as "result_summary"`);
    expect(sql).not.toMatch(/"result"(,| from)/);
  });

  it('projects only the trunk-refresh marks of a non-audit task context', () => {
    const { sql } = visualReviewTasksQuery(qb(), MISSION).toSQL();
    expect(sql).toContain(`'requireMergeCommit', "context" -> 'requireMergeCommit', 'refreshTrunk', "context" -> 'refreshTrunk'`);
    expect(sql).not.toMatch(/"context"(,| from)/);
  });

  it('reads the worker error and base ref for audits', () => {
    const { sql } = visualReviewWorkersQuery(qb(), MISSION).toSQL();
    expect(sql).toMatch(/"merged_at", "pr_base_ref", "error" from "workers"/);
  });
});

describe('batch reads for the scheduler (spec 3ef37387 R-25)', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';

  it("ties each shot to an auditor of the shot's own mission, so a batch never lends one mission's auditor to another", () => {
    const { sql, params } = visualShotsForMissionsQuery(qb(), [MISSION, OTHER]).toSQL();
    expect(sql).toMatch(/"artifacts"\."mission_id" in \(\$1, \$2\)/);
    expect(sql).toContain(`where "t"."mission_id" = "artifacts"."mission_id" and ("t".role_slug = `);
    expect(sql).toContain(`jsonb_typeof("artifacts"."metadata" -> 'qa') = 'object'`);
    expect(params.slice(0, 2)).toEqual([MISSION, OTHER]);
  });

  it('keeps the newest shots per mission, not across the batch', () => {
    const { sql } = visualShotsForMissionsQuery(qb(), [MISSION, OTHER]).toSQL();
    expect(sql).toContain('row_number() over (partition by "artifacts"."mission_id" order by "artifacts"."created_at" desc)');
    expect(sql).toMatch(/"shot_rank" <= \$\d+/);
  });

  it('reads only audit and fix workers of the batch missions', () => {
    const { sql, params } = visualReviewWorkersForMissionsQuery(qb(), [MISSION, OTHER]).toSQL();
    expect(sql).toMatch(/"t"\."mission_id" in \(\$1, \$2\) and \(\("t"\.role_slug = \$3/);
    expect(params.slice(0, 2)).toEqual([MISSION, OTHER]);
  });
});
