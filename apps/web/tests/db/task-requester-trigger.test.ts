/**
 * Who a task is for (migration *_task_requester_trigger), against real
 * Postgres: every insert records a person by the walk in core/task-requester.ts
 * or records that there is none, and the one-time backfill fills in historical
 * rows by the same walk, only for a current team member, idempotently.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { tasks, workers } = await import('@buildd/core/db/schema');
const { resolveTaskRequesterUserId } = await import('@buildd/core/task-requester');
const { fetchOccupancyRows } = await import('../../src/lib/fleet-occupancy-query');
const { buildOccupancySeries } = await import('../../src/lib/fleet-occupancy');

const DRIZZLE = join(import.meta.dir, '../../../../packages/core/drizzle');
const folder = readdirSync(DRIZZLE).find((d) => d.endsWith('_task_requester_trigger'))!;
const statements = readFileSync(join(DRIZZLE, folder, 'migration.sql'), 'utf8').split('--> statement-breakpoint');
/** The backfill UPDATE: the migration's last statement. */
const BACKFILL = statements[statements.length - 1];
const runBackfill = () => db.execute(sql.raw(BACKFILL));

let teamId: string;
let workspaceId: string;
let member: string;
let outsider: string;

async function seedUser(team: string | null): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  if (team) await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${team}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

async function insertTask(v: Partial<typeof tasks.$inferInsert> = {}) {
  const [t] = await db.insert(tasks).values({ workspaceId, title: `t-${crypto.randomUUID()}`, ...v }).returning();
  return t;
}

async function missionBy(userId: string | null): Promise<string> {
  const id = await seedMission(teamId, workspaceId);
  await q(sql`UPDATE missions SET created_by_user_id = ${userId}::uuid WHERE id = ${id}::uuid`);
  return id;
}

async function scheduleBy(userId: string): Promise<string> {
  const [s] = await q<{ id: string }>(sql`
    INSERT INTO task_schedules (workspace_id, name, cron_expression, task_template, created_by_user_id)
    VALUES (${workspaceId}::uuid, 's', '0 * * * *', '{"title":"x"}'::jsonb, ${userId}::uuid) RETURNING id`);
  return s.id;
}

/** Make a row look written before the trigger existed. Touches no column the trigger watches. */
async function makeHistorical(id: string) {
  await q(sql`UPDATE tasks SET created_by_user_id = NULL, requester_source = NULL WHERE id = ${id}::uuid`);
}

const row = async (id: string) =>
  (await db.select({ u: tasks.createdByUserId, s: tasks.requesterSource }).from(tasks).where(eq(tasks.id, id)))[0];

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  member = await seedUser(teamId);
  outsider = await seedUser(null);
});

describe('every insert records who the task is for', () => {
  test('a writer that names a person is explicit, even when a mission says otherwise', async () => {
    const t = await insertTask({ createdByUserId: member, missionId: await missionBy(outsider) });
    expect(await row(t.id)).toEqual({ u: member, s: 'explicit' });
  });

  test('a retry of a retry inherits the person from the first ancestor that has one', async () => {
    const root = await insertTask({ createdByUserId: member });
    const retry = await insertTask({ parentTaskId: root.id });
    const again = await insertTask({ parentTaskId: retry.id });
    expect(await row(retry.id)).toEqual({ u: member, s: 'parent' });
    expect(await row(again.id)).toEqual({ u: member, s: 'parent' });
  });

  test('mission and schedule work belongs to their creator', async () => {
    const m = await insertTask({ missionId: await missionBy(member) });
    const s = await insertTask({ scheduleId: await scheduleBy(member) });
    expect(await row(m.id)).toEqual({ u: member, s: 'mission' });
    expect(await row(s.id)).toEqual({ u: member, s: 'schedule' });
  });

  test('work with no person on its chain stays unattributed, and says so', async () => {
    const t = await insertTask({ missionId: await missionBy(null) });
    expect(await row(t.id)).toEqual({ u: null, s: 'none' });
  });

  test('linking a task to a mission later fills a missing person in, never replaces one', async () => {
    const orphan = await insertTask();
    const owned = await insertTask({ createdByUserId: outsider });
    const mission = await missionBy(member);
    await db.update(tasks).set({ missionId: mission }).where(eq(tasks.id, orphan.id));
    await db.update(tasks).set({ missionId: mission }).where(eq(tasks.id, owned.id));
    expect(await row(orphan.id)).toEqual({ u: member, s: 'mission' });
    expect(await row(owned.id)).toEqual({ u: outsider, s: 'explicit' });
  });

  test('a runner claiming the task does not change who it is for', async () => {
    const t = await insertTask({ missionId: await missionBy(member) });
    await db.update(tasks).set({ status: 'assigned', claimedAt: new Date() }).where(eq(tasks.id, t.id));
    expect(await row(t.id)).toEqual({ u: member, s: 'mission' });
  });

  test('the stored person matches claim-time resolution', async () => {
    const root = await insertTask({ missionId: await missionBy(member) });
    const child = await insertTask({ parentTaskId: root.id });
    const [c] = await db.select().from(tasks).where(eq(tasks.id, child.id));
    expect(c.createdByUserId).toBe(await resolveTaskRequesterUserId({ parentTaskId: c.parentTaskId, missionId: c.missionId, scheduleId: c.scheduleId }));
  });
});

describe('one-time backfill', () => {
  test('fills historical rows by the walk, skips non-members and personless work, and is idempotent', async () => {
    const root = await insertTask({ createdByUserId: member });
    const retry = await insertTask({ parentTaskId: root.id });
    const viaMission = await insertTask({ missionId: await missionBy(member) });
    const viaSchedule = await insertTask({ scheduleId: await scheduleBy(member) });
    const webhook = await insertTask();
    const notMember = await insertTask({ missionId: await missionBy(outsider) });
    for (const t of [retry, viaMission, viaSchedule, webhook, notMember]) await makeHistorical(t.id);

    await runBackfill();
    const first = {
      root: await row(root.id), retry: await row(retry.id), viaMission: await row(viaMission.id),
      viaSchedule: await row(viaSchedule.id), webhook: await row(webhook.id), notMember: await row(notMember.id),
    };
    expect(first).toEqual({
      root: { u: member, s: 'explicit' },
      retry: { u: member, s: 'backfill_parent' },
      viaMission: { u: member, s: 'backfill_mission' },
      viaSchedule: { u: member, s: 'backfill_schedule' },
      webhook: { u: null, s: 'backfill_none' },
      notMember: { u: null, s: 'backfill_not_member' },
    });

    await runBackfill();
    const second = {
      root: await row(root.id), retry: await row(retry.id), viaMission: await row(viaMission.id),
      viaSchedule: await row(viaSchedule.id), webhook: await row(webhook.id), notMember: await row(notMember.id),
    };
    expect(second).toEqual(first);
  });

  test('never overwrites a historical row that already names a person, even one the walk disagrees with', async () => {
    const t = await insertTask({ missionId: await missionBy(member) });
    // Written before the trigger by a writer that named someone else; how is not recorded.
    await q(sql`UPDATE tasks SET created_by_user_id = ${outsider}::uuid, requester_source = NULL WHERE id = ${t.id}::uuid`);
    await runBackfill();
    expect(await row(t.id)).toEqual({ u: outsider, s: null });
    await runBackfill();
    expect(await row(t.id)).toEqual({ u: outsider, s: null });
  });

  test('an unknown row stays unknown when its chain later gains a member', async () => {
    const mission = await missionBy(null);
    const t = await insertTask({ missionId: mission });
    await makeHistorical(t.id);
    await runBackfill();
    expect(await row(t.id)).toEqual({ u: null, s: 'backfill_none' });
    // The mission gaining a creator afterwards does not make a second run guess.
    await q(sql`UPDATE missions SET created_by_user_id = ${member}::uuid WHERE id = ${mission}::uuid`);
    await runBackfill();
    expect(await row(t.id)).toEqual({ u: null, s: 'backfill_none' });
  });
});

describe('Health attribution reads the stored person', () => {
  test('a mission retry on a runner counts as its owner, not unattributed', async () => {
    const mission = await missionBy(member);
    const retry = await insertTask({ missionId: mission });
    const started = new Date(Date.now() - 30 * 60_000);
    await db.insert(workers).values({
      taskId: retry.id, workspaceId, name: 'w', runner: 'runner', branch: 'b', status: 'running', startedAt: started,
    });
    const now = Date.now();
    const rows = await fetchOccupancyRows([workspaceId], new Date(now - 24 * 3600_000), new Date(now));
    const series = buildOccupancySeries({ window: '24h', now, workers: rows, viewerId: member });
    expect(series.summary.coverage.ownerMissing).toBe(0);
    expect(series.summary.runnerBy.mine.peak).toBeGreaterThanOrEqual(1);
  });
});
