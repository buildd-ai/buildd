/**
 * The unified provider resolver against real Postgres
 * (packages/core/providers/resolve.ts).
 *
 * Which rows the one query can return is the safety property: a personal row
 * only when it is the requester's own and the policy can use one, never a row
 * of another team, workspace or account. A mocked db sees none of that, so the
 * predicate and the end-to-end resolve run here on real rows.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { encrypt } from '@buildd/core/secrets';
import { providerCredentialWhere, resolveProviderCredential } from '@buildd/core/providers/resolve';
import { assertDbConfigured, q, seedWorkspace } from './harness';

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
  process.env.ENCRYPTION_KEY = 'provider-resolve-db-test-key-0123456789abcdef';
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

async function workspaceIn(teamId: string): Promise<string> {
  const [w] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id) VALUES (${`w-${crypto.randomUUID()}`}, ${teamId}::uuid) RETURNING id`);
  return w.id;
}

async function secret(teamId: string, opts: {
  purpose: string; label?: string | null; value: string;
  workspaceId?: string | null; accountId?: string | null; userId?: string | null;
}): Promise<string> {
  const [s] = await q<{ id: string }>(sql`
    INSERT INTO secrets (team_id, purpose, label, encrypted_value, workspace_id, account_id, user_id)
    VALUES (${teamId}::uuid, ${opts.purpose}, ${opts.label ?? null}, ${encrypt(opts.value)},
      ${opts.workspaceId ?? null}::uuid, ${opts.accountId ?? null}::uuid, ${opts.userId ?? null}::uuid)
    RETURNING id`);
  return s.id;
}

async function setPolicy(teamId: string, credentialPolicy: string | null, inferenceKeyPolicy = 'team_or_own') {
  await q(sql`UPDATE teams SET credential_policy = ${credentialPolicy}, inference_key_policy = ${inferenceKeyPolicy} WHERE id = ${teamId}::uuid`);
}

interface Fixture {
  teamId: string; W: string; W2: string; A: string; A2: string; U: string; U2: string;
  ids: Record<'team' | 'ws' | 'otherWs' | 'acct' | 'otherAcct' | 'mine' | 'theirs' | 'otherTeam', string>;
}

async function fixture(): Promise<Fixture> {
  const { teamId, workspaceId: W } = await seedWorkspace();
  const other = await seedWorkspace();
  const W2 = await workspaceIn(teamId);
  const [A, A2, U, U2] = [await account(teamId), await account(teamId), await user(), await user()];
  const key = (o: Partial<Parameters<typeof secret>[1]> & { value: string }) =>
    secret(teamId, { purpose: 'inference_key', label: 'anthropic', ...o });
  const ids = {
    team: await key({ value: 'TEAM' }),
    ws: await key({ value: 'WS', workspaceId: W }),
    otherWs: await key({ value: 'OTHERWS', workspaceId: W2 }),
    acct: await key({ value: 'ACCT', accountId: A }),
    otherAcct: await key({ value: 'OTHERACCT', accountId: A2 }),
    mine: await key({ value: 'MINE', userId: U }),
    theirs: await key({ value: 'THEIRS', userId: U2 }),
    otherTeam: await secret(other.teamId, { purpose: 'inference_key', label: 'anthropic', value: 'OTHERTEAM' }),
  };
  return { teamId, W, W2, A, A2, U, U2, ids };
}

async function matched(where: ReturnType<typeof providerCredentialWhere>): Promise<string[]> {
  const rows = await db.select({ id: secrets.id }).from(secrets).where(where);
  return rows.map(r => r.id).sort();
}

let f: Fixture;
beforeAll(async () => {
  assertDbConfigured();
  f = await fixture();
});

describe('providerCredentialWhere on real rows', () => {
  const base = () => ({ teamId: f.teamId, workspaceId: f.W, purposes: ['inference_key'] });

  test('agent shape: this workspace, this account, the requester’s own row, nothing else', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), accountId: f.A, requesterUserId: f.U, personalAllowed: true, legacyAccountRows: false })))
      .toEqual([f.ids.team, f.ids.ws, f.ids.acct, f.ids.mine].sort());
  });

  test('personal rows are unreachable when the policy cannot use one', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), accountId: f.A, requesterUserId: f.U, personalAllowed: false, legacyAccountRows: false })))
      .toEqual([f.ids.team, f.ids.ws, f.ids.acct].sort());
  });

  test('no requester ⇒ no personal row, even when the policy would allow one', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), accountId: f.A, requesterUserId: null, personalAllowed: true, legacyAccountRows: false })))
      .toEqual([f.ids.team, f.ids.ws, f.ids.acct].sort());
  });

  test('agent with no account reads no account-scoped row', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), accountId: null, requesterUserId: null, personalAllowed: false, legacyAccountRows: false })))
      .toEqual([f.ids.team, f.ids.ws].sort());
  });

  test('chat with no account still sees legacy account rows; never another person or workspace', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), accountId: null, requesterUserId: f.U2, personalAllowed: true, legacyAccountRows: true })))
      .toEqual([f.ids.team, f.ids.ws, f.ids.acct, f.ids.otherAcct, f.ids.theirs].sort());
  });

  test('no workspace ⇒ team-wide rows only', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), workspaceId: null, accountId: null, requesterUserId: null, personalAllowed: false, legacyAccountRows: false })))
      .toEqual([f.ids.team]);
  });

  test('an empty purpose list matches nothing', async () => {
    expect(await matched(providerCredentialWhere({ ...base(), purposes: [], accountId: f.A, requesterUserId: f.U, personalAllowed: true, legacyAccountRows: false })))
      .toEqual([]);
  });
});

describe('resolveProviderCredential end to end', () => {
  const input = (over: Partial<Parameters<typeof resolveProviderCredential>[0]> = {}) => ({
    teamId: f.teamId, workspaceId: f.W, accountId: f.A, requesterUserId: f.U,
    surface: 'agent-claude' as const, provider: 'anthropic' as const, ...over,
  });

  test('agent, credential_policy NULL: team scopes only, even with a requester and inference policy own', async () => {
    await setPolicy(f.teamId, null, 'own');
    const r = await resolveProviderCredential(input());
    expect(r.source?.secretId).toBe(f.ids.ws);
    expect(r.credential?.value).toBe('WS');
    expect(r.why.join('\n')).not.toMatch(/\b(WS|MINE|TEAM|ACCT)\b/);
  });

  test('agent, personal_first: the requester’s own credential; another requester falls back to the team’s', async () => {
    await setPolicy(f.teamId, 'personal_first');
    expect((await resolveProviderCredential(input())).source?.secretId).toBe(f.ids.mine);
    const someoneElse = await resolveProviderCredential(input({ requesterUserId: (await user()) }));
    expect(someoneElse.source?.secretId).toBe(f.ids.ws);
    expect((await resolveProviderCredential(input({ requesterUserId: null }))).source?.secretId).toBe(f.ids.ws);
  });

  test('agent, personal_only: only the requester’s own; none (no_personal_credential) without a requester', async () => {
    await setPolicy(f.teamId, 'personal_only');
    expect((await resolveProviderCredential(input())).credential?.value).toBe('MINE');
    const none = await resolveProviderCredential(input({ requesterUserId: null }));
    expect(none.none).toBe(true);
    if (none.none) expect(none.reason).toBe('no_personal_credential');
  });

  test('chat follows inference_key_policy while credential_policy is NULL', async () => {
    await setPolicy(f.teamId, null, 'team');
    const team = await resolveProviderCredential(input({ surface: 'chat', accountId: null }));
    expect(team.source?.secretId).toBe(f.ids.ws);
    await setPolicy(f.teamId, null, 'team_or_own');
    const own = await resolveProviderCredential(input({ surface: 'chat', accountId: null }));
    expect(own.source?.secretId).toBe(f.ids.mine);
  });

  test('another team’s row is never resolved', async () => {
    await setPolicy(f.teamId, null);
    const r = await resolveProviderCredential(input({ workspaceId: null, accountId: null, requesterUserId: null }));
    expect(r.source?.secretId).toBe(f.ids.team);
  });
});
