/**
 * Which account an OAuth session acts as, against real Postgres.
 *
 * A team can hold several `type='user'` accounts (one per CLI or device login,
 * plus the one /api/oauth/token provisions). A session resolves to one of them,
 * and that id is what the claim stamps on workers.account_id and what
 * PATCH /api/workers/[id] compares against. Resolved with no ORDER BY, the row
 * is whatever Postgres returns first, which moves as rows are updated, so the
 * same token could claim as one account and report progress as another. The
 * order is the whole invariant here, and a mocked `db` cannot see it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { findTeamSessionAccount } from '@/lib/oauth/session-account';
import { assertDbConfigured, q, seedWorkspace } from './harness';

async function account(teamId: string, opts: { type?: string; createdAt?: string } = {}): Promise<string> {
  const key = `k-${crypto.randomUUID()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, auth_type, created_at)
    VALUES (${opts.type ?? 'user'}, ${key}, ${key}, ${teamId}::uuid, 'oauth', COALESCE(${opts.createdAt ?? null}::timestamptz, now()))
    RETURNING id`);
  return a.id;
}

beforeAll(() => assertDbConfigured());

describe('findTeamSessionAccount', () => {
  test('always the oldest user account in the team, whatever the physical row order', async () => {
    const { teamId } = await seedWorkspace();
    // Inserted first, so it is the row an unordered read tends to return.
    const newer = await account(teamId);
    const oldest = await account(teamId, { createdAt: '2020-01-01T00:00:00Z' });
    await account(teamId, { type: 'service', createdAt: '2019-01-01T00:00:00Z' });

    for (let i = 0; i < 3; i++) {
      expect((await findTeamSessionAccount(teamId))?.id).toBe(oldest);
      // Every authenticated call writes last_used_at; each update moves the row.
      await q(sql`UPDATE accounts SET last_used_at = now() WHERE id = ${oldest}::uuid`);
      await q(sql`UPDATE accounts SET last_used_at = now() WHERE id = ${newer}::uuid`);
    }
  });

  test('a tie on created_at is broken by id, never by physical order', async () => {
    const { teamId } = await seedWorkspace();
    const at = '2021-06-01T00:00:00Z';
    const ids = [await account(teamId, { createdAt: at }), await account(teamId, { createdAt: at })];
    const expected = [...ids].sort()[0];
    expect((await findTeamSessionAccount(teamId))?.id).toBe(expected);
    await q(sql`UPDATE accounts SET last_used_at = now() WHERE id = ${expected}::uuid`);
    expect((await findTeamSessionAccount(teamId))?.id).toBe(expected);
  });

  test('no user account in the team is null, never another team\'s', async () => {
    const { teamId } = await seedWorkspace();
    const other = await seedWorkspace();
    await account(other.teamId);
    await account(teamId, { type: 'service' });
    expect(await findTeamSessionAccount(teamId)).toBeNull();
  });
});
