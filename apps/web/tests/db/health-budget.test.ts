/**
 * The Health pages' loads against their budget (Living Spec "Fast at any
 * size": R-6, R-9, R-11, R-14, R-15, R-23, R-30) on a real database.
 *
 * R-6: Overview, Failures and Runners each make at most 15 queries and read
 * at most 200 KB before they respond, call no outside service and write
 * nothing, for a team at ten times a large team's size.
 *
 * R-23: runner heartbeats are read for the viewer's team in the query itself.
 * The seed adds fresh heartbeats on other teams' runners; the page must not
 * read them to throw them away.
 *
 * Measured: each page's own server load, signed in as the team's owner with
 * no filters, in a request whose layout already ran (page-render.ts).
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite, treeText } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: OverviewPage } = await import('../../src/app/app/(protected)/health/page');
const { default: FailuresPage } = await import('../../src/app/app/(protected)/health/failures/page');
const { default: RunnersPage } = await import('../../src/app/app/(protected)/health/runners/page');
const { default: HealthLayout } = await import('../../src/app/app/(protected)/health/layout');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

let team: SeededTeam;
const scale = seedScale();

const SCHEDULES = 60;
const OTHER_TEAM_RUNNERS = 300;

/**
 * What the Health pages read that the shared seed has none of: schedules with
 * large task templates (a few failing), runner accounts with fresh heartbeats
 * on this team, and many more on other teams. Synthetic; reused when present.
 */
async function seedHealthExtras(t: SeededTeam): Promise<void> {
  const [{ n }] = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM task_schedules WHERE workspace_id = ANY(${`{${t.workspaceIds.join(',')}}`}::uuid[])`);
  if (n >= SCHEDULES) return;
  const ws = `{${t.workspaceIds.join(',')}}`;
  await q(sql`
    INSERT INTO task_schedules (workspace_id, name, cron_expression, task_template, enabled, last_error, consecutive_failures, next_run_at, last_run_at)
    SELECT (${ws}::uuid[])[1 + g % ${t.workspaceIds.length}], 'Schedule ' || g, '0 * * * *',
      jsonb_build_object('title', 'Scheduled check ' || g,
        'description', repeat('What this scheduled task does, step by step, and how it reports. ', 40),
        'context', jsonb_build_object('notes', repeat('Carried context for every run. ', 60))),
      g % 6 <> 0,
      CASE WHEN g % 5 = 0 THEN 'The last run failed: the check timed out.' END,
      CASE WHEN g % 5 = 0 THEN 2 ELSE 0 END,
      now() + (g % 12) * interval '1 hour', now() - (g % 12) * interval '1 hour'
    FROM generate_series(1, ${SCHEDULES}) g`);

  // This team's runners: two accounts, each with a fresh heartbeat.
  const own = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id)
    SELECT 'user', 'budget runner ' || g, 'bld_budget_' || md5(random()::text), ${t.teamId}::uuid FROM generate_series(1, 2) g
    RETURNING id`);
  for (const a of own) {
    await q(sql`INSERT INTO account_workspaces (account_id, workspace_id, can_claim)
      SELECT ${a.id}::uuid, unnest(${ws}::uuid[]), true`);
  }
  await q(sql`
    INSERT INTO worker_heartbeats (account_id, local_ui_url, workspace_ids, max_concurrent_workers, active_worker_count, environment, last_heartbeat_at)
    SELECT a.id, 'http://127.0.0.1:8766', to_jsonb(${ws}::uuid[]), 4, 1,
      jsonb_build_object('tools', (SELECT jsonb_agg(jsonb_build_object('name', 'tool-' || i, 'version', '1.' || i)) FROM generate_series(1, 40) i)),
      now() - interval '20 seconds'
    FROM unnest(${`{${own.map(a => a.id).join(',')}}`}::uuid[]) AS a(id)`);

  // Other teams' runners, all fresh: the page must not read them.
  const [other] = await q<{ id: string }>(sql`
    INSERT INTO teams (name, slug) VALUES ('Other runners team', ${`budget-other-${Date.now().toString(36)}`}) RETURNING id`);
  await q(sql`
    WITH a AS (
      INSERT INTO accounts (type, name, api_key, team_id)
      SELECT 'user', 'other runner ' || g, 'bld_other_' || md5(random()::text || g), ${other.id}::uuid
      FROM generate_series(1, ${OTHER_TEAM_RUNNERS}) g RETURNING id)
    INSERT INTO worker_heartbeats (account_id, local_ui_url, workspace_ids, environment, last_heartbeat_at)
    SELECT a.id, 'http://127.0.0.1:8766', '[]'::jsonb,
      jsonb_build_object('tools', (SELECT jsonb_agg(jsonb_build_object('name', 'tool-' || i, 'version', '1.' || i)) FROM generate_series(1, 40) i)),
      now() - interval '30 seconds'
    FROM a`);
  for (const table of ['task_schedules', 'worker_heartbeats', 'accounts']) await q(sql`ANALYZE ${sql.identifier(table)}`);
}

/**
 * Recent workers the failure rate treats specially: bookkeeping exits (a
 * failed status that is not the work failing) and in-flight ones (not yet
 * terminal), so the SQL headline is checked on both rules.
 */
async function seedFailureEdgeWorkers(t: SeededTeam): Promise<void> {
  const [{ n }] = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM workers
    WHERE workspace_id = ANY(${`{${t.workspaceIds.join(',')}}`}::uuid[]) AND name LIKE 'budget-edge-%'`);
  if (n > 0) return;
  await q(sql`
    WITH t AS (
      SELECT id, workspace_id, row_number() OVER (ORDER BY id) AS rn FROM tasks
      WHERE workspace_id = ANY(${`{${t.workspaceIds.join(',')}}`}::uuid[]) LIMIT 40)
    INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, exit_cause, error, created_at, completed_at)
    SELECT t.id, t.workspace_id, 'budget-edge-' || t.rn, 'runner-edge', 'buildd/edge-' || t.rn,
      (ARRAY['failed', 'failed', 'running', 'waiting_input', 'error'])[1 + t.rn % 5],
      (ARRAY['needs_input', 'never_started', NULL, NULL, 'code_failure'])[1 + t.rn % 5],
      'Error: edge case ' || t.rn,
      now() - interval '2 hours',
      CASE WHEN t.rn % 5 IN (2, 3) THEN NULL ELSE now() - interval '1 hour' END
    FROM t`);
}

/**
 * An active root cause that names some of the team's tasks, so the service
 * status read takes its affected-tasks path on every run, not only after an
 * earlier file in the same database happened to leave one behind.
 */
async function seedActiveRootCause(t: SeededTeam): Promise<void> {
  await q(sql`
    INSERT INTO root_causes (team_id, key, capability_kind, component, workspace_id, classification, affected_task_ids, first_seen_at, last_seen_at)
    SELECT ${t.teamId}::uuid, 'budget:infrastructure_failure', 'platform', 'infrastructure_failure', ${t.workspaceIds[0]}::uuid, 'unknown',
      ARRAY(SELECT id FROM tasks WHERE workspace_id = ${t.workspaceIds[0]}::uuid ORDER BY id LIMIT 3),
      now() - interval '1 hour', now()
    ON CONFLICT (team_id, key) DO NOTHING`);
}

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedHealthExtras(team);
  await seedFailureEdgeWorkers(team);
  await seedActiveRootCause(team);
}, 900_000);

/** A request whose protected layout and Health layout already ran. */
async function newHealthRequest(): Promise<void> {
  await page.newRequest(team.userId, async () => {
    await getCurrentUser();
    const [, , scope] = await Promise.all([
      getUserTeamsWithDetails(team.userId), getUserWorkspaceIds(team.userId), resolveActiveTeamScope(team.userId, undefined),
    ]);
    await getChatAvailability(team.userId, scope.teamId);
    await HealthLayout({ children: null });
  });
}

type HealthPage = (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

async function measurePage(name: string, Page: HealthPage) {
  await newHealthRequest();
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const m = await measureLoader(name, async () => {
    rendered = await page.render(() => Page({ searchParams: Promise.resolve({}) }));
  });
  reportBudget(m, PAGE_BUDGETS.health, scale);
  return { m, rendered: rendered!, json: treeText(rendered!.tree) };
}

describe('Failures headline counted in SQL', () => {
  it('equals the full report\'s totals over the same rows', async () => {
    const { getFailureAnalytics, getFailureTotals } = await import('../../src/lib/failure-analytics');
    for (const window of ['24h', '7d', '30d'] as const) {
      const [full, headline] = await Promise.all([
        getFailureAnalytics(team.workspaceIds, window), getFailureTotals(team.workspaceIds, window),
      ]);
      expect(headline).toEqual({
        failed: full.totals.failed, terminal: full.totals.terminal, failureRatePct: full.totals.failureRatePct,
      });
    }
  }, 120_000);
});

describe('Health load budget', () => {
  it('Overview fits R-6: at most 15 queries and 200 KB, no outside call, no write', async () => {
    const { m, rendered, json } = await measurePage('healthOverview', OverviewPage as HealthPage);
    expect(rendered.outside).toEqual([]);
    // It reached the team's data: the failing schedules and this team's runners.
    expect(json).toContain('"lastError":"The last run failed: the check timed out."');
    expect(json).toContain('budget runner 1');
    expect(json).not.toContain('other runner');
    // The top failure cause reached the window's failed workers.
    expect(json).toMatch(/"totalFailedWorkers":[1-9]/);
    // A schedule's template body is not shipped to show its error.
    expect(json).not.toContain('Carried context for every run.');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.health);
  }, 300_000);

  it('Failures fits R-6: at most 15 queries and 200 KB, no outside call, no write', async () => {
    const { m, rendered, json } = await measurePage('healthFailures', FailuresPage as HealthPage);
    expect(rendered.outside).toEqual([]);
    // The headline rate reached the team's failed workers.
    expect(json).toMatch(/"failed":[1-9]/);
    expect(json).toMatch(/"totalFailedWorkers":[1-9]/);
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.health);
  }, 300_000);

  it('Runners fits R-6: at most 15 queries and 200 KB, no outside call, no write', async () => {
    const { m, rendered, json } = await measurePage('healthRunners', RunnersPage as HealthPage);
    expect(rendered.outside).toEqual([]);
    expect(json).toContain('budget runner 1');
    expect(json).not.toContain('other runner');
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.health);
  }, 300_000);
});
