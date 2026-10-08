/**
 * Local agent presence against real Postgres (docs/specs/local-agent-presence.md).
 *
 * The unit suite drives the handler through a fake store and renders the SQL.
 * This runs the real store, the real release path and the real list query, so
 * the claims the spec makes are checked where they actually live: in the rows.
 * Presence writes no worker and no seat; bind accepts only this account's live
 * interactive worker, once; end releases it exactly once and never completes
 * unfinished work; a headless session is not listed as an interactive one.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { LocalSessionEvent } from '@buildd/shared';
import { handleLocalSessionEvent, hashClientSessionId, LocalSessionError, type LocalSessionAccount, type LocalSessionPerson } from '@/lib/local-session';
import { authenticatePresenceToken, issuePresenceToken, revokePresenceToken } from '@/lib/presence-token';
import { listLocalSessions } from '@/lib/local-session-view';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let workspaceId: string;
let account: LocalSessionAccount;
let other: LocalSessionAccount;
let n = 0;
const sid = () => `sess-${Date.now().toString(36)}-${n++}`;

/** Seat-based (OAuth): only those accounts count active sessions. */
async function seedAccount(teamId: string, activeSessions = 0): Promise<LocalSessionAccount> {
  const key = `bld_test_${Date.now().toString(36)}_${n++}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, active_sessions, auth_type)
    VALUES ('user', ${key}, ${key}, ${teamId}::uuid, ${activeSessions}, 'oauth') RETURNING id`);
  return { id: a.id, teamId };
}

/** A live worker on a claimed task, as claim_task leaves it. runner 'mcp' = verified interactive claim. */
async function seedClaim(acct: LocalSessionAccount, runner = 'mcp', taskStatus = 'in_progress') {
  const taskId = await seedTask(workspaceId, { status: taskStatus });
  await q(sql`UPDATE tasks SET claimed_by = ${acct.id}::uuid, claimed_at = now() WHERE id = ${taskId}::uuid`);
  await q(sql`UPDATE accounts SET active_sessions = active_sessions + 1 WHERE id = ${acct.id}::uuid`);
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
    VALUES (${workspaceId}::uuid, ${acct.id}::uuid, ${taskId}::uuid, 'w', ${runner}, 'buildd/test', 'running')
    RETURNING id`);
  return { taskId, workerId: w.id };
}

const send = (acct: LocalSessionAccount, e: LocalSessionEvent, now?: Date) =>
  handleLocalSessionEvent(acct, e, { resolveWorkspace: async () => workspaceId, ...(now ? { now } : {}) });

const seats = async (acct: LocalSessionAccount) =>
  Number((await q<{ s: number }>(sql`SELECT active_sessions AS s FROM accounts WHERE id = ${acct.id}::uuid`))[0].s);
const taskStatus = async (taskId: string) =>
  (await q<{ status: string }>(sql`SELECT status FROM tasks WHERE id = ${taskId}::uuid`))[0].status;
const workerStatus = async (workerId: string) =>
  (await q<{ status: string }>(sql`SELECT status FROM workers WHERE id = ${workerId}::uuid`))[0].status;

beforeAll(async () => {
  assertDbConfigured();
  const ws = await seedWorkspace();
  workspaceId = ws.workspaceId;
  account = await seedAccount(ws.teamId);
  other = await seedAccount(ws.teamId);
});

describe('presence is not a worker', () => {
  test('start writes one presence row, no worker, no seat, and never the raw session id', async () => {
    const s = sid();
    const before = await seats(account);
    const r = await send(account, { event: 'start', client: 'claude', clientSessionId: s, repo: 'acme/widget', interactive: true });
    expect(r.outcome).toBe('started');
    const [row] = await q<{ client_session_hash: string; repo: string; workspace_id: string; interactive: boolean }>(sql`
      SELECT client_session_hash, repo, workspace_id, interactive FROM local_sessions WHERE id = ${r.sessionId}::uuid`);
    expect(row.client_session_hash).not.toContain(s);
    expect(row.client_session_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).toMatchObject({ repo: 'acme/widget', workspace_id: workspaceId, interactive: true });
    const workers = await q(sql`SELECT id FROM workers WHERE account_id = ${account.id}::uuid AND task_id IS NULL`);
    expect(workers).toHaveLength(0);
    expect(await seats(account)).toBe(before);
  });

  test('a replayed start refreshes the same row', async () => {
    const s = sid();
    const a = await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    const b = await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    expect(b.sessionId).toBe(a.sessionId);
  });

  test('touch inside a minute is coalesced; after a minute it writes', async () => {
    const s = sid();
    const t0 = new Date();
    await send(account, { event: 'start', client: 'claude', clientSessionId: s }, t0);
    expect((await send(account, { event: 'touch', client: 'claude', clientSessionId: s }, new Date(t0.getTime() + 30_000))).outcome).toBe('coalesced');
    expect((await send(account, { event: 'touch', client: 'claude', clientSessionId: s }, new Date(t0.getTime() + 61_000))).outcome).toBe('touched');
  });
});

describe('bind', () => {
  test("binds this account's own interactive worker, once", async () => {
    const s = sid();
    const { workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    expect((await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId })).outcome).toBe('bound');
    expect((await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId })).outcome).toBe('already_bound');
    const rows = await q<{ local_session_id: string }>(sql`SELECT local_session_id FROM local_session_workers WHERE worker_id = ${workerId}::uuid`);
    expect(rows).toHaveLength(1);

    // A second session cannot take it: the primary key holds, not just the code path.
    const err = await send(account, { event: 'bind', client: 'claude', clientSessionId: sid(), workerId }).catch(e => e);
    expect(err).toBeInstanceOf(LocalSessionError);
    expect((err as LocalSessionError).code).toBe('bound_elsewhere');
  });

  test("refuses a runner's worker, and answers another account's worker as not found", async () => {
    const runnerClaim = await seedClaim(account, 'runner-host');
    const e1 = await send(account, { event: 'bind', client: 'claude', clientSessionId: sid(), workerId: runnerClaim.workerId }).catch(e => e);
    expect((e1 as LocalSessionError).code).toBe('not_interactive');

    const theirs = await seedClaim(other);
    const e2 = await send(account, { event: 'bind', client: 'claude', clientSessionId: sid(), workerId: theirs.workerId }).catch(e => e);
    expect((e2 as LocalSessionError).status).toBe(404);
  });
});

describe('a session holding several claims (its subagents each claimed one)', () => {
  test('both binds stick; exit releases both, each seat exactly once; a replay changes nothing', async () => {
    const s = sid();
    const one = await seedClaim(account);
    const two = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s, repo: 'acme/widget' });
    expect((await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: one.workerId })).outcome).toBe('bound');
    expect((await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: two.workerId })).outcome).toBe('bound');
    const held = await q<{ worker_id: string }>(sql`
      SELECT lsw.worker_id FROM local_session_workers lsw JOIN local_sessions ls ON ls.id = lsw.local_session_id
      WHERE ls.client_session_hash = ${hashClientSessionId('claude', s)}`);
    expect(held.map(r => r.worker_id).sort()).toEqual([one.workerId, two.workerId].sort());

    // Another session still cannot take either.
    const err = await send(account, { event: 'bind', client: 'claude', clientSessionId: sid(), workerId: two.workerId }).catch(e => e);
    expect((err as LocalSessionError).code).toBe('bound_elsewhere');

    // Activity lists both tasks under the one session.
    const view = (await listLocalSessions({ workspaceIds: [workspaceId] })).find(v => v.tasks.some(t => t.id === one.taskId));
    expect(view?.tasks.map(t => t.id).sort()).toEqual([one.taskId, two.taskId].sort());
    expect(view?.state).toBe('bound');

    const before = await seats(account);
    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('ended_released');
    expect(await taskStatus(one.taskId)).toBe('pending');
    expect(await taskStatus(two.taskId)).toBe('pending');
    expect(await workerStatus(one.workerId)).toBe('failed');
    expect(await workerStatus(two.workerId)).toBe('failed');
    expect(await seats(account)).toBe(before - 2);
    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('already_ended');
    expect(await seats(account)).toBe(before - 2);
  });

  test('one finished, one open: the finished task stays finished, the open one goes back', async () => {
    const s = sid();
    const done = await seedClaim(account);
    const open = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: done.workerId });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: open.workerId });
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${done.taskId}::uuid`);
    await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' });
    expect(await taskStatus(done.taskId)).toBe('completed');
    expect(await taskStatus(open.taskId)).toBe('pending');
  });

  test('a session bound before multi-claim (legacy column) still releases its worker, and keeps it from other sessions', async () => {
    const s = sid();
    const old = await seedClaim(account);
    const r = await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    // How a pre-migration bind left the row: the single legacy column, no join row.
    await q(sql`UPDATE local_sessions SET bound_worker_id = ${old.workerId}::uuid, bound_at = now() WHERE id = ${r.sessionId}::uuid`);
    const err = await send(account, { event: 'bind', client: 'claude', clientSessionId: sid(), workerId: old.workerId }).catch(e => e);
    expect((err as LocalSessionError).code).toBe('bound_elsewhere');
    // The same session can add a new claim next to it.
    const fresh = await seedClaim(account);
    expect((await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: fresh.workerId })).outcome).toBe('bound');
    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('ended_released');
    expect(await taskStatus(old.taskId)).toBe('pending');
    expect(await taskStatus(fresh.taskId)).toBe('pending');
  });
});

describe('session usage', () => {
  const m = (over: Record<string, unknown> = {}) => ({ model: 'claude-sonnet-5', input: 100, cacheRead: 10_000, cacheWrite5m: 1000, cacheWrite1h: 0, output: 500, requests: 4, ...over });
  const usage = (workerId: string, models = [m()]) => ({ workers: [{ workerId, models, toolCalls: 7, subagents: 1, firstAt: '2026-10-07T12:00:00.000Z', lastAt: '2026-10-07T12:04:00.000Z' }] });
  const row = async (workerId: string) => (await q<{ input_tokens: number; output_tokens: number; turns: number; cost_usd: string; result_meta: any }>(sql`
    SELECT input_tokens, output_tokens, turns, cost_usd::text, result_meta FROM workers WHERE id = ${workerId}::uuid`))[0];

  test('a touch records priced, cumulative usage on the held worker, and never lowers it', async () => {
    const s = sid();
    const { workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(workerId) } as LocalSessionEvent);
    const r = await row(workerId);
    expect(r.input_tokens).toBe(11_100);
    expect(r.output_tokens).toBe(500);
    expect(r.turns).toBe(4);
    expect(Number(r.cost_usd)).toBeCloseTo((100 * 2 + 10_000 * 0.2 + 1000 * 2.5 + 500 * 10) / 1e6, 6);
    expect(r.result_meta.modelUsage['claude-sonnet-5']).toMatchObject({ inputTokens: 100, outputTokens: 500, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 1000 });
    expect(r.result_meta.localSessionUsage).toMatchObject({ source: 'local-session', toolCalls: 7, subagents: 1, costUnknown: false });
    // No per-tool counts from this (older-shape) report: no histogram is written.
    expect(r.result_meta.toolCounts).toBeUndefined();
    // An older, smaller report (replayed or out of order) does not lower anything.
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(workerId, [m({ input: 1, cacheRead: 0, cacheWrite5m: 0, output: 1, requests: 1 })]) } as LocalSessionEvent);
    const again = await row(workerId);
    expect(again.input_tokens).toBe(11_100);
    expect(Number(again.cost_usd)).toBeCloseTo(Number(r.cost_usd), 6);
  });

  test('per-tool counts become the worker\'s tool histogram, the one usage stats read', async () => {
    const s = sid();
    const { workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    const u = usage(workerId);
    u.workers[0] = { ...u.workers[0], toolCounts: { Bash: 4, mcp__buildd__buildd: 3 } } as any;
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: u } as LocalSessionEvent);
    expect((await row(workerId)).result_meta.toolCounts).toEqual({ Bash: 4, mcp__buildd__buildd: 3 });
  });

  test('an unpriced model writes tokens but no cost, flagged unknown', async () => {
    const s = sid();
    const { workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(workerId, [m(), m({ model: 'other-vendor/unknown-model' })]) } as LocalSessionEvent);
    const r = await row(workerId);
    expect(Number(r.cost_usd)).toBe(0);
    expect(r.input_tokens).toBe(22_200);
    expect(r.result_meta.modelUsage).toBeUndefined();
    expect(r.result_meta.localSessionUsage).toMatchObject({ costUnknown: true, unpricedModels: ['other-vendor/unknown-model'] });
  });

  test("usage only reaches this session's own held workers, and a task finished long ago is left alone", async () => {
    const s = sid();
    const mine = await seedClaim(account);
    const notHeld = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId: mine.workerId });
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(notHeld.workerId) } as LocalSessionEvent);
    expect((await row(notHeld.workerId)).input_tokens).toBe(0);

    await q(sql`UPDATE workers SET status = 'completed', completed_at = now() - interval '1 hour' WHERE id = ${mine.workerId}::uuid`);
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(mine.workerId) } as LocalSessionEvent);
    expect((await row(mine.workerId)).input_tokens).toBe(0);
    // Just finished (complete_task, then the session's last report): still counted.
    await q(sql`UPDATE workers SET completed_at = now() - interval '2 minutes' WHERE id = ${mine.workerId}::uuid`);
    await send(account, { event: 'touch', client: 'claude', clientSessionId: s, usage: usage(mine.workerId) } as LocalSessionEvent);
    expect((await row(mine.workerId)).input_tokens).toBe(11_100);
  });

  test('end lands the final usage before releasing the worker', async () => {
    const s = sid();
    const { workerId, taskId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit', usage: usage(workerId) } as LocalSessionEvent);
    expect((await row(workerId)).input_tokens).toBe(11_100);
    expect(await taskStatus(taskId)).toBe('pending');
  });
});

describe('session end', () => {
  test('exit releases unfinished work back to pending, frees the seat once, and never completes it', async () => {
    const s = sid();
    const { taskId, workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    const before = await seats(account);

    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('ended_released');
    expect(await taskStatus(taskId)).toBe('pending');
    expect(await workerStatus(workerId)).toBe('failed');
    expect(await seats(account)).toBe(before - 1);

    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('already_ended');
    expect(await seats(account)).toBe(before - 1);
  });

  test('a finished task stays finished when its session ends', async () => {
    const s = sid();
    const { taskId, workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });
    await q(sql`UPDATE tasks SET status = 'completed' WHERE id = ${taskId}::uuid`);

    await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' });
    expect(await taskStatus(taskId)).toBe('completed');
  });

  test('/clear ends the presence but keeps the claim', async () => {
    const s = sid();
    const { taskId, workerId } = await seedClaim(account);
    await send(account, { event: 'start', client: 'claude', clientSessionId: s });
    await send(account, { event: 'bind', client: 'claude', clientSessionId: s, workerId });

    expect((await send(account, { event: 'end', client: 'claude', clientSessionId: s, reason: 'clear' })).outcome).toBe('ended_kept_claim');
    expect(await taskStatus(taskId)).toBe('in_progress');
    expect(await workerStatus(workerId)).toBe('running');
  });
});

describe('the Activity list', () => {
  test('a headless session is not listed until it claims work', async () => {
    // The list is per workspace: a presence gets one from its repo, or from the worker it binds.
    const person = sid();
    const headless = sid();
    const headlessWorking = sid();
    const a = await send(account, { event: 'start', client: 'claude', clientSessionId: person, repo: 'acme/widget', interactive: true });
    const b = await send(account, { event: 'start', client: 'claude', clientSessionId: headless, repo: 'acme/widget', interactive: false });
    const c = await send(account, { event: 'start', client: 'claude', clientSessionId: headlessWorking, interactive: false });
    const { workerId } = await seedClaim(account);
    await send(account, { event: 'bind', client: 'claude', clientSessionId: headlessWorking, workerId });

    const ids = (await listLocalSessions({ workspaceIds: [workspaceId] })).map(v => v.id);
    expect(ids).toContain(a.sessionId!);
    expect(ids).not.toContain(b.sessionId!);
    expect(ids).toContain(c.sessionId!);
  });
});

describe("a person's presence token, across teams", () => {
  // Team B's key made the claim (or OAuth did); the hooks hold the person's
  // presence token. The bind is decided by team membership and, when the claim
  // recorded one, by who made it, never by which account the hooks hold.
  let teamB: { teamId: string; workspaceId: string };
  let teamC: { teamId: string; workspaceId: string };
  let userId: string;
  let otherUserId: string;
  let token: string;
  let person: LocalSessionPerson;

  const seedUser = async () => {
    const email = `p-${Date.now().toString(36)}-${n++}@example.test`;
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${email}) RETURNING id`);
    return u.id;
  };
  /** A live interactive worker in `ws`, claimed with that team's key. */
  const claimIn = async (ws: { teamId: string; workspaceId: string }, claimUser: string | null = null) => {
    const acct = await seedAccount(ws.teamId);
    const taskId = await seedTask(ws.workspaceId, { status: 'in_progress' });
    await q(sql`UPDATE tasks SET claimed_by = ${acct.id}::uuid, claimed_at = now(),
      context = ${JSON.stringify(claimUser ? { interactiveClaimUserId: claimUser } : {})}::jsonb WHERE id = ${taskId}::uuid`);
    const [w] = await q<{ id: string }>(sql`
      INSERT INTO workers (workspace_id, account_id, task_id, name, runner, branch, status)
      VALUES (${ws.workspaceId}::uuid, ${acct.id}::uuid, ${taskId}::uuid, 'w', 'mcp', 'buildd/test', 'running') RETURNING id`);
    return { taskId, workerId: w.id };
  };
  const as = (e: LocalSessionEvent) => handleLocalSessionEvent(person, e);

  beforeAll(async () => {
    process.env.AUTH_SECRET ||= 'db-test-presence-token-secret';
    teamB = await seedWorkspace();
    teamC = await seedWorkspace();
    await q(sql`UPDATE workspaces SET repo = 'https://github.com/acme/team-b-repo' WHERE id = ${teamB.workspaceId}::uuid`);
    userId = await seedUser();
    otherUserId = await seedUser();
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamB.teamId}::uuid, ${userId}::uuid, 'member')`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamB.teamId}::uuid, ${otherUserId}::uuid, 'member')`);
    token = (await issuePresenceToken(userId, 'db-test-machine'))!;
    const p = await authenticatePresenceToken(token);
    person = { kind: 'user', userId: p!.userId, teamIds: p!.teamIds };
  });

  test('the token stores no secret and authenticates as the person, in the teams they are in', async () => {
    expect(token.startsWith('bldp_')).toBe(true);
    expect(person.teamIds).toContain(teamB.teamId);
    expect(person.teamIds).not.toContain(teamC.teamId);
    const [row] = await q<Record<string, unknown>>(sql`SELECT * FROM presence_tokens WHERE user_id = ${userId}::uuid`);
    expect(JSON.stringify(row)).not.toContain(token.split('.')[1]);
    expect(row.label).toBe('db-test-machine');
  });

  test("start is owned by the person, resolved to a workspace through any of their teams", async () => {
    const r = await as({ event: 'start', client: 'claude', clientSessionId: sid(), repo: 'acme/team-b-repo' });
    const [row] = await q<{ user_id: string; account_id: string | null; workspace_id: string }>(sql`
      SELECT user_id, account_id, workspace_id FROM local_sessions WHERE id = ${r.sessionId}::uuid`);
    expect(row).toEqual({ user_id: userId, account_id: null, workspace_id: teamB.workspaceId });
  });

  test("binds a worker claimed with team B's key, and its exit releases it", async () => {
    const s = sid();
    const { taskId, workerId } = await claimIn(teamB);
    await as({ event: 'start', client: 'claude', clientSessionId: s });
    expect((await as({ event: 'bind', client: 'claude', clientSessionId: s, workerId })).outcome).toBe('bound');
    expect((await as({ event: 'end', client: 'claude', clientSessionId: s, reason: 'exit' })).outcome).toBe('ended_released');
    expect(await taskStatus(taskId)).toBe('pending');
    expect(await workerStatus(workerId)).toBe('failed');
  });

  test('a claim the person made over OAuth (recorded on the task) binds', async () => {
    const s = sid();
    const { workerId } = await claimIn(teamB, userId);
    expect((await as({ event: 'bind', client: 'claude', clientSessionId: s, workerId })).outcome).toBe('bound');
  });

  test("refused as not found: a team they are not in, or a teammate's recorded claim", async () => {
    const elsewhere = await claimIn(teamC);
    const e1 = await as({ event: 'bind', client: 'claude', clientSessionId: sid(), workerId: elsewhere.workerId }).catch(e => e);
    expect(e1).toBeInstanceOf(LocalSessionError);
    expect((e1 as LocalSessionError).status).toBe(404);

    const teammates = await claimIn(teamB, otherUserId);
    const e2 = await as({ event: 'bind', client: 'claude', clientSessionId: sid(), workerId: teammates.workerId }).catch(e => e);
    expect((e2 as LocalSessionError).status).toBe(404);
  });

  test('a presence row must have exactly one owner', async () => {
    const err = await q(sql`INSERT INTO local_sessions (client_kind, client_session_hash) VALUES ('claude', 'no-owner')`).catch(e => e);
    // drizzle wraps the driver error; the constraint is named on its cause.
    const e = err as { message?: string; cause?: { message?: string; constraint?: string } };
    expect(`${e?.message} ${e?.cause?.message} ${e?.cause?.constraint}`).toMatch(/local_sessions_one_owner|check constraint/i);
  });

  test('a revoked token, or one whose person left every team, no longer authenticates', async () => {
    const t2 = (await issuePresenceToken(userId, 'second-machine'))!;
    expect(await authenticatePresenceToken(t2)).not.toBeNull();
    expect(await revokePresenceToken(t2)).toBe(true);
    expect(await authenticatePresenceToken(t2)).toBeNull();

    const loner = await seedUser();
    const t3 = (await issuePresenceToken(loner, 'laptop'))!;
    expect(await authenticatePresenceToken(t3)).toBeNull();
  });

  test('logging in again on the same machine revokes the previous token', async () => {
    const again = (await issuePresenceToken(userId, 'db-test-machine'))!;
    expect(await authenticatePresenceToken(token)).toBeNull();
    expect(await authenticatePresenceToken(again)).not.toBeNull();
  });
});
