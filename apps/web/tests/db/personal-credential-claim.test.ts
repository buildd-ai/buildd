/**
 * The claim's personal-credential decision against real Postgres
 * (apps/web/src/app/api/workers/claim/personal-credential-injection.ts), with
 * its real reads: the team's `credential_policy`, the task's requester walk
 * (`resolveTaskRequesterUserId`) and the provider resolver.
 *
 * The property: a personal key reaches only a task whose requester owns it,
 * only when the team explicitly chose a personal policy, and a NULL policy
 * never reads a personal row at all. Route tests mock `db`, which hides every
 * WHERE; this runs the same decision on real rows.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { encrypt } from '@buildd/core/secrets';
import {
  PERSONAL_CREDENTIAL_RUNNER_FEATURE,
  decidePersonalCredential,
  perRequestPersonalCredentialDeps,
  type PersonalCredentialInput,
} from '@/app/api/workers/claim/personal-credential-injection';
import { assertDbConfigured, q, seedWorkspace } from './harness';

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  process.env.ENCRYPTION_KEY = 'personal-credential-claim-db-test-key-0123456789';
}

async function user(): Promise<string> {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${crypto.randomUUID()}@example.test`}) RETURNING id`);
  return u.id;
}

async function account(teamId: string): Promise<string> {
  const k = `k-${crypto.randomUUID()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id) VALUES ('service', ${k}, ${k}, ${teamId}::uuid) RETURNING id`);
  return a.id;
}

async function secret(teamId: string, o: { purpose: string; label?: string | null; value: string; userId?: string | null }) {
  await q(sql`
    INSERT INTO secrets (team_id, purpose, label, encrypted_value, user_id)
    VALUES (${teamId}::uuid, ${o.purpose}, ${o.label ?? null}, ${encrypt(o.value)}, ${o.userId ?? null}::uuid)`);
}

async function task(workspaceId: string, o: { createdBy?: string | null; parent?: string | null } = {}): Promise<string> {
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, created_by_user_id, parent_task_id)
    VALUES (${workspaceId}::uuid, ${`t-${crypto.randomUUID()}`}, 'pending', ${o.createdBy ?? null}::uuid, ${o.parent ?? null}::uuid)
    RETURNING id`);
  return t.id;
}

async function setPolicy(teamId: string, policy: string | null) {
  await q(sql`UPDATE teams SET credential_policy = ${policy}, inference_key_policy = 'own' WHERE id = ${teamId}::uuid`);
}

let teamId: string, W: string, A: string, alice: string, bob: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId: W } = await seedWorkspace());
  A = await account(teamId);
  [alice, bob] = [await user(), await user()];
  await secret(teamId, { purpose: 'anthropic_api_key', value: 'TEAM-ANTHROPIC' });
  await secret(teamId, { purpose: 'inference_key', label: 'anthropic', value: 'ALICE-ANTHROPIC', userId: alice });
  await secret(teamId, { purpose: 'inference_key', label: 'openai', value: 'ALICE-OPENAI', userId: alice });
  await secret(teamId, { purpose: 'inference_key', label: 'anthropic', value: 'BOB-ANTHROPIC', userId: bob });
});

async function decide(taskId: string, over: Partial<PersonalCredentialInput> = {}, backend = 'claude') {
  const [row] = await q<{ id: string; created_by_user_id: string | null; parent_task_id: string | null; mission_id: string | null }>(
    sql`SELECT id, created_by_user_id, parent_task_id, mission_id FROM tasks WHERE id = ${taskId}::uuid`);
  return decidePersonalCredential({
    task: { id: row.id, backend, createdByUserId: row.created_by_user_id, parentTaskId: row.parent_task_id, missionId: row.mission_id },
    teamId, workspaceId: W, accountId: A,
    runnerFeatures: [PERSONAL_CREDENTIAL_RUNNER_FEATURE], cloud: false, interactive: false,
    ...over,
  }, perRequestPersonalCredentialDeps());
}

describe('personal credential decision on real rows', () => {
  test('credential_policy NULL: legacy for everyone, even Alice with a key and the legacy column at own', async () => {
    await setPolicy(teamId, null);
    expect(await decide(await task(W, { createdBy: alice }))).toEqual({ kind: 'legacy' });
  });

  test('personal_first: Alice gets her own key, Bob gets his, never each other\'s', async () => {
    await setPolicy(teamId, 'personal_first');
    const a = await decide(await task(W, { createdBy: alice }));
    const b = await decide(await task(W, { createdBy: bob }));
    expect(a.kind === 'personal' && a.value).toBe('ALICE-ANTHROPIC');
    expect(b.kind === 'personal' && b.value).toBe('BOB-ANTHROPIC');
  });

  test('personal_first: a Codex task of Alice\'s gets her OpenAI key; Bob (no OpenAI key) falls back to team', async () => {
    await setPolicy(teamId, 'personal_first');
    const a = await decide(await task(W, { createdBy: alice }), {}, 'codex');
    expect(a.kind === 'personal' && a.value).toBe('ALICE-OPENAI');
    expect((await decide(await task(W, { createdBy: bob }), {}, 'codex')).kind).toBe('legacy');
  });

  test('a fix task with no author inherits its parent\'s requester, and only theirs', async () => {
    await setPolicy(teamId, 'personal_first');
    const parent = await task(W, { createdBy: bob });
    const child = await task(W, { parent });
    const d = await decide(child);
    expect(d.kind === 'personal' && d.value).toBe('BOB-ANTHROPIC');
  });

  test('personal_first, team work (no requester anywhere): team credentials, no personal key', async () => {
    await setPolicy(teamId, 'personal_first');
    const d = await decide(await task(W));
    expect(d.kind).toBe('legacy');
    expect(JSON.stringify(d)).not.toContain('ANTHROPIC');
  });

  test('personal_only: no requester or no key refuses; the team key is never the answer', async () => {
    await setPolicy(teamId, 'personal_only');
    expect(await decide(await task(W))).toMatchObject({ kind: 'refuse', detail: { cause: 'no_requester' } });
    const carol = await user();
    expect(await decide(await task(W, { createdBy: carol }))).toMatchObject({ kind: 'refuse', detail: { cause: 'requester_has_no_key' } });
    const a = await decide(await task(W, { createdBy: alice }));
    expect(a.kind === 'personal' && a.value).toBe('ALICE-ANTHROPIC');
  });
});
