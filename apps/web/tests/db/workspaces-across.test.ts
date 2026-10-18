/**
 * GET /api/workspaces/across/{artifacts,schedules,skills} on real Postgres
 * (spec 3ef37387 R-22): one list over the caller's reachable workspaces,
 * scoped in SQL, never another team's rows; team-level skills included,
 * personal roles not; an artifact carries a short preview, not its body.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

assertDbConfigured();
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));
const route = await import('../../src/app/api/workspaces/across/[list]/route');

const DB_TIMEOUT_MS = 30_000;
let key: string;
let mine: string[];
let other: string;

async function serviceKey(teamId: string): Promise<string> {
  const k = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  await q(sql`INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${`svc-${k.slice(4, 12)}`}, ${createHash('sha256').update(k).digest('hex')}, ${teamId}::uuid, 'admin', 10)`);
  return k;
}

const get = async (list: string, query = '') => {
  const res = await route.GET(new NextRequest(`http://localhost/api/workspaces/across/${list}${query}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ list }) });
  return { status: res.status, body: await res.json() as any };
};

beforeAll(async () => {
  const a = await seedWorkspace();
  const [b] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id, access_mode) VALUES ('second', ${a.teamId}::uuid, 'open') RETURNING id`);
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${a.workspaceId}::uuid`);
  mine = [a.workspaceId, b.id];
  ({ workspaceId: other } = await seedWorkspace());
  key = await serviceKey(a.teamId);
  const [otherTeam] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${other}::uuid`);

  for (const ws of [...mine, other]) {
    await q(sql`INSERT INTO task_schedules (workspace_id, name, cron_expression, task_template) VALUES (${ws}::uuid, ${`s-${ws.slice(0, 8)}`}, '0 * * * *', '{"title":"t"}'::jsonb)`);
    await q(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${ws}::uuid, 'report', ${`a-${ws.slice(0, 8)}`}, ${'x'.repeat(5000)})`);
    await q(sql`INSERT INTO workspace_skills (team_id, workspace_id, slug, name, content, content_hash) VALUES
      ((SELECT team_id FROM workspaces WHERE id = ${ws}::uuid), ${ws}::uuid, ${`k-${ws.slice(0, 8)}`}, 'Skill', 'body', 'h')`);
  }
  await q(sql`INSERT INTO workspace_skills (team_id, workspace_id, slug, name, content, content_hash, is_role) VALUES (${a.teamId}::uuid, NULL, 'team-role', 'Team role', 'body', 'h', true)`);
  await q(sql`INSERT INTO workspace_skills (team_id, workspace_id, slug, name, content, content_hash) VALUES (${otherTeam.team_id}::uuid, NULL, 'their-role', 'Theirs', 'body', 'h')`);
}, 60_000);

describe('/api/workspaces/across', () => {
  test('schedules: every reachable workspace, never another team', async () => {
    const { status, body } = await get('schedules');
    expect(status).toBe(200);
    expect(body.workspaceCount).toBe(2);
    expect(new Set(body.schedules.map((s: any) => s.workspaceId))).toEqual(new Set(mine));
    expect(body.schedules.every((s: any) => typeof s.workspaceName === 'string')).toBe(true);
  }, DB_TIMEOUT_MS);

  test('artifacts: a preview, not the body', async () => {
    const { body } = await get('artifacts', '?type=report');
    expect(new Set(body.artifacts.map((a: any) => a.workspaceId))).toEqual(new Set(mine));
    expect(body.artifacts.every((a: any) => a.content.length === 201)).toBe(true);
  }, DB_TIMEOUT_MS);

  test('skills: the workspaces\' and the team\'s own, not another team\'s', async () => {
    const { body } = await get('skills');
    const slugs = body.skills.map((s: any) => s.slug).sort();
    expect(slugs).toEqual([...mine.map(w => `k-${w.slice(0, 8)}`), 'team-role'].sort());
    expect(body.skills[0].content).toBeUndefined();
    const roles = await get('skills', '?isRole=true');
    expect(roles.body.skills.map((s: any) => s.slug)).toEqual(['team-role']);
  }, DB_TIMEOUT_MS);

  test('an unknown list is a 404', async () => {
    expect((await get('nope')).status).toBe(404);
  }, DB_TIMEOUT_MS);
});
