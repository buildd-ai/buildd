import { describe, test, expect } from 'bun:test';
import { seedFixtures, hashApiKey, extractApiKeyPrefix, type SqlClient } from './seed-integration-fixtures';

const API_KEY = 'bld_test_api_key_1234567890';
const ADMIN_API_KEY = 'bld_test_admin_key_0987654321';

/**
 * A fake Neon sql client keyed on a fixture-database shape: teams, accounts,
 * workspaces, account_workspaces — enough to drive the same branches the real
 * queries hit, without a live Postgres connection.
 */
function fakeDb() {
  const teams: Array<{ id: string; slug: string }> = [];
  const accounts: Array<{ id: string; api_key: string }> = [];
  const workspaces: Array<{ id: string; team_id: string; name: string }> = [];
  const links: Array<{ account_id: string; workspace_id: string }> = [];
  let nextId = 1;
  const newId = () => `id-${nextId++}`;

  const sql: SqlClient = async (strings, ...values) => {
    const text = strings.join('?');

    if (text.includes('SELECT id, api_key FROM accounts WHERE api_key IN')) {
      const [a, b] = values as string[];
      return accounts.filter((row) => row.api_key === a || row.api_key === b);
    }
    if (text.includes('INSERT INTO teams')) {
      // name/slug are literal text in this query, not interpolated values.
      const slug = 'integration-test-team';
      const existingTeam = teams.find((t) => t.slug === slug);
      if (existingTeam) return [{ id: existingTeam.id }];
      const row = { id: newId(), slug };
      teams.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('INSERT INTO accounts')) {
      const [apiKey, , , adminKey] = values as string[];
      const inserted: Array<{ id: string; api_key: string }> = [];
      for (const key of [apiKey, adminKey]) {
        if (accounts.some((a) => a.api_key === key)) continue; // ON CONFLICT DO NOTHING
        const row = { id: newId(), api_key: key };
        accounts.push(row);
        inserted.push(row);
      }
      return inserted;
    }
    if (text.includes('SELECT id FROM workspaces WHERE team_id')) {
      const [teamId] = values as string[];
      return workspaces.filter((w) => w.team_id === teamId && w.name === 'integration-test-workspace');
    }
    if (text.includes('INSERT INTO workspaces')) {
      const [teamId] = values as string[];
      const row = { id: newId(), team_id: teamId, name: 'integration-test-workspace' };
      workspaces.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('INSERT INTO account_workspaces')) {
      // Values appear in template order: (apiAccountId, workspaceId), (adminAccountId, workspaceId).
      const [apiAccountId, workspaceId, adminAccountId] = values as string[];
      for (const link of [
        { account_id: apiAccountId, workspace_id: workspaceId },
        { account_id: adminAccountId, workspace_id: workspaceId },
      ]) {
        if (links.some((l) => l.account_id === link.account_id && l.workspace_id === link.workspace_id)) continue; // ON CONFLICT DO NOTHING
        links.push(link);
      }
      return [];
    }
    throw new Error(`fakeDb: unhandled query: ${text}`);
  };

  return { sql, teams, accounts, workspaces, links };
}

describe('hashApiKey / extractApiKeyPrefix', () => {
  test('hashing is deterministic', () => {
    expect(hashApiKey(API_KEY)).toBe(hashApiKey(API_KEY));
    expect(hashApiKey(API_KEY)).not.toBe(hashApiKey(ADMIN_API_KEY));
  });

  test('prefix is the first 12 characters', () => {
    expect(extractApiKeyPrefix(API_KEY)).toBe(API_KEY.slice(0, 12));
  });
});

describe('seedFixtures', () => {
  test('seeds team, accounts, workspace and links on a fresh database', async () => {
    const db = fakeDb();
    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    expect(db.teams).toHaveLength(1);
    expect(db.accounts).toHaveLength(2);
    expect(db.workspaces).toHaveLength(1);
    expect(db.links).toHaveLength(2);
  });

  test('is a no-op when accounts with these api keys already exist', async () => {
    const db = fakeDb();
    db.accounts.push({ id: 'existing-1', api_key: hashApiKey(API_KEY) });
    db.accounts.push({ id: 'existing-2', api_key: hashApiKey(ADMIN_API_KEY) });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: false });
    expect(db.teams).toHaveLength(0);
    expect(db.workspaces).toHaveLength(0);
  });

  test('reuses an existing team row instead of failing on its unique slug', async () => {
    const db = fakeDb();
    db.teams.push({ id: 'pre-existing-team', slug: 'integration-test-team' });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    expect(db.teams).toHaveLength(1);
    expect(db.accounts).toHaveLength(2);
  });

  test('recovers accounts created by a concurrent run instead of crashing on the api_key conflict', async () => {
    // Simulates a second process winning a race between this run's existence
    // check (sees nothing yet) and its own INSERT (the other process already
    // committed both accounts by then, so ON CONFLICT DO NOTHING fires on
    // both rows and the code must re-select rather than treat that as a
    // successful insert of new rows).
    const accounts = [{ id: 'raced-in-1', api_key: hashApiKey(API_KEY) }, { id: 'raced-in-2', api_key: hashApiKey(ADMIN_API_KEY) }];
    let existenceCheckCalls = 0;

    const sql: SqlClient = async (strings, ...values) => {
      const text = strings.join('?');
      if (text.includes('SELECT id, api_key FROM accounts WHERE api_key IN')) {
        existenceCheckCalls += 1;
        return existenceCheckCalls === 1 ? [] : accounts;
      }
      if (text.includes('INSERT INTO teams')) return [{ id: 'team-1' }];
      if (text.includes('INSERT INTO accounts')) return []; // ON CONFLICT DO NOTHING on both rows
      if (text.includes('SELECT id FROM workspaces WHERE team_id')) return [];
      if (text.includes('INSERT INTO workspaces')) return [{ id: 'workspace-1' }];
      if (text.includes('INSERT INTO account_workspaces')) return [];
      throw new Error(`unhandled query: ${text}`);
    };

    const result = await seedFixtures(sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
  });

  test('repairs a partial cleanup where only one fixture account survived', async () => {
    // Regression for the missions-smoke 401: if the admin account is ever
    // deleted (manual cleanup, broken cascade) while the regular account
    // survives, an "any key exists" check would skip seeding forever and the
    // admin key would 401 on every future CI run. Each account must be
    // checked and repaired independently.
    const db = fakeDb();
    db.accounts.push({ id: 'surviving-api-account', api_key: hashApiKey(API_KEY) });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    expect(db.accounts).toHaveLength(2);
    expect(db.accounts.some((a) => a.api_key === hashApiKey(ADMIN_API_KEY))).toBe(true);
    expect(db.workspaces).toHaveLength(1);
    expect(db.links).toHaveLength(2);
  });

  test('reuses the existing fixture workspace instead of creating a duplicate when repairing an account', async () => {
    const db = fakeDb();
    db.teams.push({ id: 'team-1', slug: 'integration-test-team' });
    db.accounts.push({ id: 'surviving-api-account', api_key: hashApiKey(API_KEY) });
    db.workspaces.push({ id: 'workspace-1', team_id: 'team-1', name: 'integration-test-workspace' });
    db.links.push({ account_id: 'surviving-api-account', workspace_id: 'workspace-1' });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    expect(db.workspaces).toHaveLength(1);
    expect(db.links).toHaveLength(2);
    expect(db.links.some((l) => l.account_id === 'surviving-api-account')).toBe(true);
  });
});
