/**
 * The missions `buildd top` lists (spec c7410e76 R-24, AC-10), on real
 * Postgres: the read is confined to the workspaces it is given, lists open
 * missions, and lists a completed one only when its latest transition into
 * completed falls inside the 7-day window, dated by that transition. A route
 * test with a mocked findMany cannot see any of this.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

const { loadRecentMissions } = await import('../../src/lib/missions-recent');
const { missionStatusNoteBody } = await import('../../src/lib/mission-status-note');

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
});
