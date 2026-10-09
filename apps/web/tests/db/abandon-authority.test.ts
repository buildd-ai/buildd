/**
 * Who may mark a closed, unmerged PR abandoned (T21, docs/specs/workflow-state-kernel.md).
 *
 * Abandon is a person's call. The mission card's closed-PR route gives the
 * kernel a `human:` actor only for a dashboard session or the person's own
 * OAuth session; an API key is never a person, whatever its level, and is
 * refused before the kernel is asked. `recordPrAbandonment` refuses any
 * non-person actor on its own, so no other caller can mint one either.
 *
 * Real kernel, real Postgres and the stateful fake GitHub.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { world, type World } from './workflow-scenarios-world';
import { q, seedMission } from './harness';

let sessionUser: { id: string; email: string } | null = null;
const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => sessionUser }));

process.env.AUTH_SECRET ||= 'abandon-authority-test-secret-0123456789';
const closedPrsRoute = await import('../../src/app/api/missions/[id]/closed-prs/route');
const { recordPrAbandonment } = await import('../../src/lib/pr-supersession');
const { mintTaskToken } = await import('../../src/lib/task-token');
const { authenticateTaskScopedCaller } = await import('../../src/lib/task-token-auth');
const { authenticateApiKey } = await import('../../src/lib/api-auth');
const { requestingPerson } = await import('../../src/lib/request-person');

let w: World;
afterEach(() => { w?.dispose(); sessionUser = null; });

async function adminKey(teamId: string): Promise<{ id: string; key: string; hash: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level) VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hash}, ${teamId}::uuid, 'admin') RETURNING id`);
  return { id: a.id, key, hash };
}

/** A kernel-owned PR, closed without merging, whose owner task sits in a mission. */
async function closedPrInMission(w: World) {
  const pr = await w.openPr({ branch: `feat/abandon-${Math.random().toString(36).slice(2, 8)}`, files: { 'src/a.ts': 'export const a = 2;\n' } });
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
  const missionId = await seedMission(ws.team_id, w.workspaceId);
  await q(sql`UPDATE tasks SET mission_id = ${missionId}::uuid WHERE id = ${pr.ownerTaskId}::uuid`);
  w.gh.closePr(w.repo, pr.prNumber);
  await w.deliver();
  expect((await w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
  return { pr, missionId, teamId: ws.team_id };
}

function abandon(missionId: string, taskId: string, headers: Record<string, string> = {}) {
  return closedPrsRoute.POST(new NextRequest(`http://localhost/api/missions/${missionId}/closed-prs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ taskId, action: 'abandon', reason: 'plan changed' }),
  }) as never, { params: Promise.resolve({ id: missionId }) });
}

describe('marking a PR abandoned is a person\'s call', () => {
  test('an admin API key cannot abandon: refused, and the delivery stays closed unmerged', async () => {
    w = await world();
    const { pr, missionId, teamId } = await closedPrInMission(w);
    const key = await adminKey(teamId);

    const res = await abandon(missionId, pr.ownerTaskId, { authorization: `Bearer ${key.key}` });
    expect(res.status).toBe(403);
    expect((await w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
    expect(await w.commands(pr)).not.toContain('Abandon');
    const [row] = await q<{ abandoned_at: string | null }>(sql`SELECT abandoned_at FROM workers WHERE id = ${pr.workerId}::uuid`);
    expect(row.abandoned_at).toBeNull();
  }, 60_000);

  test('an agent actor is refused by the write itself, never reaching the kernel', async () => {
    w = await world();
    const { pr } = await closedPrInMission(w);
    for (const actor of ['agent:some-account', 'runner', 'svc-key']) {
      const r = await recordPrAbandonment({ workerId: pr.workerId, reason: 'plan changed', recordedBy: 'svc-key', actor });
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
    expect((await w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
    expect(await w.commands(pr)).not.toContain('Abandon');
  }, 60_000);

  test('a signed-in team member abandons it as that person', async () => {
    w = await world();
    const { pr, missionId, teamId } = await closedPrInMission(w);
    const email = `owner-${crypto.randomUUID()}@example.test`;
    const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${email}) RETURNING id`);
    await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, 'owner')`);
    sessionUser = { id: u.id, email };

    const res = await abandon(missionId, pr.ownerTaskId);
    expect(res.status).toBe(200);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ABANDONED', stateReason: 'plan changed' });
    const [t] = await q<{ evidence: { actor?: string } }>(sql`
      SELECT evidence FROM workflow_transitions WHERE delivery_id = ${pr.deliveryId}::uuid AND command = 'Abandon'`);
    expect(t.evidence.actor).toBe(`human:${u.id}`);
  }, 60_000);
});

// Runner-launched agents authenticate with a per-task token (or, on fallback, the
// runner's buildd key). Neither ever resolves to a person, so an agent always acts
// as `agent:`. Only an interactive OAuth session carries `sessionUserId`.
describe('a runner agent\'s credentials never resolve to a person', () => {
  test('a per-task token and the runner key both authenticate with no session user, and cannot abandon', async () => {
    w = await world();
    const { pr, missionId, teamId } = await closedPrInMission(w);
    const runner = await adminKey(teamId);
    const minted = mintTaskToken({ accountId: runner.id, taskId: pr.ownerTaskId, workspaceId: w.workspaceId, keyHash: runner.hash });
    if (!minted) throw new Error('could not mint a task token');

    const viaToken = await authenticateTaskScopedCaller(minted.token);
    expect(viaToken).not.toBeNull();
    expect((viaToken as { sessionUserId?: unknown }).sessionUserId).toBeUndefined();
    expect(requestingPerson(null, viaToken)).toBeNull();

    const viaKey = await authenticateApiKey(runner.key);
    expect(viaKey).not.toBeNull();
    expect((viaKey as { sessionUserId?: unknown }).sessionUserId).toBeUndefined();
    expect(requestingPerson(null, viaKey)).toBeNull();

    // The closed-PR route takes no per-task token at all.
    expect((await abandon(missionId, pr.ownerTaskId, { authorization: `Bearer ${minted.token}` })).status).toBe(401);
    expect((await w.delivery(pr)).state).toBe('CLOSED_UNMERGED');
  }, 60_000);
});
