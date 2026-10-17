/**
 * The repo scope the control plane checks before acting through a repo other than the
 * workspace's own (lib/workflow/command-installation.ts), and the installation it resolves,
 * on real Postgres: a mocked `db` would hide every predicate here. Each command acts only
 * through its own team's installation (`installationBelongsToTeam`), here and in the doors
 * that pick one for a cross-repo PR (`teamInstallationIdForRepo`).
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

assertDbConfigured();
const { expectedInstallation, repoInScope } = await import('../../src/lib/workflow/command-installation');
const { installationBelongsToTeam } = await import('../../src/lib/github-installation-access');
const { teamInstallationIdForRepo } = await import('../../src/lib/workspace-installation');

const uniq = () => Math.random().toString(36).slice(2, 8);
let nextId = 700_000 + Math.floor(Math.random() * 100_000);

async function installation(login: string, opts: { accountId?: number; installedBy?: string } = {}): Promise<{ rowId: string; installationId: number; accountId: number }> {
  const installationId = nextId++;
  const accountId = opts.accountId ?? installationId;
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO github_installations (installation_id, account_type, account_login, account_id, installed_by_user_id)
    VALUES (${installationId}, 'Organization', ${login}, ${accountId}, ${opts.installedBy ?? null}::uuid) RETURNING id`);
  return { rowId: r.id, installationId, accountId };
}

/** A user who is a member of `teamId`. */
async function member(teamId: string): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${uniq()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

/** A second workspace of the same team as `teamId`'s, linked to a repo under `inst`. */
async function teamWorkspace(teamId: string, fullName: string, inst: { rowId: string }) {
  const repoRow = await repo(inst, fullName);
  const [ws] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, github_repo_id) VALUES (${`w-${uniq()}`}, ${teamId}::uuid, ${repoRow}::uuid) RETURNING id`);
  return { teamId, workspaceId: ws.id };
}

async function repo(inst: { rowId: string }, fullName: string): Promise<string> {
  const [owner, name] = fullName.split('/');
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO github_repos (installation_id, repo_id, full_name, name, owner)
    VALUES (${inst.rowId}::uuid, ${nextId++}, ${fullName}, ${name}, ${owner}) RETURNING id`);
  return r.id;
}

async function linkedWorkspace(fullName: string | null, inst?: { rowId: string }) {
  const w = await seedWorkspace();
  if (fullName && inst) {
    const repoRow = await repo(inst, fullName);
    await q(sql`UPDATE workspaces SET github_repo_id = ${repoRow}::uuid WHERE id = ${w.workspaceId}::uuid`);
  }
  return w;
}

async function workerWithPr(workspaceId: string, taskId: string, prUrl: string) {
  await q(sql`
    INSERT INTO workers (workspace_id, task_id, name, branch, status, runner, pr_url, pr_number)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${`w-${uniq()}`}, ${`b-${uniq()}`}, 'completed', 'test', ${prUrl}, 1)`);
}

describe('the repo scope of a workspace', () => {
  test('a repo a worker of the workspace has a PR in is in scope (any casing); an unrelated repo is not', async () => {
    const org = `org${uniq()}`;
    const inst = await installation(org);
    const w = await linkedWorkspace(`${org}/web`, inst);
    const task = await seedTask(w.workspaceId);
    await workerWithPr(w.workspaceId, task, `https://github.com/${org}/Mobile/pull/1`);
    expect(await repoInScope(w.workspaceId, `${org}/mobile`)).toBe(true);
    expect(await repoInScope(w.workspaceId, `${org}/mobile-legacy`)).toBe(false);
    expect(await repoInScope(w.workspaceId, `someone${uniq()}/else`)).toBe(false);
  }, 30_000);

  test('a repo of a sibling task in one of the workspace\'s missions is in scope: its workspace\'s repo or a PR its worker opened', async () => {
    const org = `org${uniq()}`;
    const inst = await installation(org);
    const w = await linkedWorkspace(`${org}/web`, inst);
    const sibling = await linkedWorkspace(`${org}/api`, inst);
    const missionId = await seedMission(w.teamId, w.workspaceId);
    await seedTask(w.workspaceId, { missionId });
    const siblingTask = await seedTask(sibling.workspaceId, { missionId });
    await workerWithPr(sibling.workspaceId, siblingTask, `https://github.com/${org}/docs/pull/4`);
    expect(await repoInScope(w.workspaceId, `${org}/api`)).toBe(true);
    expect(await repoInScope(w.workspaceId, `${org}/docs`)).toBe(true);
    // A workspace outside that mission does not reach them.
    const stranger = await linkedWorkspace(null);
    expect(await repoInScope(stranger.workspaceId, `${org}/api`)).toBe(false);
  }, 30_000);
});

describe('the installation resolved for a command', () => {
  test('own repo: the workspace\'s; a cross-repo PR under a second installation: that one; outside scope: refused', async () => {
    const org = `org${uniq()}`;
    const other = `other${uniq()}`;
    const instA = await installation(org);
    const instB = await installation(other);
    const w = await linkedWorkspace(`${org}/web`, instA);
    await teamWorkspace(w.teamId, `${other}/mobile-app`, instB);
    await repo(instB, `${other}/mobile`);
    const task = await seedTask(w.workspaceId);
    await workerWithPr(w.workspaceId, task, `https://github.com/${other}/mobile/pull/9`);
    expect(await expectedInstallation(w.workspaceId, `${org}/web`)).toEqual({ installationId: instA.installationId });
    expect(await expectedInstallation(w.workspaceId, `${other}/mobile`)).toEqual({ installationId: instB.installationId });
    await repo(instB, `${other}/private`);
    expect(await expectedInstallation(w.workspaceId, `${other}/private`)).toEqual({ refused: 'repo_out_of_scope' });
  }, 30_000);

  test('a workspace with no linked repo resolves a cross-repo command through the PR\'s repo', async () => {
    const org = `org${uniq()}`;
    const w = await linkedWorkspace(null);
    const inst = await installation(org, { installedBy: await member(w.teamId) });
    await repo(inst, `${org}/app`);
    const task = await seedTask(w.workspaceId);
    await workerWithPr(w.workspaceId, task, `https://github.com/${org}/app/pull/2`);
    expect(await expectedInstallation(w.workspaceId, `${org}/app`)).toEqual({ installationId: inst.installationId });
  }, 30_000);
});

describe('each command acts only through its own team\'s installation', () => {
  test('a cross-repo mission across the team\'s own installations: the sibling repo\'s installation is accepted', async () => {
    const org = `org${uniq()}`;
    const other = `other${uniq()}`;
    const instA = await installation(org);
    const instB = await installation(other);
    const w = await linkedWorkspace(`${org}/web`, instA);
    const sibling = await teamWorkspace(w.teamId, `${other}/api`, instB);
    const missionId = await seedMission(w.teamId, w.workspaceId);
    await seedTask(w.workspaceId, { missionId });
    await seedTask(sibling.workspaceId, { missionId });
    expect(await expectedInstallation(w.workspaceId, `${other}/api`)).toEqual({ installationId: instB.installationId });
    expect(await teamInstallationIdForRepo(`${other}/api`, w.teamId)).toEqual({ installationId: instB.installationId });
  }, 30_000);

  test('a repo in scope whose installation belongs to another team is refused', async () => {
    const org = `org${uniq()}`;
    const foreign = `foreign${uniq()}`;
    const instA = await installation(org);
    const w = await linkedWorkspace(`${org}/web`, instA);
    // Another team's workspace, linked to its own installation on another account.
    const otherTeam = await linkedWorkspace(`${foreign}/web`, await installation(foreign));
    const [{ installationId: foreignInst }] = await q<{ installationId: number }>(sql`
      SELECT gi.installation_id AS "installationId" FROM workspaces w
      JOIN github_repos r ON r.id = w.github_repo_id JOIN github_installations gi ON gi.id = r.installation_id
      WHERE w.id = ${otherTeam.workspaceId}::uuid`);
    const task = await seedTask(w.workspaceId);
    await workerWithPr(w.workspaceId, task, `https://github.com/${foreign}/web/pull/3`);
    expect(await repoInScope(w.workspaceId, `${foreign}/web`)).toBe(true);
    expect(await expectedInstallation(w.workspaceId, `${foreign}/web`)).toEqual({ refused: 'installation_not_team_owned' });
    expect(await teamInstallationIdForRepo(`${foreign}/web`, w.teamId)).toEqual({ installationId: null, notTeamOwned: true });
    // The other team still acts through it.
    expect(await expectedInstallation(otherTeam.workspaceId, `${foreign}/web`)).toEqual({ installationId: Number(foreignInst) });
  }, 30_000);

  test('ownership: linked through a workspace\'s repo or its direct pointer, a reinstall on the same account, or a member\'s install', async () => {
    const w = await seedWorkspace();
    const stranger = await seedWorkspace();
    const viaRepo = await installation(`a${uniq()}`);
    await teamWorkspace(w.teamId, `a${uniq()}/x`, viaRepo);
    const viaPointer = await installation(`b${uniq()}`);
    await q(sql`INSERT INTO workspaces (name, team_id, github_installation_id) VALUES (${`w-${uniq()}`}, ${w.teamId}::uuid, ${viaPointer.rowId}::uuid)`);
    const reinstall = await installation(`a${uniq()}`, { accountId: viaRepo.accountId });
    const byMember = await installation(`c${uniq()}`, { installedBy: await member(w.teamId) });
    const unrelated = await installation(`d${uniq()}`, { installedBy: await member(stranger.teamId) });

    for (const i of [viaRepo, viaPointer, reinstall, byMember]) {
      expect(await installationBelongsToTeam(i.installationId, w.teamId)).toBe(true);
      expect(await installationBelongsToTeam(i.installationId, stranger.teamId)).toBe(false);
    }
    expect(await installationBelongsToTeam(unrelated.installationId, w.teamId)).toBe(false);
    expect(await installationBelongsToTeam(unrelated.installationId, stranger.teamId)).toBe(true);
    expect(await installationBelongsToTeam(nextId++, w.teamId)).toBe(false);
  }, 30_000);
});
