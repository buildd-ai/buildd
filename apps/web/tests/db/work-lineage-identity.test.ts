/**
 * Work lineage and delegated identity (spec 7702c32a), against real Postgres.
 *
 * AC-1: a mission an agent files, and the review and repair under it, trace to
 * their parent, to who filed them and to the person they are for, with the
 * person recorded as derived, never as their own direct action. The task-side
 * half (requester stamped on insert, stable across a claim) lands with the
 * requester trigger in a follow-up.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { db } = await import('@buildd/core/db');
const { missions, tasks } = await import('@buildd/core/db/schema');
const { resolveMissionCreator } = await import('../../src/lib/task-service');

let teamId: string;
let workspaceId: string;
let person: string;
let runnerAccount: string;

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedAccount(): Promise<string> {
  const key = `bld_${rand()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, max_concurrent_workers)
    VALUES ('service', ${key}, ${key}, ${teamId}::uuid, 'admin', 10) RETURNING id`);
  return a.id;
}

async function seedWorker(accountId: string, taskId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
    VALUES (${workspaceId}::uuid, ${accountId}::uuid, ${taskId}::uuid, ${`w-${rand()}`}, 'runner', ${`b-${rand()}`}, 'running')
    RETURNING id`);
  return w.id;
}

async function insertTask(v: Partial<typeof tasks.$inferInsert>) {
  const [t] = await db.insert(tasks).values({ workspaceId, title: `t-${rand()}`, ...v }).returning();
  return t;
}

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`p-${rand()}@example.test`}) RETURNING id`);
  person = u.id;
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${person}::uuid, 'member')`);
  runnerAccount = await seedAccount();
});

describe('AC-1: agent-created mission and its review/repair', () => {
  test('trace to their parent, who filed them and the person they are for', async () => {
    // The person files a task; an agent working it files a mission.
    const origin = await insertTask({ createdByUserId: person });
    const agentWorker = await seedWorker(runnerAccount, origin.id);
    const creator = await resolveMissionCreator({ user: null, apiAccount: { id: runnerAccount }, createdByWorkerId: agentWorker });
    const [mission] = await db.insert(missions).values({ teamId, workspaceId, title: `m-${rand()}`, ...creator }).returning();

    expect({
      user: mission.createdByUserId, source: mission.requesterSource,
      account: mission.createdByAccountId, worker: mission.createdByWorkerId, task: mission.createdByTaskId,
    }).toEqual({ user: person, source: 'parent', account: runnerAccount, worker: agentWorker, task: origin.id });
  });

  test('a mission filed by an agent whose task has no person records none, not the runner', async () => {
    const origin = await insertTask({});
    const agentWorker = await seedWorker(runnerAccount, origin.id);
    const creator = await resolveMissionCreator({ user: null, apiAccount: { id: runnerAccount }, createdByWorkerId: agentWorker });
    expect(creator).toEqual({
      createdByUserId: null, requesterSource: 'none',
      createdByAccountId: runnerAccount, createdByWorkerId: agentWorker, createdByTaskId: origin.id,
    });
  });
});
