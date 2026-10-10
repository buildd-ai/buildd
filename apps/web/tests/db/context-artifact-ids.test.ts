/**
 * Mission and initiative `contextArtifactIds` (apps/web/src/lib/context-artifact-ids.ts),
 * against real Postgres: an id is accepted only for an artifact the caller can
 * read in a workspace of the owning team, and the planning-context read drops
 * any stored id outside that team, so a row written before the check existed is
 * never rendered into another team's prompt.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { checkContextArtifactIds, contextArtifactsWhere } = await import('../../src/lib/context-artifact-ids');
const { db } = await import('@buildd/core/db');

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedArtifact(workspaceId: string | null): Promise<string> {
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO artifacts (workspace_id, type, title, content)
    VALUES (${workspaceId}::uuid, 'content', ${`a-${rand()}`}, 'body') RETURNING id`);
  return a.id;
}

async function seedMember(teamId: string): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

let teamA: string;
let wsA: string;
let wsARestricted: string;
let teamB: string;
let wsB: string;
let userA: string;
let ownArtifact: string;
let restrictedArtifact: string;
let foreignArtifact: string;
let orphanArtifact: string;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, access_mode) VALUES (${`w-${rand()}`}, ${teamA}::uuid, 'restricted') RETURNING id`);
  wsARestricted = r.id;
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  userA = await seedMember(teamA);
  ownArtifact = await seedArtifact(wsA);
  restrictedArtifact = await seedArtifact(wsARestricted);
  foreignArtifact = await seedArtifact(wsB);
  orphanArtifact = await seedArtifact(null);
});

describe('checkContextArtifactIds', () => {
  test('accepts the caller\'s own team artifact and dedupes', async () => {
    const r = await checkContextArtifactIds([ownArtifact, ownArtifact], { userId: userA }, teamA);
    expect(r).toEqual({ ok: true, ids: [ownArtifact] });
  });

  test('refuses another team\'s artifact, naming it, without saying it exists', async () => {
    const r = await checkContextArtifactIds([ownArtifact, foreignArtifact], { userId: userA }, teamA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(foreignArtifact);
      expect(r.error).not.toContain(ownArtifact);
      expect(r.error).toContain('not found or not accessible');
    }
  });

  test('refuses an artifact the caller can read when the mission belongs to another team', async () => {
    // userA reads wsA, but a mission of team B must not pull team A material.
    const r = await checkContextArtifactIds([ownArtifact], { userId: userA }, teamB);
    expect(r.ok).toBe(false);
  });

  test('refuses a workspace-less artifact, a missing id and a non-UUID', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const r = await checkContextArtifactIds([orphanArtifact, missing, 'nope'], { userId: userA }, teamA);
    expect(r.ok).toBe(false);
    if (!r.ok) for (const id of [orphanArtifact, missing, 'nope']) expect(r.error).toContain(id);
  });

  test('an API key reaches its team\'s open workspace but not a restricted one it is not linked to', async () => {
    const account = { id: '00000000-0000-4000-8000-0000000000aa', teamId: teamA, workspaceIds: null } as any;
    expect((await checkContextArtifactIds([ownArtifact], { account }, teamA)).ok).toBe(true);
    expect((await checkContextArtifactIds([restrictedArtifact], { account }, teamA)).ok).toBe(false);
  });

  test('rejects a non-array and absent means empty', async () => {
    expect((await checkContextArtifactIds('x', { userId: userA }, teamA)).ok).toBe(false);
    expect(await checkContextArtifactIds(undefined, { userId: userA }, teamA)).toEqual({ ok: true, ids: [] });
  });
});

describe('contextArtifactsWhere: the planning-context read', () => {
  test('a stored foreign or workspace-less id is never read', async () => {
    const rows = await db.query.artifacts.findMany({
      where: contextArtifactsWhere([ownArtifact, restrictedArtifact, foreignArtifact, orphanArtifact], teamA),
      columns: { id: true },
    });
    expect(rows.map((r) => r.id).sort()).toEqual([ownArtifact, restrictedArtifact].sort());
  });
});
