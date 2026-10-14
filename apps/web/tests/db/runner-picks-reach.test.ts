/**
 * A runner key's picks reach a workspace only while the person who picked it
 * still may (spec "One runner for every team you run", R-3, R-6, AC-2, AC-3),
 * on real Postgres.
 *
 * The rule lives in one SQL predicate (lib/granted-links.ts), applied by the
 * permission cache every claim reads and by the relational link readers. A
 * mocked `db` would hide it, so this runs on real rows.
 *
 * World: a key whose home is team A, picked by person P into team B, where P
 * starts as a plain member. B has an open and a restricted workspace.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';

setDefaultTimeout(30_000);

const { liveGrantedWorkspaceIds } = await import('../../src/lib/granted-links');
const { getAccountWorkspacePermissions, clearAccountWorkspaceCache } = await import('../../src/lib/account-workspace-cache');
const { getLinkedWorkspaceIds } = await import('../../src/lib/workspace-resolver');

let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function team(): Promise<string> {
  const slug = `rp-${uniq()}`;
  const [t] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES (${slug}, ${slug}) RETURNING id`);
  return t.id;
}
async function workspace(teamId: string, accessMode: 'open' | 'restricted'): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, access_mode) VALUES (${`w-${uniq()}`}, ${teamId}::uuid, ${accessMode}) RETURNING id`);
  return w.id;
}
async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`${uniq()}@example.test`}) RETURNING id`);
  return u.id;
}
async function member(teamId: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${userId}::uuid, ${role})`);
}
async function key(teamId: string, userId: string): Promise<string> {
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, created_by_user_id)
    VALUES ('user', 'Runner', ${`hash-${uniq()}`}, ${teamId}::uuid, ${userId}::uuid) RETURNING id`);
  return a.id;
}
async function link(accountId: string, workspaceId: string, grantedBy: string | null) {
  await q(sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create, granted_by_user_id)
    VALUES (${accountId}::uuid, ${workspaceId}::uuid, true, true, ${grantedBy}::uuid)`);
}

beforeAll(() => assertDbConfigured());

describe('a pick reaches only while the person who made it still may', () => {
  test('member: open pick holds, restricted pick does not; promotion, demotion and leaving apply on the next read', async () => {
    const [home, other] = [await team(), await team()];
    const person = await user();
    await member(home, person, 'owner');
    await member(other, person, 'member');
    const open = await workspace(other, 'open');
    const restricted = await workspace(other, 'restricted');
    const k = await key(home, person);
    await link(k, open, person);
    await link(k, restricted, person);
    clearAccountWorkspaceCache();

    // AC-2: a plain member keeps the open workspace and not the restricted one.
    expect([...(await liveGrantedWorkspaceIds(k))].sort()).toEqual([open].sort());
    const perms = await getAccountWorkspacePermissions(k, { includeRevoked: true });
    expect(perms.find((p) => p.workspaceId === open)?.revoked).toBeUndefined();
    expect(perms.find((p) => p.workspaceId === restricted)).toMatchObject({ revoked: true, canClaim: false, canCreate: false });
    expect((await getAccountWorkspacePermissions(k)).map((p) => p.workspaceId)).toEqual([open]);

    // Promoted to admin: the restricted pick holds, with no change to the rows
    // and the cached rows untouched (the re-check is never cached).
    await q(sql`UPDATE team_members SET role = 'admin' WHERE team_id = ${other}::uuid AND user_id = ${person}::uuid`);
    expect([...(await liveGrantedWorkspaceIds(k))].sort()).toEqual([open, restricted].sort());
    expect((await getAccountWorkspacePermissions(k)).map((p) => p.workspaceId).sort()).toEqual([open, restricted].sort());

    // The open workspace turns restricted under a member: it drops (R-3).
    await q(sql`UPDATE team_members SET role = 'member' WHERE team_id = ${other}::uuid AND user_id = ${person}::uuid`);
    await q(sql`UPDATE workspaces SET access_mode = 'restricted' WHERE id = ${open}::uuid`);
    expect((await liveGrantedWorkspaceIds(k)).size).toBe(0);
    await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${open}::uuid`);

    // AC-3: removed from the team, nothing there holds, on the very next read.
    await q(sql`DELETE FROM team_members WHERE team_id = ${other}::uuid AND user_id = ${person}::uuid`);
    expect((await liveGrantedWorkspaceIds(k)).size).toBe(0);
    expect(await getAccountWorkspacePermissions(k)).toEqual([]);
  });

  test("membership in a different team never stands in for the workspace's own team", async () => {
    const [home, other, third] = [await team(), await team(), await team()];
    const person = await user();
    await member(home, person, 'owner');
    await member(third, person, 'owner');
    const ws = await workspace(other, 'open');
    const k = await key(home, person);
    await link(k, ws, person);
    clearAccountWorkspaceCache();
    expect((await liveGrantedWorkspaceIds(k)).size).toBe(0);
  });

  test("another person's membership does not keep a pick alive", async () => {
    const [home, other] = [await team(), await team()];
    const [picker, colleague] = [await user(), await user()];
    await member(home, picker, 'owner');
    await member(other, colleague, 'owner');
    const ws = await workspace(other, 'restricted');
    const k = await key(home, picker);
    await link(k, ws, picker);
    clearAccountWorkspaceCache();
    expect((await liveGrantedWorkspaceIds(k)).size).toBe(0);
  });

  test('R-6: a link without the marker behaves as it always has, whoever is on the team', async () => {
    const [home, other] = [await team(), await team()];
    const person = await user();
    await member(home, person, 'owner');
    const ws = await workspace(other, 'restricted');
    const k = await key(home, person);
    await link(k, ws, null);
    clearAccountWorkspaceCache();
    expect((await getAccountWorkspacePermissions(k)).map((p) => p.workspaceId)).toEqual([ws]);
    expect(await getLinkedWorkspaceIds(k, 'canClaim')).toEqual([ws]);
  });

  test('mint and edit: a key homed in the default team, confined to its picks, edited in place (R-1, R-2, R-4, AC-4)', async () => {
    const { mintRunnerKey, replaceRunnerPicks, listRunnerKeys } = await import('../../src/lib/runner-picks');
    const person = await user();
    const [{ id: home }] = await q<{ id: string }>(sql`
      INSERT INTO teams (name, slug) VALUES ('Personal', ${`personal-${person}`}) RETURNING id`);
    const other = await team();
    await member(home, person, 'owner');
    await member(other, person, 'member');
    const homeWs = await workspace(home, 'restricted');
    const otherOpen = await workspace(other, 'open');
    const otherRestricted = await workspace(other, 'restricted');

    // A member cannot pick the other team's restricted workspace (R-2).
    const refused = await mintRunnerKey({ userId: person, workspaceIds: [otherRestricted], name: 'Runner', requestedLevel: 'admin' });
    expect(refused).toMatchObject({ ok: false, status: 403 });

    const minted = await mintRunnerKey({ userId: person, workspaceIds: [homeWs, otherOpen], name: 'Runner', requestedLevel: 'admin' });
    if (!minted.ok) throw new Error(minted.message);
    expect(minted.teamId).toBe(home);
    // Member in one picked team caps the key at worker, wherever its home is.
    expect(minted.level).toBe('worker');
    const [row] = await q<{ workspace_ids: string[]; team_id: string }>(sql`SELECT workspace_ids, team_id FROM accounts WHERE id = ${minted.accountId}::uuid`);
    expect([...row.workspace_ids].sort()).toEqual([homeWs, otherOpen].sort());
    const granted = await q<{ workspace_id: string; granted_by_user_id: string }>(sql`
      SELECT workspace_id, granted_by_user_id FROM account_workspaces WHERE account_id = ${minted.accountId}::uuid ORDER BY workspace_id`);
    expect(granted.map((g) => g.granted_by_user_id)).toEqual([person, person]);

    // An admin's ordinary link on the key survives an edit.
    const extra = await workspace(home, 'open');
    await link(minted.accountId, extra, null);

    const edited = await replaceRunnerPicks({ accountId: minted.accountId, userId: person, workspaceIds: [otherOpen] });
    expect(edited).toEqual({ ok: true, workspaceIds: [otherOpen] });
    const after = await q<{ workspace_id: string; granted_by_user_id: string | null }>(sql`
      SELECT workspace_id, granted_by_user_id FROM account_workspaces WHERE account_id = ${minted.accountId}::uuid`);
    expect(after.map((r) => r.workspace_id).sort()).toEqual([otherOpen, extra].sort());
    const [same] = await q<{ id: string; workspace_ids: string[] }>(sql`SELECT id, workspace_ids FROM accounts WHERE id = ${minted.accountId}::uuid`);
    expect(same.workspace_ids).toEqual([otherOpen]);

    // Someone else cannot edit it: it reads as not found.
    const stranger = await user();
    expect(await replaceRunnerPicks({ accountId: minted.accountId, userId: stranger, workspaceIds: [otherOpen] }))
      .toMatchObject({ ok: false, status: 404 });

    // Settings lists it, and after leaving the team the pick shows unreachable (AC-3).
    await q(sql`DELETE FROM team_members WHERE team_id = ${other}::uuid AND user_id = ${person}::uuid`);
    const listed = (await listRunnerKeys(person)).find((k) => k.id === minted.accountId);
    expect(listed?.picks).toEqual([expect.objectContaining({ workspaceId: otherOpen, reachable: false })]);
  });

  test('the relational link reader applies the same re-check', async () => {
    const [home, other] = [await team(), await team()];
    const person = await user();
    await member(home, person, 'owner');
    await member(other, person, 'member');
    const open = await workspace(other, 'open');
    const restricted = await workspace(other, 'restricted');
    const k = await key(home, person);
    await link(k, open, person);
    await link(k, restricted, person);
    expect(await getLinkedWorkspaceIds(k, 'canClaim')).toEqual([open]);
  });
});
