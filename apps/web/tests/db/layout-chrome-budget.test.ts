/**
 * What every page shares (Living Spec "Fast at any size": R-17, R-23) on a
 * real database: the shell's teams and workspaces, and the questions waiting
 * on the user.
 *
 * R-17: at most two database queries, scoped to the user's teams in the query
 * itself, cached for at least 30 s: a second load reads nothing.
 * R-23: another tenant's waiting worker is never read, not merely filtered out.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { recordNeonQueries } from '@buildd/core/db';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

assertDbConfigured();

const { loadAppChromeUncached, clearAppChromeCache } = await import('../../src/lib/app-chrome');
const { loadWaitingInput, clearWaitingInputCache } = await import('../../src/lib/waiting-input');

let userId: string;
let mine: { teamId: string; workspaceId: string };
let theirs: { teamId: string; workspaceId: string };
let myTask: string;
let theirTask: string;

async function seedUser(teamId: string): Promise<string> {
  const [u] = await q<{ id: string }>(sql`
    INSERT INTO users (email, name) VALUES (${`chrome-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`}, 'Chrome') RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'owner')`);
  return u.id;
}

async function seedWaiting(workspaceId: string, taskId: string): Promise<void> {
  await q(sql`
    INSERT INTO workers (task_id, workspace_id, name, runner, branch, status, waiting_for)
    VALUES (${taskId}::uuid, ${workspaceId}::uuid, 'w', 'r', 'buildd/x', 'waiting_input',
      ${JSON.stringify({ type: 'question', prompt: 'Which plan?', disposition: 'ask' })}::jsonb)`);
}

beforeAll(async () => {
  mine = await seedWorkspace();
  theirs = await seedWorkspace();
  userId = await seedUser(mine.teamId);
  await seedUser(theirs.teamId);
  myTask = await seedTask(mine.workspaceId, { status: 'in_progress', title: 'mine' });
  theirTask = await seedTask(theirs.workspaceId, { status: 'in_progress', title: 'theirs' });
  await seedWaiting(mine.workspaceId, myTask);
  await seedWaiting(theirs.workspaceId, theirTask);
});

beforeEach(() => {
  clearAppChromeCache();
  clearWaitingInputCache();
});

describe('the shell (lib/app-chrome.ts)', () => {
  it('cold: two statements in one round trip, and only this user\'s teams and workspaces', async () => {
    const rec = await recordNeonQueries(() => loadAppChromeUncached(userId, null));
    expect(rec.count).toBeLessThanOrEqual(1);
    expect(rec.statements).toBeLessThanOrEqual(2);
    const chrome = await loadAppChromeUncached(userId, null);
    expect(chrome.teams.map(t => t.id)).toEqual([mine.teamId]);
    expect(chrome.workspaceIds).toEqual([mine.workspaceId]);
    expect(chrome.scope.teamId).toBe(mine.teamId);
    expect(chrome.role).toBe('owner');
  });

  it('warm: reads nothing', async () => {
    await loadAppChromeUncached(userId, null);
    const rec = await recordNeonQueries(() => loadAppChromeUncached(userId, null));
    expect(rec.count).toBe(0);
  });

  it('a cookie naming a team the user is not in does not reach that team', async () => {
    const chrome = await loadAppChromeUncached(userId, theirs.teamId);
    expect(chrome.scope.teamId).toBe(mine.teamId);
  });
});

describe('questions waiting (lib/waiting-input.ts)', () => {
  it("reads only this user's tenants: the other team's waiting worker is never returned", async () => {
    const rows = await loadWaitingInput(userId);
    expect(rows.map(r => r.id)).toEqual([myTask]);
  });

  it('cold: at most two queries; warm: none; fresh reads again', async () => {
    const cold = await recordNeonQueries(() => loadWaitingInput(userId));
    expect(cold.count).toBeLessThanOrEqual(2);
    const warm = await recordNeonQueries(() => loadWaitingInput(userId));
    expect(warm.count).toBe(0);
    const fresh = await recordNeonQueries(() => loadWaitingInput(userId, { fresh: true }));
    expect(fresh.count).toBeGreaterThan(0);
  });
});
