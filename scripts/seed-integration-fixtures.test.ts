import { describe, test, expect } from 'bun:test';
import { seedFixtures, hashApiKey, extractApiKeyPrefix, type SqlClient } from './seed-integration-fixtures';

const API_KEY = 'bld_test_api_key_1234567890';
const ADMIN_API_KEY = 'bld_test_admin_key_0987654321';

type Account = { id: string; api_key: string; team_id: string | null; level: string };

/**
 * A fake Neon sql client over a fixture-database shape: teams, accounts,
 * workspaces, account_workspaces — enough to drive the same branches the real
 * queries hit, honouring the unique constraints they rely on.
 */
function fakeDb() {
  const teams: Array<{ id: string; slug: string }> = [];
  const accounts: Account[] = [];
  const workspaces: Array<{ id: string; team_id: string; name: string }> = [];
  const links: Array<{ account_id: string; workspace_id: string; can_create: boolean }> = [];
  let nextId = 1;
  const newId = () => `id-${nextId++}`;

  const sql: SqlClient = async (strings, ...values) => {
    const text = strings.join('?');

    if (text.includes('SELECT id, api_key, team_id FROM accounts WHERE api_key IN')) {
      const [a, b] = values as string[];
      return accounts.filter((row) => row.api_key === a || row.api_key === b)
        .map(({ id, api_key, team_id }) => ({ id, api_key, team_id }));
    }
    if (text.includes('INSERT INTO teams')) {
      const slug = 'integration-test-team';
      const existingTeam = teams.find((t) => t.slug === slug);
      if (existingTeam) return [{ id: existingTeam.id }];
      const row = { id: newId(), slug };
      teams.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('INSERT INTO accounts')) {
      const [level, , hash, , , teamId] = values as string[];
      if (accounts.some((a) => a.api_key === hash)) return []; // ON CONFLICT DO NOTHING
      const row = { id: newId(), api_key: hash, team_id: teamId, level };
      accounts.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('SELECT id FROM workspaces')) {
      const [teamId] = values as string[];
      return workspaces.filter((w) => w.team_id === teamId && w.name === 'integration-test-workspace')
        .slice(0, 1).map(({ id }) => ({ id }));
    }
    if (text.includes('INSERT INTO workspaces')) {
      const [teamId] = values as string[];
      const row = { id: newId(), team_id: teamId, name: 'integration-test-workspace' };
      workspaces.push(row);
      return [{ id: row.id }];
    }
    if (text.includes('INSERT INTO account_workspaces')) {
      // Template order: (apiAccountId, workspaceId), (adminAccountId, workspaceId).
      const [apiAccountId, wsA, adminAccountId, wsB] = values as string[];
      const out: Array<{ account_id: string }> = [];
      for (const [account_id, workspace_id] of [[apiAccountId, wsA], [adminAccountId, wsB]]) {
        const existing = links.find((l) => l.account_id === account_id && l.workspace_id === workspace_id);
        if (existing) {
          // ON CONFLICT DO UPDATE ... WHERE not already claim+create
          if (!existing.can_create) { existing.can_create = true; out.push({ account_id }); }
          continue;
        }
        links.push({ account_id, workspace_id, can_create: true });
        out.push({ account_id });
      }
      return out;
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
    expect(db.accounts.map((a) => a.level).sort()).toEqual(['admin', 'worker']);
    expect(db.workspaces).toHaveLength(1);
    expect(db.links).toHaveLength(2);
  });

  test('is a no-op on a second run', async () => {
    const db = fakeDb();
    await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);
    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: false });
    expect(db.teams).toHaveLength(1);
    expect(db.accounts).toHaveLength(2);
    expect(db.workspaces).toHaveLength(1);
    expect(db.links).toHaveLength(2);
  });

  // Regression: the parent Neon branch already held the worker-key account but
  // not the admin-key one. The old "either key exists → skip" check never
  // created the admin account, so every admin-key integration test got a 401.
  test('creates the admin account when only the worker account already exists', async () => {
    const db = fakeDb();
    db.accounts.push({ id: 'existing-worker', api_key: hashApiKey(API_KEY), team_id: 'parent-team', level: 'worker' });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    const admin = db.accounts.find((a) => a.api_key === hashApiKey(ADMIN_API_KEY));
    expect(admin).toBeDefined();
    expect(admin!.level).toBe('admin');
    // Lands in the existing account's team, not a new fixture team.
    expect(admin!.team_id).toBe('parent-team');
    expect(db.teams).toHaveLength(0);
    // And reaches the fixture workspace through an explicit link.
    const ws = db.workspaces[0];
    expect(ws.team_id).toBe('parent-team');
    expect(db.links).toContainEqual({ account_id: admin!.id, workspace_id: ws.id, can_create: true });
    // Both keys create tasks in the suite, so both links carry canCreate.
    expect(db.links).toContainEqual({ account_id: 'existing-worker', workspace_id: ws.id, can_create: true });
  });

  test('creates the worker account when only the admin account already exists', async () => {
    const db = fakeDb();
    db.accounts.push({ id: 'existing-admin', api_key: hashApiKey(ADMIN_API_KEY), team_id: 'parent-team', level: 'admin' });

    await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    const worker = db.accounts.find((a) => a.api_key === hashApiKey(API_KEY));
    expect(worker?.level).toBe('worker');
    expect(worker?.team_id).toBe('parent-team');
  });

  test('reuses an existing team row instead of failing on its unique slug', async () => {
    const db = fakeDb();
    db.teams.push({ id: 'pre-existing-team', slug: 'integration-test-team' });

    const result = await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
    expect(db.teams).toHaveLength(1);
    expect(db.accounts.every((a) => a.team_id === 'pre-existing-team')).toBe(true);
  });

  test('raises an existing claim-only link to claim+create', async () => {
    const db = fakeDb();
    db.accounts.push({ id: 'existing-worker', api_key: hashApiKey(API_KEY), team_id: 'parent-team', level: 'worker' });
    db.workspaces.push({ id: 'ws-existing', team_id: 'parent-team', name: 'integration-test-workspace' });
    db.links.push({ account_id: 'existing-worker', workspace_id: 'ws-existing', can_create: false });

    await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(db.links.find((l) => l.account_id === 'existing-worker')?.can_create).toBe(true);
  });

  test('reuses the fixture workspace instead of creating a second one', async () => {
    const db = fakeDb();
    db.accounts.push({ id: 'existing-worker', api_key: hashApiKey(API_KEY), team_id: 'parent-team', level: 'worker' });
    db.workspaces.push({ id: 'ws-existing', team_id: 'parent-team', name: 'integration-test-workspace' });

    await seedFixtures(db.sql, API_KEY, ADMIN_API_KEY);

    expect(db.workspaces).toHaveLength(1);
    expect(db.links.every((l) => l.workspace_id === 'ws-existing')).toBe(true);
  });

  test('recovers accounts created by a concurrent run instead of crashing on the api_key conflict', async () => {
    // A second process commits both accounts between this run's lookup (sees
    // nothing) and its INSERTs, so ON CONFLICT DO NOTHING fires on both and the
    // code must re-select rather than assume it created them.
    const raced = [
      { id: 'raced-in-1', api_key: hashApiKey(API_KEY), team_id: 'team-1' },
      { id: 'raced-in-2', api_key: hashApiKey(ADMIN_API_KEY), team_id: 'team-1' },
    ];
    let lookups = 0;
    const sql: SqlClient = async (strings) => {
      const text = strings.join('?');
      if (text.includes('SELECT id, api_key, team_id FROM accounts')) return lookups++ === 0 ? [] : raced;
      if (text.includes('INSERT INTO teams')) return [{ id: 'team-1' }];
      if (text.includes('INSERT INTO accounts')) return [];
      if (text.includes('SELECT id FROM workspaces')) return [];
      if (text.includes('INSERT INTO workspaces')) return [{ id: 'workspace-1' }];
      if (text.includes('INSERT INTO account_workspaces')) return [{ account_id: 'raced-in-1' }, { account_id: 'raced-in-2' }];
      throw new Error(`unhandled query: ${text}`);
    };

    const result = await seedFixtures(sql, API_KEY, ADMIN_API_KEY);

    expect(result).toEqual({ seeded: true });
  });
});
