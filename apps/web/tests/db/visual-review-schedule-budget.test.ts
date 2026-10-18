/**
 * The visual-review scheduler's cron run against its budget (Living Spec
 * "Fast at any size", R-25) on a real database.
 *
 * R-25: a scheduled job reads only what changed since its last run, or a
 * bounded batch, and no single run reads more than 5 MB from the database.
 *
 * Seed: the budget harness's team at ten times a large team's size, with every
 * open mission given an integration PR whose delivery has a head, so each one
 * is a candidate for the sweep. Two runs are measured: the first, which files
 * a review for every mission that owes one, and the next, which finds them
 * all filed (the steady state: what an hourly tick costs on a quiet fleet).
 *
 * GitHub fails on any call (no workspace is linked to a repo, so nothing
 * should ask); waking a filed audit for a runner is stubbed, it is a write the
 * schedule makes after deciding.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import { measureLoader, reportBudget, seedLargeTeam, seedScale, type Budget, type SeededTeam } from './budget-harness';

assertDbConfigured();

mock.module('server-only', () => ({}));
const dispatch = await import('../../src/lib/dispatch-authority');
const stubbed = { ...dispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} };
mock.module('../../src/lib/dispatch-authority', () => stubbed);
mock.module('@/lib/dispatch-authority', () => stubbed);
const githubCalls: string[] = [];
const github = await import('../../src/lib/github');
const githubStub = Object.fromEntries(Object.entries(github).map(([name, value]) =>
  typeof value === 'function' && name === 'githubApi'
    ? [name, (...args: unknown[]) => { githubCalls.push(String(args[1])); throw new Error('GitHub called by the visual-review sweep'); }]
    : [name, value]));
mock.module('../../src/lib/github', () => githubStub);
mock.module('@/lib/github', () => githubStub);

const { sweepVisualReviewSchedule } = await import('../../src/lib/workflow/visual-review-schedule-run');

/**
 * R-25's data ceiling. Queries: the run reads its batch's facts in a fixed
 * number of set queries whatever the batch holds; filing a review is a write
 * with its own few reads (the mission, its audits, the target workspace, the
 * insert), allowed per review filed.
 */
const BUDGET: Budget = { queries: 20, bytes: 5 * 1024 * 1024 };
const QUERIES_PER_FILING = 4;
const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

let team: SeededTeam;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  // A clean slate for the measured runs: no audit filed by an earlier run.
  await q(sql`DELETE FROM tasks WHERE workspace_id IN (SELECT id FROM workspaces WHERE team_id = ${team.teamId}::uuid) AND title LIKE '[surface audit]%'`);
  // Every open mission is on its integration branch with a PR open on a known head.
  await q(sql`
    WITH m AS (
      SELECT id, row_number() OVER (ORDER BY id) AS rn FROM missions
      WHERE team_id = ${team.teamId}::uuid AND status IN ('active', 'paused')
    )
    UPDATE missions SET primary_pr_number = 50000 + m.rn, working_branch = 'buildd/mission-' || m.rn
    FROM m WHERE missions.id = m.id AND missions.primary_pr_number IS NULL`);
  await q(sql`
    INSERT INTO workflow_deliveries (workspace_id, owner_task_id, pr_number, base_ref, state, current_head_sha)
    SELECT m.workspace_id, t.id, m.primary_pr_number, 'dev', 'OPEN', ${HEAD}
    FROM missions m
    JOIN LATERAL (SELECT id FROM tasks WHERE mission_id = m.id ORDER BY id LIMIT 1) t ON true
    WHERE m.team_id = ${team.teamId}::uuid AND m.primary_pr_number IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workflow_deliveries d WHERE d.workspace_id = m.workspace_id AND d.pr_number = m.primary_pr_number)`);
}, 900_000);

describe('visual-review-schedule run budget', () => {
  it('fits R-25 at AC-1 scale: a filing run and the steady run each read at most 5 MB, and never ask GitHub', async () => {
    const [{ n }] = await q<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM missions WHERE team_id = ${team.teamId}::uuid AND primary_pr_number IS NOT NULL AND status NOT IN ('completed', 'archived')`);
    expect(n).toBeGreaterThan(50);

    const runs: Array<{ label: string; outcomes: number; actions: Record<string, number>; queries: number; bytes: number }> = [];
    for (const label of ['visualReviewSchedule:filing', 'visualReviewSchedule:steady']) {
      let outcomes: Array<{ plan: { action: string } }> = [];
      const m = await measureLoader(label, async () => {
        ({ outcomes } = await sweepVisualReviewSchedule(Date.now(), 50, { workspaceIds: team.workspaceIds }));
      });
      reportBudget(m, BUDGET, scale);
      const actions: Record<string, number> = {};
      for (const o of outcomes) {
        const key = o.plan.action === 'none' ? `none:${(o.plan as { why?: string }).why}` : o.plan.action;
        actions[key] = (actions[key] ?? 0) + 1;
      }
      runs.push({ label, outcomes: outcomes.length, actions, queries: m.count, bytes: m.bytes });
      process.stdout.write(`[budget] ${label} plans: ${JSON.stringify(actions)}\n`);
    }
    for (const r of runs) {
      const queries = BUDGET.queries + QUERIES_PER_FILING * (r.actions.enqueue ?? 0);
      expect({ run: r.label, bytes: r.bytes, queries: r.queries <= queries ? 'within' : `${r.queries} > ${queries}` })
        .toEqual({ run: r.label, bytes: expect.any(Number), queries: 'within' });
      expect(r.bytes).toBeLessThanOrEqual(BUDGET.bytes);
    }
    expect(githubCalls).toEqual([]);
    // The first run filed reviews; the next found them filed and filed nothing new.
    expect(runs[0].actions.enqueue ?? 0).toBeGreaterThan(0);
    expect(runs[1].actions.enqueue ?? 0).toBe(0);
  }, 600_000);
});
