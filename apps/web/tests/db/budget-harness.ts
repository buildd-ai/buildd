/**
 * Page-load budget harness (Living Spec "Fast at any size", R-30).
 *
 * Seeds one synthetic team at ten times a large team's size into the real
 * test database, then measures a loader: how many round trips it makes to
 * Neon and how many bytes Neon sends back (`recordNeonQueries`, the same
 * fetch hook that labels production spans, packages/core/db/query-label.ts).
 * A test compares that with the page's budget from the spec.
 *
 * Scale: AC-1's team by default (500 missions, 20,000 tasks, 40,000 workers).
 * Override with BUDGET_SEED_MISSIONS / _TASKS / _WORKERS, or shrink all three
 * with BUDGET_SEED_SCALE=0.1 for a quick local look. A budget verdict only
 * means something at the default scale; the report says which scale ran.
 *
 * The seed is synthetic: invented titles and shapes sized like real rows
 * (long task context and result, worker milestones and tool-call logs), and
 * status mixes chosen so most history is finished and a little is live. It
 * describes no real team. A team seeded at the same scale is reused, so a
 * second run in the same database skips the seed.
 */
import { sql } from 'drizzle-orm';
import { expect } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { recordNeonQueries, withLoaderLabel } from '@buildd/core/db';
import { q } from './harness';

/** Per-page budgets: the spec's table, R-1..R-8 (queries, database data). */
export const PAGE_BUDGETS = {
  home: { queries: 15, bytes: 200 * 1024 },
  missionsList: { queries: 10, bytes: 200 * 1024 },
  missionPage: { queries: 20, bytes: 300 * 1024 },
  activity: { queries: 10, bytes: 200 * 1024 },
  taskPage: { queries: 15, bytes: 150 * 1024 },
  health: { queries: 15, bytes: 200 * 1024 },
  specs: { queries: 15, bytes: 200 * 1024 },
  other: { queries: 25, bytes: 300 * 1024 },
} as const;

export type Budget = { queries: number; bytes: number };

export interface SeedScale {
  missions: number;
  tasks: number;
  workers: number;
}

export function seedScale(env: Record<string, string | undefined> = process.env): SeedScale {
  const factor = Number(env.BUDGET_SEED_SCALE ?? 1);
  const n = (key: string, base: number) => Math.max(1, Math.round(Number(env[key] ?? base) * factor));
  return {
    missions: n('BUDGET_SEED_MISSIONS', 500),
    tasks: n('BUDGET_SEED_TASKS', 20_000),
    workers: n('BUDGET_SEED_WORKERS', 40_000),
  };
}

export interface SeededTeam {
  teamId: string;
  userId: string;
  workspaceIds: string[];
  scale: SeedScale;
  reused: boolean;
}

const WORKSPACES = 3;

// drizzle renders a JS array in sql`` as a row; send a Postgres array literal.
const pgArray = (ids: string[]) => `{${ids.join(',')}}`;

/**
 * The synthetic team at `scale`: an owner, three workspaces and the history.
 * Rows are generated in Postgres (generate_series), so a full seed is a
 * handful of statements, not 60,000 round trips.
 */
export async function seedLargeTeam(scale: SeedScale = seedScale()): Promise<SeededTeam> {
  const slug = `budget-${scale.missions}-${scale.tasks}-${scale.workers}`;
  const [existing] = await q<{ id: string; user_id: string }>(sql`
    SELECT t.id, m.user_id FROM teams t JOIN team_members m ON m.team_id = t.id AND m.role = 'owner'
    WHERE t.slug = ${slug} LIMIT 1`);
  if (existing) {
    const ws = await q<{ id: string }>(sql`SELECT id FROM workspaces WHERE team_id = ${existing.id}::uuid ORDER BY name`);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workers WHERE workspace_id = ANY(${pgArray(ws.map(w => w.id))}::uuid[])`);
    if (n === scale.workers) {
      return { teamId: existing.id, userId: existing.user_id, workspaceIds: ws.map(w => w.id), scale, reused: true };
    }
    // A half-finished seed: start over under the same slug.
    await q(sql`DELETE FROM teams WHERE id = ${existing.id}::uuid`);
  }

  const [team] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES ('Budget fixture team', ${slug}) RETURNING id`);
  const [user] = await q<{ id: string }>(sql`
    INSERT INTO users (email, name) VALUES (${`${slug}-${Date.now().toString(36)}@example.test`}, 'Budget Owner') RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${team.id}::uuid, ${user.id}::uuid, 'owner')`);
  const ws = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id)
    SELECT 'budget-ws-' || g, ${team.id}::uuid FROM generate_series(1, ${WORKSPACES}) g
    RETURNING id`);
  const wsIds = ws.map(w => w.id);

  // Missions: mostly finished history, a quarter active. ~1.5 KB description,
  // a handful of goal criteria.
  await q(sql`
    INSERT INTO missions (team_id, workspace_id, title, description, status, goal_criteria, created_at, updated_at, completed_at)
    SELECT ${team.id}::uuid, (${pgArray(wsIds)}::uuid[])[1 + g % ${WORKSPACES}],
      'Mission ' || g || ': improve the ' || (ARRAY['claim path','release flow','runner view','spec page','health page'])[1 + g % 5],
      repeat('Context for the mission: what is being built, why, and how it will be judged. ', 20),
      CASE WHEN g % 20 < 12 THEN 'completed' WHEN g % 20 < 17 THEN 'active' WHEN g % 20 < 19 THEN 'archived' ELSE 'paused' END,
      (SELECT jsonb_agg(jsonb_build_object('id', 'gc-' || i, 'text', repeat('The outcome holds on the integrated branch. ', 4), 'required', true))
         FROM generate_series(1, 5) i),
      now() - (g % 180) * interval '1 day', now() - (g % 30) * interval '1 hour',
      CASE WHEN g % 20 < 12 THEN now() - (g % 180) * interval '1 day' + interval '3 days' END
    FROM generate_series(1, ${scale.missions}) g`);

  // Tasks: nine in ten belong to a mission. ~2 KB description, ~3 KB context,
  // ~1.5 KB result on finished ones. Statuses: mostly completed, a few failed
  // or cancelled, about one in two hundred live.
  await q(sql`
    WITH m AS (SELECT array_agg(id ORDER BY created_at, id) AS ids FROM missions WHERE team_id = ${team.id}::uuid)
    INSERT INTO tasks (workspace_id, mission_id, title, description, context, result, status, role_slug, created_at, updated_at)
    SELECT (${pgArray(wsIds)}::uuid[])[1 + g % ${WORKSPACES}],
      CASE WHEN g % 10 = 0 THEN NULL ELSE m.ids[1 + g % array_length(m.ids, 1)] END,
      'Task ' || g || ': ' || (ARRAY['add the endpoint','fix the flaky test','wire the loader','write the migration','review the PR'])[1 + g % 5],
      repeat('Steps, constraints and acceptance for this unit of work. ', 36),
      jsonb_build_object(
        'specSource', jsonb_build_object('specId', gen_random_uuid(), 'criteria', jsonb_build_array('R-1', 'R-2')),
        'notes', repeat('Earlier attempt notes and reviewer feedback carried forward. ', 40),
        'pathManifest', (SELECT jsonb_agg('apps/web/src/lib/file-' || i || '.ts') FROM generate_series(1, 12) i)),
      CASE WHEN st.s IN ('completed', 'failed') THEN jsonb_build_object(
        'summary', repeat('What was delivered and how it was verified. ', 30), 'prNumber', 1000 + g) END,
      st.s,
      (ARRAY['builder','builder','researcher','organizer'])[1 + g % 4],
      now() - (g % 180) * interval '1 day' - (g % 24) * interval '1 hour',
      now() - (g % 180) * interval '1 day'
    FROM generate_series(1, ${scale.tasks}) g, m,
      LATERAL (SELECT CASE
        WHEN g % 200 = 0 THEN 'in_progress' WHEN g % 200 = 1 THEN 'pending' WHEN g % 200 = 2 THEN 'review'
        WHEN g % 100 < 7 THEN 'failed' WHEN g % 100 < 10 THEN 'cancelled' ELSE 'completed' END AS s) st`);

  // Workers: spread over the tasks (two each at the default ratio). A live
  // task's newest worker is running; the rest finished. ~4 KB milestones,
  // ~1.5 KB tool-call log, ~1 KB result meta; half carry a PR.
  await q(sql`
    WITH t AS (
      SELECT id, workspace_id, status, created_at, row_number() OVER (ORDER BY created_at, id) - 1 AS rn
      FROM tasks WHERE workspace_id = ANY(${pgArray(wsIds)}::uuid[])
    ), n AS (SELECT count(*) AS c FROM t)
    INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, milestones, mcp_calls, result_meta,
      instruction_history, error, pr_url, pr_number, merged_at, pr_lifecycle_status, started_at, completed_at, created_at, updated_at)
    SELECT t.id, t.workspace_id, 'worker-' || g, 'runner-' || (g % 7), 'buildd/' || g || '-task',
      CASE WHEN t.status = 'in_progress' AND g >= ${scale.workers} - n.c THEN 'running'
           WHEN t.status = 'failed' THEN 'error' ELSE 'completed' END,
      (SELECT jsonb_agg(jsonb_build_object('label', 'Step ' || i || ': ' || repeat('progress note ', 8), 'at', now()))
         FROM generate_series(1, 25) i),
      (SELECT jsonb_agg(jsonb_build_object('tool', 'buildd_work', 'action', 'update_progress', 'ms', i * 10)) FROM generate_series(1, 30) i),
      jsonb_build_object('model', 'synthetic-model', 'stopReason', 'end_turn', 'notes', repeat('Session summary line. ', 40)),
      jsonb_build_array(jsonb_build_object('message', repeat('Please also cover the edge case. ', 10), 'at', now())),
      CASE WHEN t.status = 'failed' THEN repeat('Error: the check failed on the PR head. ', 10) END,
      CASE WHEN g % 2 = 0 THEN 'https://github.com/example/fixture/pull/' || (1000 + g) END,
      CASE WHEN g % 2 = 0 THEN 1000 + g END,
      CASE WHEN g % 4 = 0 AND t.status = 'completed' THEN t.created_at + interval '2 hours' END,
      CASE WHEN g % 2 = 0 THEN (CASE WHEN g % 4 = 0 AND t.status = 'completed' THEN 'merged' ELSE 'closed' END) END,
      t.created_at, CASE WHEN t.status = 'in_progress' THEN NULL ELSE t.created_at + interval '1 hour' END,
      t.created_at, t.created_at + interval '1 hour'
    FROM generate_series(0, ${scale.workers} - 1) g
    CROSS JOIN n
    JOIN t ON t.rn = g % n.c`);

  for (const table of ['missions', 'tasks', 'workers']) await q(sql.raw(`ANALYZE ${table}`));
  return { teamId: team.id, userId: user.id, workspaceIds: wsIds, scale, reused: false };
}

export interface LoaderMeasurement {
  name: string;
  count: number;
  statements: number;
  bytes: number;
  byLabel: Record<string, { count: number; bytes: number }>;
  byTable: Record<string, { count: number; bytes: number }>;
}

/** Run `fn` labelled `name` and measure every Neon round trip it makes. */
export async function measureLoader(name: string, fn: () => Promise<unknown>): Promise<LoaderMeasurement> {
  const rec = await recordNeonQueries(() => withLoaderLabel(name, fn));
  const byTable: LoaderMeasurement['byTable'] = {};
  for (const query of rec.queries) {
    const b = (byTable[query.table ?? `(${query.operation})`] ??= { count: 0, bytes: 0 });
    b.count += 1;
    b.bytes += query.bytes;
  }
  return { name, count: rec.count, statements: rec.statements, bytes: rec.bytes, byLabel: rec.byLabel, byTable };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/**
 * Print the measurement (and append it to the CI step summary). Written to
 * stdout directly: tests/setup.ts silences console inside a test.
 */
export function reportBudget(m: LoaderMeasurement, budget: Budget, scale: SeedScale): string {
  const top = Object.entries(m.byTable).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
    .map(([t, v]) => `    ${t}: ${v.count} quer${v.count === 1 ? 'y' : 'ies'}, ${kb(v.bytes)}`).join('\n');
  const text = [
    `[budget] ${m.name} at ${scale.missions} missions / ${scale.tasks} tasks / ${scale.workers} workers:`,
    `  queries ${m.count} (budget ${budget.queries}), statements ${m.statements}, data ${kb(m.bytes)} (budget ${kb(budget.bytes)})`,
    `  heaviest tables:`,
    top,
  ].join('\n');
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${text}\n\`\`\`\n`); } catch { /* summary is best effort */ }
  }
  return text;
}

export function overBudget(m: LoaderMeasurement, budget: Budget): string[] {
  const over: string[] = [];
  if (m.count > budget.queries) over.push(`${m.count} queries > ${budget.queries}`);
  if (m.bytes > budget.bytes) over.push(`${kb(m.bytes)} > ${kb(budget.bytes)}`);
  return over;
}

/**
 * Assert a loader fits its budget. `knownOver: true` marks a page that does
 * not fit yet: the test then records the numbers and passes while the page is
 * over, and FAILS once it fits, so the slice that fixes the page has to flip
 * it to enforcing (drop `knownOver`) in the same change.
 */
export function expectWithinBudget(m: LoaderMeasurement, budget: Budget, opts: { knownOver?: boolean } = {}): void {
  const over = overBudget(m, budget);
  if (opts.knownOver) {
    expect(over.length, `${m.name} now fits its budget: remove knownOver so the budget is enforced`).toBeGreaterThan(0);
    return;
  }
  expect(over, `${m.name} is over its budget`).toEqual([]);
}
