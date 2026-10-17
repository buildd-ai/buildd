/**
 * What a team owns among GitHub App installations, on real Postgres, read two ways that
 * must agree: `installationBelongsToTeam` (the doors and the control plane) and
 * `getInstallationOwnerTeamIds` (settings and repo linking). And the per-sweep resolver
 * every PR sweep picks an installation through (`createTeamInstallationResolver`): the
 * workspace's own repo uses its link, another repo only the team's installation covering it.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

assertDbConfigured();
const { installationBelongsToTeam, getInstallationOwnerTeamIds } = await import('../../src/lib/github-installation-access');
const { createTeamInstallationResolver, teamInstallationIdForOwner } = await import('../../src/lib/workspace-installation');

const uniq = () => Math.random().toString(36).slice(2, 8);
let nextId = 800_000 + Math.floor(Math.random() * 100_000);

async function installation(login: string, opts: { accountId?: number; installedBy?: string } = {}) {
  const installationId = nextId++;
  const accountId = opts.accountId ?? installationId;
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO github_installations (installation_id, account_type, account_login, account_id, installed_by_user_id)
    VALUES (${installationId}, 'Organization', ${login}, ${accountId}, ${opts.installedBy ?? null}::uuid) RETURNING id`);
  return { rowId: r.id, installationId, accountId };
}

async function member(teamId: string): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${uniq()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

async function repo(inst: { rowId: string }, fullName: string): Promise<string> {
  const [owner, name] = fullName.split('/');
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
    VALUES (${inst.rowId}::uuid, ${nextId++}, ${fullName}, ${name}, ${owner}) RETURNING id`);
  return r.id;
}

async function linkWorkspace(teamId: string, fullName: string, inst: { rowId: string }) {
  const repoRow = await repo(inst, fullName);
  await q(sql`INSERT INTO workspaces (name, team_id, github_repo_id) VALUES (${`w-${uniq()}`}, ${teamId}::uuid, ${repoRow}::uuid)`);
}

describe('settings and the doors agree on what a team owns', () => {
  test('repo link, direct pointer, reinstall on the same account, member install: both readers say yes; an unrelated install: both say no', async () => {
    const w = await seedWorkspace();
    const stranger = await seedWorkspace();
    const viaRepo = await installation(`a${uniq()}`);
    await linkWorkspace(w.teamId, `a${uniq()}/x`, viaRepo);
    const viaPointer = await installation(`b${uniq()}`);
    await q(sql`INSERT INTO workspaces (name, team_id, github_installation_id) VALUES (${`w-${uniq()}`}, ${w.teamId}::uuid, ${viaPointer.rowId}::uuid)`);
    const reinstallOfRepo = await installation(`a${uniq()}`, { accountId: viaRepo.accountId });
    const reinstallOfPointer = await installation(`b${uniq()}`, { accountId: viaPointer.accountId });
    const byMember = await installation(`c${uniq()}`, { installedBy: await member(w.teamId) });
    const unrelated = await installation(`d${uniq()}`, { installedBy: await member(stranger.teamId) });

    for (const i of [viaRepo, viaPointer, reinstallOfRepo, reinstallOfPointer, byMember]) {
      expect(await installationBelongsToTeam(i.installationId, w.teamId)).toBe(true);
      expect(await getInstallationOwnerTeamIds(i.rowId)).toContain(w.teamId);
      expect(await getInstallationOwnerTeamIds(i.rowId)).not.toContain(stranger.teamId);
    }
    expect(await installationBelongsToTeam(unrelated.installationId, w.teamId)).toBe(false);
    expect(await getInstallationOwnerTeamIds(unrelated.rowId)).toEqual([stranger.teamId]);
  }, 30_000);
});

describe('an installer who leaves the team', () => {
  test('stops giving that team ownership through the member clause, in both readers', async () => {
    const w = await seedWorkspace();
    const installer = await member(w.teamId);
    const inst = await installation(`m${uniq()}`, { installedBy: installer });
    expect(await installationBelongsToTeam(inst.installationId, w.teamId)).toBe(true);
    expect(await getInstallationOwnerTeamIds(inst.rowId)).toEqual([w.teamId]);

    await q(sql`DELETE FROM team_members WHERE team_id = ${w.teamId}::uuid AND user_id = ${installer}::uuid`);
    expect(await installationBelongsToTeam(inst.installationId, w.teamId)).toBe(false);
    expect(await getInstallationOwnerTeamIds(inst.rowId)).toEqual([]);
  }, 30_000);
});

describe('the installation a sweep picks for a PR', () => {
  test('own repo: the workspace link; a repo under another of the team\'s installations: that one; another team\'s: refused, not fallen back from', async () => {
    const w = await seedWorkspace();
    const otherTeam = await seedWorkspace();
    const own = await installation(`o${uniq()}`);
    const sibling = await installation(`s${uniq()}`);
    const foreign = await installation(`f${uniq()}`);
    const ownRepo = `o${uniq()}/web`;
    const siblingRepo = `s${uniq()}/api`;
    const foreignRepo = `f${uniq()}/app`;
    await linkWorkspace(w.teamId, ownRepo, own);
    await linkWorkspace(w.teamId, siblingRepo, sibling);
    await linkWorkspace(otherTeam.teamId, foreignRepo, foreign);

    const { resolve: pick, forWorkspace } = createTeamInstallationResolver();
    const resolve = (r: string, w: Parameters<typeof pick>[1]) => pick(r, w, { fallbackToWorkspace: true });
    const ws = { teamId: w.teamId, fullName: ownRepo, installationId: own.installationId };
    expect(await resolve(ownRepo.toUpperCase(), ws)).toEqual({ installationId: own.installationId });
    expect(await resolve(siblingRepo, ws)).toEqual({ installationId: sibling.installationId });
    expect(await resolve(foreignRepo, ws)).toEqual({ installationId: null, reason: 'installation_not_team_owned' });
    // A repo no installation covers falls back to the workspace's own link.
    expect(await resolve(`n${uniq()}/none`, ws)).toEqual({ installationId: own.installationId });
    expect(await resolve(`n${uniq()}/none`, { ...ws, installationId: null })).toEqual({ installationId: null, reason: 'no_installation' });
    // By workspace id, with no fallback: the same answers for a covered repo, none for an uncovered one.
    expect(await forWorkspace(siblingRepo, w.workspaceId)).toEqual({ installationId: sibling.installationId });
    expect(await forWorkspace(foreignRepo, w.workspaceId)).toEqual({ installationId: null, reason: 'installation_not_team_owned' });
    expect(await forWorkspace(`n${uniq()}/none`, w.workspaceId)).toEqual({ installationId: null, reason: 'no_installation' });
    expect(await forWorkspace(foreignRepo, otherTeam.workspaceId)).toEqual({ installationId: foreign.installationId });
    // The other team still reaches its own repo.
    expect(await resolve(foreignRepo, { teamId: otherTeam.teamId, fullName: null, installationId: null }))
      .toEqual({ installationId: foreign.installationId });
  }, 30_000);
});

describe('the installation on an account, by owner login', () => {
  test('only the team\'s own installation on the account answers, in any casing', async () => {
    const w = await seedWorkspace();
    const other = await seedWorkspace();
    const login = `Acct${uniq()}`;
    const theirs = await installation(login, { installedBy: await member(other.teamId) });
    expect(await teamInstallationIdForOwner(login.toLowerCase(), w.teamId)).toBeNull();
    expect(await teamInstallationIdForOwner(login.toLowerCase(), other.teamId)).toBe(theirs.installationId);
    expect(await teamInstallationIdForOwner(login, null)).toBeNull();
  }, 30_000);
});
