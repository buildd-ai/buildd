/**
 * A task's PR link (apps/web/src/lib/pr-reach-grant.ts), against real Postgres:
 * an agent run filing a task may link only PRs its own task already reaches,
 * and the link is what the PR doors read (`taskScopeTaskLinksPr`), never the
 * task's text.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

const { taskReachesPr, resolvePrReachGrant } = await import('../../src/lib/pr-reach-grant');
const { taskScopeTaskLinksPr } = await import('../../src/lib/task-token-auth');

let teamId: string;
let workspaceId: string;
let missionId: string;
let otherMissionId: string;
let prSeq = 8100;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  missionId = await seedMission(teamId, workspaceId);
  otherMissionId = await seedMission(teamId, workspaceId);
});

async function prOf(taskId: string): Promise<number> {
  const prNumber = prSeq++;
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, 'w', 'test', ${`feat/pr-${prNumber}`}, 'completed', ${prNumber})`);
  return prNumber;
}
const setTask = (id: string, o: { roleSlug?: string; context?: unknown }) => q(sql`
  UPDATE tasks SET role_slug = ${o.roleSlug ?? null}, context = ${o.context ? JSON.stringify(o.context) : null}::jsonb WHERE id = ${id}::uuid`);
const scope = (taskId: string) => ({ taskScope: { taskId, workspaceId, expiresAt: Date.now() + 60_000 } });

describe('taskReachesPr: what an agent run filing a task may link', () => {
  test('its own worker\'s PR, an organizer\'s own-mission PR; never another task\'s or another mission\'s', async () => {
    const builder = await seedTask(workspaceId, { status: 'in_progress', missionId });
    const own = await prOf(builder);
    const sibling = await seedTask(workspaceId, { status: 'completed', missionId });
    const siblingPr = await prOf(sibling);
    const elsewhere = await seedTask(workspaceId, { status: 'completed', missionId: otherMissionId });
    const elsewherePr = await prOf(elsewhere);
    const organizer = await seedTask(workspaceId, { status: 'in_progress', missionId });
    await setTask(organizer, { roleSlug: 'organizer' });

    expect(await taskReachesPr(builder, workspaceId, own)).toBe(true);
    expect(await taskReachesPr(builder, workspaceId, siblingPr)).toBe(false);
    expect(await taskReachesPr(organizer, workspaceId, siblingPr)).toBe(true);
    expect(await taskReachesPr(organizer, workspaceId, elsewherePr)).toBe(false);
    // Another workspace's caller reaches nothing here.
    const { workspaceId: ws2 } = await seedWorkspace();
    expect(await taskReachesPr(builder, ws2, own)).toBe(false);
  });

  test('a child filed by a builder naming another task\'s PR gets no link and the PR doors refuse it', async () => {
    const victim = await seedTask(workspaceId, { status: 'in_progress' });
    const victimPr = await prOf(victim);
    const builder = await seedTask(workspaceId, { status: 'in_progress' });
    const grant = await resolvePrReachGrant(
      { title: `Land #${victimPr}`, description: `merge #${victimPr}`, context: { prNumber: victimPr }, workspaceId },
      { kind: 'task', taskId: builder },
    );
    expect(grant).toBeNull();
    const child = await seedTask(workspaceId, { status: 'in_progress', title: `Land #${victimPr}` });
    await setTask(child, { context: { prNumber: victimPr } });
    expect(await taskScopeTaskLinksPr(scope(child), { workspaceId, prNumber: victimPr })).toBe(false);
  });

  test('a repair task an organizer files for its own mission\'s PR is linked, and the PR doors let it through', async () => {
    const owner = await seedTask(workspaceId, { status: 'completed', missionId });
    const ownerPr = await prOf(owner);
    const organizer = await seedTask(workspaceId, { status: 'in_progress', missionId });
    await setTask(organizer, { roleSlug: 'organizer' });
    const grant = await resolvePrReachGrant(
      { title: `fix: resolve conflicts on #${ownerPr}`, description: null, context: {}, workspaceId },
      { kind: 'task', taskId: organizer },
    );
    expect(grant).toMatchObject({ prNumbers: [ownerPr], grantedBy: `task:${organizer}` });
    const repair = await seedTask(workspaceId, { status: 'in_progress', missionId });
    await setTask(repair, { context: { prReach: grant } });
    expect(await taskScopeTaskLinksPr(scope(repair), { workspaceId, prNumber: ownerPr })).toBe(true);
    // A link is passed on, never widened: the repair task may link that PR again, nothing else.
    expect(await taskReachesPr(repair, workspaceId, ownerPr)).toBe(true);
    expect(await taskReachesPr(repair, workspaceId, ownerPr + 1000)).toBe(false);
  });

  test('a system-filed retry bound to the PR reaches it through its column', async () => {
    const owner = await seedTask(workspaceId, { status: 'completed' });
    const ownerPr = await prOf(owner);
    const retry = await seedTask(workspaceId, { status: 'in_progress', title: 'fix CI' });
    await q(sql`UPDATE tasks SET ci_retry_pr_number = ${ownerPr} WHERE id = ${retry}::uuid`);
    expect(await taskScopeTaskLinksPr(scope(retry), { workspaceId, prNumber: ownerPr })).toBe(true);
  });
});
