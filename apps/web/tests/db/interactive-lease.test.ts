/**
 * Which interactive (claim_task) workers the reaper releases, against real
 * Postgres. The verdict is a WHERE clause over workers, local_sessions,
 * local_session_workers, tasks and team_members, run through the relational
 * query builder exactly as cleanupStaleWorkers runs it; a mocked `db` can only
 * check the SQL's shape, not what it selects.
 *
 * MCP silence, client presence, a running command and the claim are separate
 * signals. The regressions here are the owner's: a session idle for hours that
 * then ran one long silent command (no hook fires until it returns), the same
 * client after a reboot (gone, must still free up), and a `/clear` whose new
 * conversation's presence does not hold the claim.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { staleWorkerScope } from '@/lib/stale-workers';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function account(teamId: string): Promise<string> {
  const key = `k-${crypto.randomUUID()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type)
    VALUES ('user', ${key}, ${key}, ${teamId}::uuid, 'api') RETURNING id`);
  return a.id;
}

async function member(teamId: string): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'member')`);
  return u.id;
}

/** A live interactive claim last touched `quietHours` ago. */
async function claim(workspaceId: string, accountId: string, quietHours: number, claimUserId: string | null = null): Promise<string> {
  const taskId = await seedTask(workspaceId, { status: 'in_progress' });
  if (claimUserId) {
    await q(sql`UPDATE tasks SET context = jsonb_build_object('interactiveClaimUserId', ${claimUserId}::text) WHERE id = ${taskId}::uuid`);
  }
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workers (workspace_id, task_id, account_id, name, runner, branch, status, updated_at)
    VALUES (${workspaceId}::uuid, ${taskId}::uuid, ${accountId}::uuid, 'interactive', 'mcp', 'b', 'running', ${hoursAgo(quietHours).toISOString()}::timestamptz)
    RETURNING id`);
  return w.id;
}

async function presence(opts: {
  workspaceId: string;
  accountId?: string;
  userId?: string;
  lastSeenHours: number;
  busy?: boolean;
  ended?: 'clear' | 'exit';
  holds?: string[];
}): Promise<string> {
  const [p] = await q<{ id: string }>(sql`
    INSERT INTO local_sessions (account_id, user_id, workspace_id, client_kind, client_session_hash, last_seen_at, busy_since, ended_at, end_reason)
    VALUES (
      ${opts.accountId ?? null}::uuid, ${opts.userId ?? null}::uuid, ${opts.workspaceId}::uuid, 'claude', ${crypto.randomUUID()},
      ${hoursAgo(opts.lastSeenHours).toISOString()}::timestamptz,
      ${opts.busy ? hoursAgo(opts.lastSeenHours).toISOString() : null}::timestamptz,
      ${opts.ended ? NOW.toISOString() : null}::timestamptz, ${opts.ended ?? null}
    ) RETURNING id`);
  for (const w of opts.holds ?? []) {
    await q(sql`INSERT INTO local_session_workers (worker_id, local_session_id) VALUES (${w}::uuid, ${p.id}::uuid)`);
  }
  return p.id;
}

/** What the reaper's section 1 selects for this account, through the same builder it uses. */
async function reaped(accountId: string): Promise<string[]> {
  const rows = await db.query.workers.findMany({ where: staleWorkerScope(accountId, NOW), columns: { id: true } });
  return rows.map(r => r.id);
}

beforeAll(() => assertDbConfigured());

describe('interactive lease: the reaper hears the client, not just MCP', () => {
  test('MCP-silent 3 h, but its session is inside one long command: kept', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    // Idle for hours, then a prompt and a long command: the PreToolUse mark
    // is the last thing heard, 2.5 h ago.
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId, accountId: acct, lastSeenHours: 2.5, busy: true, holds: [w] });
    expect(await reaped(acct)).not.toContain(w);
  });

  test('the same session after a reboot (mid-turn, never cleared): released at the backstop', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    const w = await claim(workspaceId, acct, 9);
    await presence({ workspaceId, accountId: acct, lastSeenHours: 9, busy: true, holds: [w] });
    expect(await reaped(acct)).toContain(w);
  });

  test('a client gone after a reboot, not mid-turn: released after the idle TTL', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId, accountId: acct, lastSeenHours: 3, holds: [w] });
    expect(await reaped(acct)).toContain(w);
  });

  test('an ended presence never keeps a claim, busy or not', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId, accountId: acct, lastSeenHours: 0, busy: true, ended: 'exit', holds: [w] });
    expect(await reaped(acct)).toContain(w);
  });

  test('/clear then continue: the new conversation holds nothing, yet its client is alive in that workspace: kept, up to the backstop', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId, accountId: acct, lastSeenHours: 3, ended: 'clear', holds: [w] });
    await presence({ workspaceId, accountId: acct, lastSeenHours: 0 });
    expect(await reaped(acct)).not.toContain(w);

    const stale = await claim(workspaceId, acct, 9);
    expect(await reaped(acct)).toContain(stale);
  });

  test("another team's live session in the same workspace keeps nothing", async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const other = await seedWorkspace();
    const acct = await account(teamId);
    const stranger = await account(other.teamId);
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId, accountId: stranger, lastSeenHours: 0 });
    await presence({ workspaceId, userId: await member(other.teamId), lastSeenHours: 0 });
    expect(await reaped(acct)).toContain(w);
  });

  test("a person's presence (presence token) keeps their team's claim only when the claim is theirs or names nobody", async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const acct = await account(teamId);
    const me = await member(teamId);
    const teammate = await member(teamId);
    const unnamed = await claim(workspaceId, acct, 3);
    const mine = await claim(workspaceId, acct, 3, me);
    const theirs = await claim(workspaceId, acct, 3, teammate);
    await presence({ workspaceId, userId: me, lastSeenHours: 0 });
    const out = await reaped(acct);
    expect(out).not.toContain(unnamed);
    expect(out).not.toContain(mine);
    expect(out).toContain(theirs);
  });

  test('a live session in a different workspace keeps nothing', async () => {
    const { teamId, workspaceId } = await seedWorkspace();
    const [elsewhere] = await q<{ id: string }>(sql`INSERT INTO workspaces (name, team_id) VALUES (${`w-${crypto.randomUUID()}`}, ${teamId}::uuid) RETURNING id`);
    const acct = await account(teamId);
    const w = await claim(workspaceId, acct, 3);
    await presence({ workspaceId: elsewhere.id, accountId: acct, lastSeenHours: 0 });
    expect(await reaped(acct)).toContain(w);
  });
});
