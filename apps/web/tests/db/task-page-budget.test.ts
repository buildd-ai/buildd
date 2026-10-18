/**
 * The task page's load against its budget (Living Spec "Fast at any size":
 * R-5, R-11, R-14, R-15, R-30) on a real database.
 *
 * R-5: a mission task of a team at ten times a large team's size, with a
 * merged PR, several attempts, long artifacts and error traces, renders in at
 * most 15 queries and 150 KB before the page responds, calls no outside
 * service (GitHub included: PR details are what is stored) and writes nothing.
 *
 * Artifact bodies are not read while rendering: the page lists artifacts and
 * a body loads when one is opened.
 *
 * Measured: the page's own server load (TaskDetailPage), signed in as the
 * team's owner, in a request whose layout already ran (page-render.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';
import {
  PAGE_BUDGETS, expectWithinBudget, measureLoader, reportBudget,
  seedLargeTeam, seedMissionSummaries, seedScale, type SeededTeam,
} from './budget-harness';
import { installPageRenderMocks, isWrite, treeText } from './page-render';

assertDbConfigured();

const page = await installPageRenderMocks();
const { default: TaskDetailPage } = await import('../../src/app/app/(protected)/tasks/[id]/page');
const { getCurrentUser } = await import('../../src/lib/auth-helpers');
const { resolveActiveTeamScope, getUserWorkspaceIds, getUserTeamsWithDetails } = await import('../../src/lib/team-access');
const { getChatAvailability } = await import('../../src/lib/chat-availability');

/** What the protected layout reads for every page; React cache()d per request. */
async function layoutReads(userId: string) {
  await getCurrentUser();
  const [, , scope] = await Promise.all([
    getUserTeamsWithDetails(userId), getUserWorkspaceIds(userId), resolveActiveTeamScope(userId, undefined),
  ]);
  if (scope.teamId) await getChatAvailability(userId, scope.teamId);
}

async function renderTask(userId: string, taskId: string) {
  await page.newRequest(userId, () => layoutReads(userId));
  let rendered: Awaited<ReturnType<typeof page.render>> | null = null;
  const m = await measureLoader(`taskPage.${taskId.slice(0, 8)}`, async () => {
    rendered = await page.render(() => TaskDetailPage({ params: Promise.resolve({ id: taskId }), searchParams: Promise.resolve({}) }));
  });
  return { m, rendered: rendered! };
}

const ARTIFACT_BODY = 'A long report body that the page must not send until it is opened. ';

let team: SeededTeam;
let taskId: string;
const scale = seedScale();

beforeAll(async () => {
  team = await seedLargeTeam(scale);
  await seedMissionSummaries(team);
  // A completed task of the busiest open mission, with a PR worker. Give it
  // what a busy task carries: CI-retry and review attempts with workers,
  // artifacts with long bodies, error traces. Synthetic.
  const [row] = await q<{ id: string; workspace_id: string; pr_number: number }>(sql`
    SELECT t.id, t.workspace_id, w.pr_number FROM tasks t
    JOIN missions m ON m.id = t.mission_id AND m.status = 'active'
    JOIN workers w ON w.task_id = t.id AND w.pr_number IS NOT NULL
    WHERE m.team_id = ${team.teamId}::uuid AND t.status = 'completed' AND t.parent_task_id IS NULL
    ORDER BY (SELECT count(*) FROM tasks x WHERE x.mission_id = m.id) DESC, t.id LIMIT 1`);
  taskId = row.id;
  // Added here and removed in afterAll: the shared seed is reused only while
  // its worker count is exactly the seeded one (budget-harness.ts).
  await removeFixture();
  {
    await q(sql`
      INSERT INTO tasks (workspace_id, mission_id, parent_task_id, title, description, context, result, status, task_class, ci_retry_pr_number, ci_retry_head_sha, created_at, updated_at)
      SELECT t.workspace_id, t.mission_id, t.id,
        CASE WHEN g % 2 = 0 THEN '[builder · after CI #' || g || '] fix' ELSE '[reviewer #' || g || '] review' END,
        repeat('Attempt brief. ', 60), jsonb_build_object('headSha', 'abc' || g, 'notes', repeat('carried forward ', 100)),
        jsonb_build_object('summary', repeat('What the attempt did. ', 40), 'effectiveVerdict', 'approve'),
        'completed', 'attempt', CASE WHEN g % 2 = 0 THEN ${row.pr_number}::int END, CASE WHEN g % 2 = 0 THEN 'sha' || g END,
        t.created_at + g * interval '10 minutes', t.created_at + g * interval '10 minutes'
      FROM tasks t, generate_series(1, 6) g WHERE t.id = ${taskId}::uuid`);
    await q(sql`
      INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, milestones, mcp_calls, result_meta, started_at, completed_at, last_commit_sha)
      SELECT a.id, a.workspace_id, 'attempt-worker', 'runner-1', 'buildd/attempt', 'completed',
        (SELECT jsonb_agg(jsonb_build_object('label', 'Step ' || i || ': ' || repeat('progress note ', 8), 'at', now())) FROM generate_series(1, 25) i),
        (SELECT jsonb_agg(jsonb_build_object('tool', 'buildd_work', 'action', 'update_progress', 'ms', i * 10)) FROM generate_series(1, 30) i),
        jsonb_build_object('notes', repeat('Session summary line. ', 40)),
        a.created_at, a.created_at + interval '5 minutes', 'sha' || a.id
      FROM tasks a WHERE a.parent_task_id = ${taskId}::uuid`);
    await q(sql`
      INSERT INTO artifacts (worker_id, workspace_id, type, title, content)
      SELECT w.id, w.workspace_id, (ARRAY['summary','report','analysis'])[1 + g % 3], 'Artifact ' || g, repeat(${ARTIFACT_BODY}, 300)
      FROM workers w, generate_series(1, 4) g WHERE w.task_id = ${taskId}::uuid`);
    // Excerpts at the scanner's own cap (~500 chars, enforced at write).
    await q(sql`
      INSERT INTO worker_error_traces (worker_id, task_id, pattern, excerpt, ts)
      SELECT w.id, ${taskId}::uuid, 'tool_error', left(repeat('Error output from a tool call. ', 20), 500), now() - g * interval '1 minute'
      FROM workers w, generate_series(1, 10) g WHERE w.task_id = ${taskId}::uuid`);
  }
}, 900_000);

/** What this file adds to the seeded task: its attempts and their workers, artifacts and error traces. */
async function removeFixture() {
  if (!taskId) return;
  const family = sql`(SELECT id FROM workers WHERE task_id = ${taskId}::uuid OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ${taskId}::uuid))`;
  await q(sql`DELETE FROM artifacts WHERE worker_id IN ${family}`);
  await q(sql`DELETE FROM worker_error_traces WHERE task_id = ${taskId}::uuid`);
  // A task's delete only nulls its workers' task_id: delete the attempts' workers first.
  await q(sql`DELETE FROM workers WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id = ${taskId}::uuid)`);
  await q(sql`DELETE FROM tasks WHERE parent_task_id = ${taskId}::uuid`);
}

afterAll(removeFixture, 300_000);

describe('Task page load budget', () => {
  it('fits R-5 at AC-1 scale: at most 15 queries and 150 KB, no outside call, no write', async () => {
    const { m, rendered } = await renderTask(team.userId, taskId);
    reportBudget(m, PAGE_BUDGETS.taskPage, scale);
    expect(rendered.outside).toEqual([]);
    expect(m.count).toBeGreaterThan(0);
    const json = treeText(rendered.tree);
    // It reached the task: its title is on the page.
    expect(json).toContain('Task ');
    // Artifact bodies are loaded on open: the page sends a card's preview, never the body.
    expect(json).toContain(ARTIFACT_BODY.trim());
    expect(json).not.toContain(ARTIFACT_BODY.repeat(12));
    expect(Object.keys(m.byOperation).filter(isWrite)).toEqual([]);
    expectWithinBudget(m, PAGE_BUDGETS.taskPage);
  }, 300_000);
});
