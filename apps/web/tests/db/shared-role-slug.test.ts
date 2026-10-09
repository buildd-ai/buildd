/**
 * Team roles and shared personal roles share one slug namespace per team, in
 * the database (ws_skills_team_slug_idx). The share route checks for a clash
 * first, but two concurrent shares both pass that check; only the index can
 * refuse the second. Private personal roles stay outside the namespace.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { isSharedSlugViolation } from '@/lib/personal-roles';
import { assertDbConfigured, q, seedWorkspace } from './harness';

async function user(): Promise<string> {
  const email = `u-${crypto.randomUUID()}@example.test`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${email}) RETURNING id`);
  return u.id;
}

async function role(teamId: string, slug: string, opts: { owner?: string; visibility?: 'private' | 'team' } = {}): Promise<string> {
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO workspace_skills (team_id, slug, name, content, content_hash, is_role, owner_user_id, visibility)
    VALUES (${teamId}::uuid, ${slug}, ${slug}, 'x', 'h', true, ${opts.owner ?? null}::uuid, ${opts.visibility ?? 'team'})
    RETURNING id`);
  return r.id;
}

async function share(id: string): Promise<unknown> {
  try {
    await q(sql`UPDATE workspace_skills SET visibility = 'team' WHERE id = ${id}::uuid`);
    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(() => assertDbConfigured());

describe('shared role slug namespace', () => {
  test('two members may each keep a private role with the same slug, alongside a team role', async () => {
    const { teamId } = await seedWorkspace();
    await role(teamId, 'reviewer');
    await role(teamId, 'reviewer', { owner: await user(), visibility: 'private' });
    await role(teamId, 'reviewer', { owner: await user(), visibility: 'private' });
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM workspace_skills WHERE team_id = ${teamId}::uuid AND slug = 'reviewer'`);
    expect(n).toBe(3);
  });

  test('sharing a private role whose slug a team role already holds is refused', async () => {
    const { teamId } = await seedWorkspace();
    await role(teamId, 'writer');
    const mine = await role(teamId, 'writer', { owner: await user(), visibility: 'private' });
    const err = await share(mine);
    expect(isSharedSlugViolation(err)).toBe(true);
  });

  test('the second of two shares of one slug is refused, even with no team role', async () => {
    const { teamId } = await seedWorkspace();
    const a = await role(teamId, 'triage', { owner: await user(), visibility: 'private' });
    const b = await role(teamId, 'triage', { owner: await user(), visibility: 'private' });
    expect(await share(a)).toBeNull();
    expect(isSharedSlugViolation(await share(b))).toBe(true);
  });

  test('the same slug in another team is unaffected', async () => {
    const one = await seedWorkspace();
    const two = await seedWorkspace();
    await role(one.teamId, 'ops');
    const theirs = await role(two.teamId, 'ops', { owner: await user(), visibility: 'private' });
    expect(await share(theirs)).toBeNull();
  });
});
