/**
 * The creator-key clamp against real Postgres.
 *
 * When a person is demoted below manage_team_keys, removed, or leaves, the keys
 * they minted in that team drop to worker level and lose admin-grant scopes
 * (lib/creator-key-clamp.ts). Which rows that touches is the whole invariant:
 * only this team, only this creator, never a NULL-creator key, never raised,
 * and the returned count is exactly the keys that changed. A mocked db sees
 * none of that.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { creatorKeyClampStatement } from '@/lib/creator-key-clamp';
import { assertDbConfigured, q, seedWorkspace } from './harness';

async function user(): Promise<string> {
  const email = `u-${crypto.randomUUID()}@example.test`;
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${email}) RETURNING id`);
  return u.id;
}

async function key(teamId: string, opts: { level: string; scopes?: string[] | null; createdBy: string | null }): Promise<string> {
  const k = `k-${crypto.randomUUID()}`;
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level, scopes, created_by_user_id)
    VALUES ('service', ${k}, ${k}, ${teamId}::uuid, ${opts.level},
      ${opts.scopes == null ? null : JSON.stringify(opts.scopes)}::jsonb, ${opts.createdBy}::uuid)
    RETURNING id`);
  return a.id;
}

async function read(id: string): Promise<{ level: string; scopes: string[] | null }> {
  const [r] = await q<{ level: string; scopes: string[] | null }>(sql`SELECT level, scopes FROM accounts WHERE id = ${id}::uuid`);
  return r;
}

beforeAll(() => assertDbConfigured());

describe('creatorKeyClampStatement', () => {
  test('lowers admin keys to worker and strips admin-grant scopes, keeping the rest in order', async () => {
    const { teamId } = await seedWorkspace();
    const person = await user();
    const legacyAdmin = await key(teamId, { level: 'admin', createdBy: person });
    const scopedAdmin = await key(teamId, { level: 'admin', scopes: ['tasks:read', 'admin', 'workers:write'], createdBy: person });
    const workerWithAdminScope = await key(teamId, { level: 'worker', scopes: ['secrets', 'tasks:write', 'missions:admin', 'releases', 'schedules:write'], createdBy: person });

    const rows = await creatorKeyClampStatement(teamId, person);

    expect(rows.map(r => r.id).sort()).toEqual([legacyAdmin, scopedAdmin, workerWithAdminScope].sort());
    expect(await read(legacyAdmin)).toEqual({ level: 'worker', scopes: null });
    expect(await read(scopedAdmin)).toEqual({ level: 'worker', scopes: ['tasks:read', 'workers:write'] });
    expect(await read(workerWithAdminScope)).toEqual({ level: 'worker', scopes: ['tasks:write'] });
  });

  test('an admin-only scoped key ends with an empty scope list, not NULL (NULL would mean legacy)', async () => {
    const { teamId } = await seedWorkspace();
    const person = await user();
    const k = await key(teamId, { level: 'admin', scopes: ['admin'], createdBy: person });
    await creatorKeyClampStatement(teamId, person);
    expect(await read(k)).toEqual({ level: 'worker', scopes: [] });
  });

  test('never touches keys already inside the ceiling, and never raises one', async () => {
    const { teamId } = await seedWorkspace();
    const person = await user();
    const trigger = await key(teamId, { level: 'trigger', createdBy: person });
    const worker = await key(teamId, { level: 'worker', scopes: ['tasks:read', 'workers:write'], createdBy: person });
    const legacyWorker = await key(teamId, { level: 'worker', createdBy: person });

    const rows = await creatorKeyClampStatement(teamId, person);

    expect(rows).toHaveLength(0);
    expect(await read(trigger)).toEqual({ level: 'trigger', scopes: null });
    expect(await read(worker)).toEqual({ level: 'worker', scopes: ['tasks:read', 'workers:write'] });
    expect(await read(legacyWorker)).toEqual({ level: 'worker', scopes: null });
  });

  test('leaves NULL-creator keys, other people\'s keys, and the same person\'s keys in other teams alone', async () => {
    const { teamId } = await seedWorkspace();
    const other = await seedWorkspace();
    const person = await user();
    const colleague = await user();
    const noCreator = await key(teamId, { level: 'admin', scopes: ['admin'], createdBy: null });
    const colleagues = await key(teamId, { level: 'admin', createdBy: colleague });
    const elsewhere = await key(other.teamId, { level: 'admin', createdBy: person });
    const mine = await key(teamId, { level: 'admin', createdBy: person });

    const rows = await creatorKeyClampStatement(teamId, person);

    expect(rows.map(r => r.id)).toEqual([mine]);
    expect(await read(noCreator)).toEqual({ level: 'admin', scopes: ['admin'] });
    expect(await read(colleagues)).toEqual({ level: 'admin', scopes: null });
    expect(await read(elsewhere)).toEqual({ level: 'admin', scopes: null });
  });

  test('running it twice changes nothing the second time', async () => {
    const { teamId } = await seedWorkspace();
    const person = await user();
    await key(teamId, { level: 'admin', scopes: ['admin', 'tasks:read'], createdBy: person });
    expect(await creatorKeyClampStatement(teamId, person)).toHaveLength(1);
    expect(await creatorKeyClampStatement(teamId, person)).toHaveLength(0);
  });
});
