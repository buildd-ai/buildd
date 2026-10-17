/**
 * The repo scope the control plane checks before acting through a repo other than the
 * workspace's own (lib/workflow/command-installation.ts), and the installation it resolves,
 * on real Postgres: a mocked `db` would hide every predicate here.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedTask, seedWorkspace } from './harness';

assertDbConfigured();
const { expectedInstallation, repoInScope } = await import('../../src/lib/workflow/command-installation');

const uniq = () => Math.random().toString(36).slice(2, 8);
let nextId = 700_000 + Math.floor(Math.random() * 100_000);

async function installation(login: string): Promise<{ rowId: string; installationId: number }> {
  const installationId = nextId++;
  const [r] = await q<{ id: string }>(sql`
    INSERT INTO github_installations (installation_id, account_type, account_login, account_id)
    VALUES (${installationId}, 'Organization', ${login}, ${installationId}) RETURNING id`);
  return { rowId: r.id, installationId };
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
    const inst = await installation(org);
    await repo(inst, `${org}/app`);
    const w = await linkedWorkspace(null);
    const task = await seedTask(w.workspaceId);
    await workerWithPr(w.workspaceId, task, `https://github.com/${org}/app/pull/2`);
    expect(await expectedInstallation(w.workspaceId, `${org}/app`)).toEqual({ installationId: inst.installationId });
  }, 30_000);
});
