/**
 * The hourly mission-invariant sweep against a real database (Living Spec
 * "Fast at any size": R-25, R-30).
 *
 * R-25: a scheduled job reads only what changed since its last run, or a
 * bounded batch, and no single run reads more than 5 MB from the database.
 * The sweep is a bounded batch (time windows and row caps); what made it
 * heavy was reading whole task context/result and mission criteria JSON to
 * look at a handful of keys. It now lifts those keys in SQL.
 *
 * Two things are pinned here:
 *  1. Every snapshot field a predicate reads still comes back, with the same
 *     value, from rows shaped like the ones that breach today (so every
 *     breach the sweep finds today is still found).
 *  2. The whole route, at ten times a large team's size, stays within the
 *     per-run budget.
 */
import { describe, it, expect, beforeAll, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { assertDbConfigured, q, seedWorkspace } from './harness';
import { measureLoader, reportBudget, seedLargeTeam, seedScale, expectWithinBudget, type SeededTeam } from './budget-harness';

assertDbConfigured();

// Outside services: no ref check (the seed bases nothing on a mission branch,
// but fail loudly if that changes) and no operator page.
const realGithub = await import('../../src/lib/github');
mock.module('../../src/lib/github', () => ({
  ...realGithub,
  githubApi: async () => { throw new Error('GitHub called by the invariant sweep budget test'); },
}));
const realPushover = await import('../../src/lib/pushover');
mock.module('../../src/lib/pushover', () => ({ ...realPushover, notifyOperator: () => {} }));

const { loadInvariantSnapshot } = await import('../../src/lib/mission-invariant-scan');
const { evaluateInvariants } = await import('../../src/lib/mission-invariants');
const { POST } = await import('../../src/app/api/cron/mission-invariants/route');

/**
 * R-25: no single run reads more than 5 MB. Queries: the batch's own fixed set,
 * plus at most two per mission base ref it checks (the owner's installation
 * lookup; the checks themselves are capped at MAX_REMOTE_REF_CHECKS). Other
 * files in a shared test database can leave open PRs on mission branches.
 */
const CRON_BYTES = 5 * 1024 * 1024;
const BASE_QUERIES = 20;
const QUERIES_PER_REF = 2;

const HOUR = 3_600_000;

let team: SeededTeam;
const scale = seedScale();

interface Fixture {
  workspaceId: string;
  missionId: string;
  escalatedMissionId: string;
  baseTaskId: string;
  planTaskId: string;
  gatedPlanTaskId: string;
  stringPlanTaskId: string;
}
let fx: Fixture;

async function seedFixture(): Promise<Fixture> {
  const { teamId, workspaceId } = await seedWorkspace();
  await q(sql`UPDATE workspaces SET git_config = ${JSON.stringify({ targetBranch: 'trunk-x', defaultBranch: 'dev-x', other: 'x'.repeat(2000) })}::jsonb
    WHERE id = ${workspaceId}::uuid`);
  const big = 'filler '.repeat(800);
  const [m] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title, status, integration_branch_enabled, working_branch, goal_criteria, goal_criteria_state, updated_at)
    VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'invariant fixture', 'active', true, NULL,
      ${JSON.stringify([{ type: 'command', command: 'true', label: big }])}::jsonb,
      ${JSON.stringify({ overall: 'fail', notes: big })}::jsonb, now() + interval '1 minute')
    RETURNING id`);
  const [esc] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title, status, criteria_escalated_at, goal_criteria, goal_criteria_state, updated_at)
    VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'escalated fixture', 'archived', now() - interval '3 days',
      '[]'::jsonb, NULL, now() + interval '1 minute')
    RETURNING id`);
  const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
  const insertTask = async (cols: { title: string; mode?: string; status: string; category?: string; missionId?: string | null; context: unknown; result: unknown; updatedAt?: string }) => {
    const [t] = await q<{ id: string }>(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, mode, status, category, context, result, created_at, updated_at)
      VALUES (${workspaceId}::uuid, ${cols.missionId ?? null}::uuid, ${cols.title}, ${cols.mode ?? 'execution'}, ${cols.status},
        ${cols.category ?? null}, ${JSON.stringify(cols.context)}::jsonb, ${cols.result === null ? null : JSON.stringify(cols.result)}::jsonb,
        ${ago(60)}::timestamptz, ${cols.updatedAt ?? new Date(Date.now() + 60_000).toISOString()}::timestamptz)
      RETURNING id`);
    return t.id;
  };
  const baseTaskId = await insertTask({
    title: 'based on the mission branch', status: 'in_progress', missionId: m.id,
    context: { baseBranch: 'buildd/mission-x', notes: big }, result: null,
  });
  const steps = [{ title: 'a', description: big }, { title: 'b' }, { title: 'c' }];
  const planTaskId = await insertTask({
    title: 'plan with no children', mode: 'planning', status: 'completed', updatedAt: ago(30),
    context: { notes: big }, result: { summary: big, structuredOutput: { plan: steps } },
  });
  const gatedPlanTaskId = await insertTask({
    title: 'plan awaiting approval', mode: 'planning', status: 'completed', updatedAt: ago(30),
    context: { requiresPlanApproval: true, notes: big }, result: { structuredOutput: { plan: steps } },
  });
  const stringPlanTaskId = await insertTask({
    title: 'plan as a string', mode: 'planning', status: 'completed', updatedAt: ago(30),
    context: {}, result: { structuredOutput: { plan: JSON.stringify(['x', 'y']) } },
  });
  await insertTask({
    title: 'review newest', category: 'review', status: 'completed', updatedAt: new Date(Date.now() + 120_000).toISOString(),
    context: { prNumber: 4242, notes: big }, result: { summary: big, structuredOutput: { verdict: 'approve', feedback: big } },
  });
  await insertTask({
    title: 'review older', category: 'review', status: 'completed', updatedAt: ago(2),
    context: { prNumber: 4242 }, result: { structuredOutput: { verdict: 'request_changes' } },
  });
  await insertTask({
    title: 'review string pr', category: 'review', status: 'completed', updatedAt: new Date(Date.now() + 120_000).toISOString(),
    context: { prNumber: '4343' }, result: { structuredOutput: {} },
  });
  return { workspaceId, missionId: m.id, escalatedMissionId: esc.id, baseTaskId, planTaskId, gatedPlanTaskId, stringPlanTaskId };
}

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  fx = await seedFixture();
}, 900_000);

describe('mission-invariant sweep snapshot', () => {
  it('lifts every key a predicate reads, with the values the JSON holds', async () => {
    const { snapshot } = await loadInvariantSnapshot(new Date());

    const mission = snapshot.missions.find(m => m.id === fx.missionId)!;
    expect(mission).toBeDefined();
    expect(mission.hasGoalCriteria).toBe(true);
    expect(mission.criteriaOverallVerdict).toBe('fail');
    expect(mission.integrationBranchEnabled).toBe(true);
    expect(mission.workingBranch).toBeNull();

    // Archived but escalated: kept, with no criteria and no verdict.
    const esc = snapshot.missions.find(m => m.id === fx.escalatedMissionId)!;
    expect(esc).toBeDefined();
    expect(esc.hasGoalCriteria).toBe(false);
    expect(esc.criteriaOverallVerdict).toBeNull();
    expect(esc.criteriaEscalatedAt).not.toBeNull();

    const base = snapshot.tasks.find(t => t.id === fx.baseTaskId)!;
    expect(base).toBeDefined();
    expect(base.contextBaseBranch).toBe('buildd/mission-x');
    expect(base.requiresPlanApproval).toBe(false);
    expect(base.planRaw).toBeNull();

    const plan = snapshot.tasks.find(t => t.id === fx.planTaskId)!;
    expect(plan.requiresPlanApproval).toBe(false);
    expect(Array.isArray(plan.planRaw) && (plan.planRaw as unknown[]).length).toBe(3);
    const gated = snapshot.tasks.find(t => t.id === fx.gatedPlanTaskId)!;
    expect(gated.requiresPlanApproval).toBe(true);
    const str = snapshot.tasks.find(t => t.id === fx.stringPlanTaskId)!;
    expect(str.planRaw).toBe(JSON.stringify(['x', 'y']));

    const review = snapshot.reviews.find(r => r.workspaceId === fx.workspaceId && r.prNumber === 4242)!;
    expect(review.verdict).toBe('approve');
    const strReview = snapshot.reviews.find(r => r.workspaceId === fx.workspaceId && r.prNumber === 4343)!;
    expect(strReview).toBeDefined();
    expect(strReview.verdict).toBeNull();

    expect([...(snapshot.trunkBranches.get(fx.workspaceId) ?? [])].sort()).toEqual(['dev-x', 'trunk-x']);
  }, 120_000);

  it('still finds the breaches those rows carry', async () => {
    const now = new Date();
    const { snapshot } = await loadInvariantSnapshot(now);
    const found = (key: string) => evaluateInvariants(snapshot, now).find(r => r.key === key)!.violations.map(v => v.entityId);
    expect(found('inert_integration_branch')).toContain(fx.missionId);
    expect(found('plan_produced_no_children')).toContain(fx.planTaskId);
    expect(found('plan_produced_no_children')).toContain(fx.stringPlanTaskId);
    expect(found('plan_awaiting_approval')).toContain(fx.gatedPlanTaskId);
    expect(found('plan_produced_no_children')).not.toContain(fx.gatedPlanTaskId);
  }, 120_000);
});

describe('mission-invariant sweep run budget', () => {
  it('fits R-25 at AC-1 scale: at most 5 MB per run', async () => {
    process.env.CRON_SECRET = 'budget-test-secret';
    let status = 0;
    let refs = 0;
    const m = await measureLoader('cron:mission-invariants', async () => {
      const res = await POST(new NextRequest('http://localhost/api/cron/mission-invariants', {
        method: 'POST', headers: { authorization: 'Bearer budget-test-secret' },
      }));
      status = res.status;
      const body = await res.json() as { scanned?: { remoteRefs?: number; remoteRefsSkipped?: number } };
      refs = (body.scanned?.remoteRefs ?? 0) + (body.scanned?.remoteRefsSkipped ?? 0);
    });
    const budget = { queries: BASE_QUERIES + QUERIES_PER_REF * refs, bytes: CRON_BYTES };
    reportBudget(m, budget, scale);
    expect(status).toBe(200);
    expect(m.count).toBeGreaterThan(0);
    expectWithinBudget(m, budget);
  }, 300_000);
});
