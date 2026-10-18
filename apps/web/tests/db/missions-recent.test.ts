/**
 * The missions `buildd top` lists (spec c7410e76 R-24, AC-10), on real
 * Postgres: the read is confined to the workspaces it is given, lists open
 * missions, and lists a completed one only when its latest transition into
 * completed falls inside the 7-day window, dated by that transition. A route
 * test with a mocked findMany cannot see any of this.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

const { loadRecentMissions } = await import('../../src/lib/missions-recent');
const { missionStatusNoteBody, MISSION_COMPLETED_MARKER } = await import('../../src/lib/mission-status-note');
const { claimMissionCompletion } = await import('../../src/lib/workflow/mission-completion-write');

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);

async function mission(teamId: string, workspaceId: string, status: string, completedAt: Date | null): Promise<string> {
  const id = await seedMission(teamId, workspaceId);
  await q(sql`UPDATE missions SET status = ${status}, completed_at = ${completedAt?.toISOString() ?? null}::timestamptz WHERE id = ${id}::uuid`);
  return id;
}

async function statusNote(missionId: string, from: string, to: string, at: Date): Promise<void> {
  await q(sql`
    INSERT INTO mission_notes (mission_id, author_type, type, title, body, created_at)
    VALUES (${missionId}::uuid, 'system', 'update', 'Mission status changed', ${missionStatusNoteBody(from, to)}, ${at.toISOString()}::timestamptz)`);
}

/** A status PATCH's note: authored by a person/MCP, tagged with the server's marker only when it completes. */
async function patchNote(missionId: string, from: string, to: string, at: Date, authorType = 'user', marker: string | null = null): Promise<void> {
  await q(sql`
    INSERT INTO mission_notes (mission_id, author_type, type, title, body, collapse_key, created_at)
    VALUES (${missionId}::uuid, ${authorType}, 'update', 'Mission status changed', ${missionStatusNoteBody(from, to)}, ${marker}, ${at.toISOString()}::timestamptz)`);
}

let ids: Record<string, string>;
let otherTeamMission: string;
let rows: Awaited<ReturnType<typeof loadRecentMissions>>;
const byId = (id: string) => rows.find(r => r.id === id);

beforeAll(async () => {
  assertDbConfigured();
  const a = await seedWorkspace();
  const b = await seedWorkspace();
  ids = {
    open: await mission(a.teamId, a.workspaceId, 'active', null),
    paused: await mission(a.teamId, a.workspaceId, 'paused', null),
    doneRecent: await mission(a.teamId, a.workspaceId, 'completed', ago(2)),
    doneOld: await mission(a.teamId, a.workspaceId, 'completed', ago(9)),
    archived: await mission(a.teamId, a.workspaceId, 'archived', ago(1)),
    noStamp: await mission(a.teamId, a.workspaceId, 'completed', null),
    // Completed long ago, reopened, completed again by a status PATCH: the stamp keeps the first date.
    reCompleted: await mission(a.teamId, a.workspaceId, 'completed', ago(20)),
    // Completed, then reopened: open again, the old stamp left behind.
    reopened: await mission(a.teamId, a.workspaceId, 'active', ago(1)),
  };
  await statusNote(ids.reCompleted, 'completed', 'active', ago(5));
  await statusNote(ids.reCompleted, 'active', 'completed', ago(1));
  await statusNote(ids.reopened, 'active', 'completed', ago(3));
  await statusNote(ids.reopened, 'completed', 'active', ago(1));
  // A recent "→ active" note must not make an old completion read as recent.
  await statusNote(ids.doneOld, 'paused', 'active', ago(1));
  ids.patchReCompleted = await mission(a.teamId, a.workspaceId, 'completed', ago(20));
  await patchNote(ids.patchReCompleted, 'active', 'completed', ago(1), 'user', MISSION_COMPLETED_MARKER);
  // A posted note can carry the right words under a user/mcp author, but never the marker.
  ids.forged = await mission(a.teamId, a.workspaceId, 'completed', ago(20));
  await patchNote(ids.forged, 'active', 'completed', ago(1), 'mcp');
  otherTeamMission = await mission(b.teamId, b.workspaceId, 'active', null);
  rows = await loadRecentMissions([a.workspaceId], NOW);
});

describe('loadRecentMissions on real Postgres', () => {
  test('only the given workspaces: another team\'s open mission is not read', () => {
    expect(byId(otherTeamMission)).toBeUndefined();
    expect(rows.every(r => Object.values(ids).includes(r.id))).toBe(true);
  });

  test('open missions are listed, with no delivered time', () => {
    expect(byId(ids.open)).toMatchObject({ status: 'active', completedAt: null });
    expect(byId(ids.paused)).toMatchObject({ status: 'paused', completedAt: null });
  });

  test('a reopened mission is listed as open, not as delivered (AC-10)', () => {
    expect(byId(ids.reopened)).toMatchObject({ status: 'active', completedAt: null });
  });

  test('a mission completed inside the window carries its completion day', () => {
    expect(byId(ids.doneRecent)!.completedAt).toBe(ago(2).toISOString());
  });

  test('re-completed after a reopen: dated by the latest completion, not the first stamp', () => {
    expect(byId(ids.reCompleted)!.completedAt).toBe(ago(1).toISOString());
  });

  test('completed before the window, archived, or never stamped: not listed', () => {
    expect(byId(ids.doneOld)).toBeUndefined();
    expect(byId(ids.archived)).toBeUndefined();
    expect(byId(ids.noStamp)).toBeUndefined();
  });

  test('re-completed by a person\'s PATCH: dated by the marked note (gap: stamp keeps the first date)', () => {
    expect(byId(ids.patchReCompleted)!.completedAt).toBe(ago(1).toISOString());
  });

  test('a user/mcp note with the status words but no marker does not move the date', () => {
    expect(byId(ids.forged)).toBeUndefined();
  });
});

describe('automated re-completion after a reopen', () => {
  async function reopenedMission(): Promise<{ id: string; workspaceId: string }> {
    const w = await seedWorkspace();
    const id = await mission(w.teamId, w.workspaceId, 'active', ago(20));
    return { id, workspaceId: w.workspaceId };
  }
  const completedAt = async (id: string) =>
    new Date((await q<{ c: string }>(sql`SELECT completed_at AS c FROM missions WHERE id = ${id}::uuid`))[0].c).toISOString();

  test('no task finished since the first completion: the delivered date does not move', async () => {
    const m = await reopenedMission();
    await seedTask(m.workspaceId, { status: 'cancelled', missionId: m.id });
    expect(await claimMissionCompletion(m.id, null, new Date(NOW))).toMatchObject({ id: m.id });
    expect(await completedAt(m.id)).toBe(ago(20).toISOString());
    expect((await loadRecentMissions([m.workspaceId], NOW)).find(r => r.id === m.id)).toBeUndefined();
  });

  test('a task finished since: the completion date moves', async () => {
    const m = await reopenedMission();
    await seedTask(m.workspaceId, { status: 'completed', missionId: m.id });
    expect(await claimMissionCompletion(m.id, null, new Date(NOW))).toMatchObject({ id: m.id });
    expect(await completedAt(m.id)).toBe(new Date(NOW).toISOString());
  });

  test('a first completion is stamped', async () => {
    const w = await seedWorkspace();
    const id = await mission(w.teamId, w.workspaceId, 'active', null);
    await claimMissionCompletion(id, null, new Date(NOW));
    expect(await completedAt(id)).toBe(new Date(NOW).toISOString());
  });
});

describe('the delivered read (spec 3ef37387 R-10)', () => {
  test('scans the completion notes once, grouped, not once per row and twice per statement', async () => {
    const { deliveredMissionsQuery } = await import('../../src/lib/missions-recent');
    const rendered = deliveredMissionsQuery([crypto.randomUUID()], ago(7)).toSQL().sql;
    expect(rendered.match(/from "mission_notes"/gi)?.length).toBe(1);
    expect(rendered.match(/ like /gi)?.length).toBe(1);
    expect(rendered).toMatch(/group by/i);
    // Recent deliveries are capped; open missions never are (the open read has no limit).
    expect(deliveredMissionsQuery([crypto.randomUUID()], ago(7)).toSQL().params).toContain(300);
  });
});
