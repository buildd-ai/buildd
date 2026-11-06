/**
 * Proposals: unrequested drafts leave the approval inbox (Living Spec b7fc9316
 * R-35 / AC-36; 65ed7fa3 R-81 / AC-127). Built ahead of approval, against
 * b7fc9316 r6 and 65ed7fa3 r4.
 *
 * - A native draft never approved, with no task pinned to it, no mission
 *   selecting it, and not written by a task filed to write it, is a proposal:
 *   absent from the inbox, its count and `awaiting_approval`; listed under
 *   Proposals (AC-36).
 * - A mission selecting it, or a task pinning it, returns it to the inbox.
 * - A draft by a person, or by a writing task, stays in the inbox.
 * - create_draft from an observation task or a scheduled task is 403 and
 *   writes nothing (AC-127).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedMission, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-proposals-test-secret';

const { createSpecDraft } = await import('../../src/lib/specs/store');
const { listAwaitingApproval, countAwaitingApprovalFor, countAwaitingApproval } = await import('../../src/lib/specs/approval-inbox');
const { listProposals } = await import('../../src/lib/specs/proposals');

const rand = () => Math.random().toString(36).slice(2, 10);
let teamId: string; let wsId: string; let owner: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: wsId } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsId}::uuid`);
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'owner')`);
  owner = u.id;
});

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const BODY = () => `# Snapshot ${rand()}\nR-1: The thing holds ${rand()}.\n`;
async function task(kind: string | null, opts: { scheduled?: boolean } = {}) {
  let scheduleId: string | null = null;
  if (opts.scheduled) {
    const [s] = await q<{ id: string }>(sql`INSERT INTO task_schedules (workspace_id, name, cron_expression, task_template)
      VALUES (${wsId}::uuid, ${`s-${rand()}`}, '0 * * * *', ${JSON.stringify({ title: 'watch' })}::jsonb) RETURNING id`);
    scheduleId = s.id;
  }
  const [t] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, title, status, kind, schedule_id)
    VALUES (${wsId}::uuid, ${`t-${rand()}`}, 'in_progress', ${kind}, ${scheduleId}::uuid) RETURNING id`);
  return t.id;
}
const byTask = (taskId: string) => ({ kind: 'account' as const, account: { id: ACCOUNT, teamId, workspaceIds: null, taskScope: { taskId, workspaceId: wsId } } as any });
async function draftBy(caller: any) {
  const r = await createSpecDraft(caller, { workspaceId: wsId, title: `Spec ${rand()}`, body: BODY() }, { duplicates: false });
  return r;
}
const inInbox = async (specId: string) => (await listAwaitingApproval(owner)).some((r) => r.specId === specId);
const inProposals = async (specId: string) => (await listProposals(wsId)).some((r) => r.specId === specId);

describe('Proposals (AC-36)', () => {
  test('an unrequested draft from an engineering task is a proposal, not an inbox row', async () => {
    const r = await draftBy(byTask(await task('engineering')));
    if (!r.ok) throw new Error(r.error);
    expect(await inInbox(r.spec.id)).toBe(false);
    expect(await inProposals(r.spec.id)).toBe(true);
  });

  test('it leaves the inbox count and awaiting_approval too', async () => {
    const before = await countAwaitingApprovalFor(owner);
    const beforeWs = (await countAwaitingApproval({ kind: 'user', userId: owner }, wsId) as any).count;
    const r = await draftBy(byTask(await task('research')));
    if (!r.ok) throw new Error(r.error);
    expect(await countAwaitingApprovalFor(owner)).toBe(before);
    expect((await countAwaitingApproval({ kind: 'user', userId: owner }, wsId) as any).count).toBe(beforeWs);
  });

  test('a person\'s draft is requested: inbox row, not a proposal', async () => {
    const r = await draftBy({ kind: 'user', userId: owner });
    if (!r.ok) throw new Error(r.error);
    expect(await inInbox(r.spec.id)).toBe(true);
    expect(await inProposals(r.spec.id)).toBe(false);
  });

  test('a draft by a task filed to write it (kind writing) stays in the inbox', async () => {
    const r = await draftBy(byTask(await task('writing')));
    if (!r.ok) throw new Error(r.error);
    expect(await inInbox(r.spec.id)).toBe(true);
    expect(await inProposals(r.spec.id)).toBe(false);
  });

  test('a task pinning the spec returns it to the inbox', async () => {
    const r = await draftBy(byTask(await task('engineering')));
    if (!r.ok) throw new Error(r.error);
    expect(await inProposals(r.spec.id)).toBe(true);
    await q(sql`INSERT INTO tasks (workspace_id, title, status, context)
      VALUES (${wsId}::uuid, 'build it', 'pending', ${JSON.stringify({ specSource: { specId: r.spec.id } })}::jsonb)`);
    expect(await inProposals(r.spec.id)).toBe(false);
    expect(await inInbox(r.spec.id)).toBe(true);
  });

  test('a mission selecting the spec returns it to the inbox', async () => {
    const r = await draftBy(byTask(await task('engineering')));
    if (!r.ok) throw new Error(r.error);
    const missionId = await seedMission(teamId, wsId);
    await q(sql`UPDATE missions SET goal_criteria = ${JSON.stringify([{ type: 'living_spec', specId: r.spec.id }])}::jsonb WHERE id = ${missionId}::uuid`);
    expect(await inProposals(r.spec.id)).toBe(false);
    expect(await inInbox(r.spec.id)).toBe(true);
  });

  test('an approved spec is never a proposal', async () => {
    const r = await draftBy(byTask(await task('engineering')));
    if (!r.ok) throw new Error(r.error);
    await q(sql`UPDATE specs SET approved_revision = 1 WHERE id = ${r.spec.id}::uuid`);
    expect(await inProposals(r.spec.id)).toBe(false);
  });
});

describe('create_draft from observation or scheduled tasks (AC-127)', () => {
  const count = async () => Number((await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM specs WHERE workspace_id = ${wsId}::uuid`))[0].n);

  test('an observation task gets 403 saying why, and nothing is written', async () => {
    const n = await count();
    const r = await draftBy(byTask(await task('observation')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/observation/i);
    expect(await count()).toBe(n);
  });

  test('a scheduled task gets 403 saying why', async () => {
    const r = await draftBy(byTask(await task('engineering', { scheduled: true })));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/schedule/i);
  });

  test('an API key or a person is unaffected', async () => {
    expect((await draftBy({ kind: 'user', userId: owner })).ok).toBe(true);
    expect((await draftBy({ kind: 'account', account: { id: ACCOUNT, teamId, workspaceIds: null } as any })).ok).toBe(true);
  });
});
