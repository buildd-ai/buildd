/**
 * A personal team is marked by `teams.personal_user_id`, never by its slug,
 * and the `personal-` slug prefix is reserved — on real Postgres.
 *
 * - Create and rename refuse a `personal-` slug for an ordinary team.
 * - Every personal-team lookup (team ids, workspace ids, role, default team,
 *   permission roles, the GitHub back-link) reads the column: a team whose
 *   slug alone looks personal is an ordinary team.
 * - The migration's backfill marks a team only when its slug names a user who
 *   owns it, and is safe to run twice.
 */
import { beforeAll, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDbConfigured, q } from './harness';

setDefaultTimeout(30_000);

// The routes read the signed-in person through requireSessionUser; the test
// names who that is per call.
let sessionUserId: string | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({
  ...realAuthHelpers,
  requireSessionUser: async () => sessionUserId
    ? { user: { id: sessionUserId, email: `${sessionUserId}@example.test`, name: null, image: null } }
    : { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) },
}));

const teamsRoute = await import('../../src/app/api/teams/route');
const teamRoute = await import('../../src/app/api/teams/[id]/route');
const access = await import('../../src/lib/team-access');
const { getUserTeamRoles } = await import('../../src/lib/permissions');

beforeAll(() => assertDbConfigured());

const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  return u.id;
}
async function team(slug: string, personalUserId: string | null = null): Promise<string> {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO teams (name, slug, personal_user_id) VALUES (${slug}, ${slug}, ${personalUserId}::uuid) RETURNING id`);
  return t.id;
}
async function member(teamId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function workspace(teamId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${rand()}`}, ${teamId}::uuid) RETURNING id`);
  return w.id;
}
async function slugOf(teamId: string): Promise<string> {
  const [t] = await q<{ slug: string }>(sql`SELECT slug FROM teams WHERE id = ${teamId}::uuid`);
  return t.slug;
}
async function markOf(teamId: string): Promise<string | null> {
  const [t] = await q<{ personal_user_id: string | null }>(sql`SELECT personal_user_id FROM teams WHERE id = ${teamId}::uuid`);
  return t.personal_user_id;
}
function json(method: string, url: string, body: unknown): NextRequest {
  return new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

describe('the personal- slug prefix is reserved', () => {
  test('creating a team with a personal- slug is refused and writes nothing', async () => {
    const me = await user();
    sessionUserId = me;
    const slug = `personal-${me}`;
    const res = await teamsRoute.POST(json('POST', 'http://test/api/teams', { name: 'Mine', slug }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('reserved');
    expect(await q(sql`SELECT 1 FROM teams WHERE slug = ${slug}`)).toHaveLength(0);
  });

  test('an ordinary slug still creates an ordinary team', async () => {
    const me = await user();
    sessionUserId = me;
    const res = await teamsRoute.POST(json('POST', 'http://test/api/teams', { name: 'Acme', slug: `acme-${rand()}` }));
    expect(res.status).toBe(200);
    const created = await res.json() as { id: string; personalUserId: string | null };
    expect(created.personalUserId).toBeNull();
  });

  test('renaming an ordinary team to a personal- slug is refused and leaves the slug as it was', async () => {
    const owner = await user();
    const slug = `ops-${rand()}`;
    const t = await team(slug);
    await member(t, owner, 'owner');
    sessionUserId = owner;
    const res = await teamRoute.PATCH(
      json('PATCH', `http://test/api/teams/${t}`, { slug: `personal-${owner}` }),
      { params: Promise.resolve({ id: t }) },
    );
    expect(res.status).toBe(400);
    expect(await slugOf(t)).toBe(slug);
    expect(await markOf(t)).toBeNull();
  });

  test('a personal team sending its own slug back is not a rename', async () => {
    const me = await user();
    const t = await team(`personal-${me}`, me);
    await member(t, me, 'owner');
    sessionUserId = me;
    const res = await teamRoute.PATCH(
      json('PATCH', `http://test/api/teams/${t}`, { name: 'Renamed', slug: `personal-${me}` }),
      { params: Promise.resolve({ id: t }) },
    );
    expect(res.status).toBe(200);
  });
});

describe('lookups read the column, never the slug', () => {
  test('a team whose slug alone names a user is not that user\'s personal team', async () => {
    const victim = await user();
    const other = await user();
    // An ordinary team owned by someone else, carrying the user's would-be slug.
    const t = await team(`personal-${victim}`);
    await member(t, other, 'owner');
    const ws = await workspace(t);

    expect(await access.getUserTeamIds(victim)).not.toContain(t);
    expect(await access.getUserWorkspaceIds(victim)).not.toContain(ws);
    expect(await access.getUserTeamRole(victim, t)).toBeNull();
    expect(await access.getUserDefaultTeamId(victim)).toBeNull();
    expect((await getUserTeamRoles(victim)).has(t)).toBe(false);
  });

  test('a marked personal team resolves as owned even with no membership row', async () => {
    const me = await user();
    // Any slug: the column decides.
    const t = await team(`home-${rand()}`, me);
    const ws = await workspace(t);

    expect(await access.getUserTeamIds(me)).toContain(t);
    expect(await access.getUserWorkspaceIds(me)).toContain(ws);
    expect(await access.getUserTeamRole(me, t)).toBe('owner');
    expect(await access.getUserDefaultTeamId(me)).toBe(t);
    expect((await getUserTeamRoles(me)).get(t)).toBe('owner');
  });

  test('a user has at most one personal team', async () => {
    const me = await user();
    await team(`home-${rand()}`, me);
    await expect(team(`home-${rand()}`, me)).rejects.toThrow();
  });
});

describe('the backfill marks only real personal teams', () => {
  const dir = join(import.meta.dir, '../../../../packages/core/drizzle');
  const folder = readdirSync(dir).find((f) => f.endsWith('_personal_team_column'));
  if (!folder) throw new Error('personal team migration folder not found');
  // The migration adds the column, then backfills it. The database here is
  // already migrated, so run only the backfill statement, exactly as written.
  const statements = readFileSync(join(dir, folder, 'migration.sql'), 'utf8').split('--> statement-breakpoint');
  const backfill = statements.find((st) => /^\s*UPDATE "teams"/m.test(st));
  if (!backfill) throw new Error('backfill UPDATE not found in the personal team migration');

  test('slug naming a user who owns it: marked; slug-only, non-owner or unknown user: not; re-run changes nothing', async () => {
    const real = await user();
    const realTeam = await team(`personal-${real}`);
    await member(realTeam, real, 'owner');

    const nonOwner = await user();
    const nonOwnerTeam = await team(`personal-${nonOwner}`);
    await member(nonOwnerTeam, nonOwner, 'member');

    const absent = await user();
    const absentTeam = await team(`personal-${absent}`);

    const unknownTeam = await team(`personal-${crypto.randomUUID()}`);

    await q(sql.raw(backfill));
    expect(await markOf(realTeam)).toBe(real);
    expect(await markOf(nonOwnerTeam)).toBeNull();
    expect(await markOf(absentTeam)).toBeNull();
    expect(await markOf(unknownTeam)).toBeNull();

    await q(sql.raw(backfill));
    expect(await markOf(realTeam)).toBe(real);
    expect(await markOf(nonOwnerTeam)).toBeNull();
  });
});
