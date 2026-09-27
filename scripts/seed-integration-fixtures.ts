#!/usr/bin/env bun
/**
 * Seed integration test fixtures into an ephemeral Neon branch.
 *
 * Creates:
 *   - A test team
 *   - Test accounts for BUILDD_API_KEY and BUILDD_ADMIN_API_KEY
 *   - A test workspace
 *   - Links between accounts and workspaces
 *
 * Idempotent per row: safe to run multiple times, and safe against a parent
 * branch that already holds some of these rows (e.g. only one of the two
 * accounts). Each missing row is created; existing rows are left alone.
 *
 * Usage:
 *   DATABASE_URL="…" bun run scripts/seed-integration-fixtures.ts
 *     (uses environment variables: BUILDD_API_KEY, BUILDD_ADMIN_API_KEY)
 */

import { createHash } from 'crypto';
import { neon } from '@neondatabase/serverless';

export type SqlClient = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function extractApiKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

export async function seedFixtures(sql: SqlClient, apiKey: string, adminApiKey: string): Promise<{ seeded: boolean }> {
  const hashedApiKey = hashApiKey(apiKey);
  const hashedAdminKey = hashApiKey(adminApiKey);
  const apiKeyPrefix = extractApiKeyPrefix(apiKey);
  const adminKeyPrefix = extractApiKeyPrefix(adminApiKey);

  // Idempotent per row, not per run. The ephemeral branch is forked from a
  // parent that may already hold ONE of the two accounts; an all-or-nothing
  // "either key exists → skip" check then never creates the other, and every
  // test using that key gets a 401 from authenticateApiKey. So each piece
  // (team, both accounts, workspace, both links) is ensured on its own.
  let seeded = false;

  const findAccounts = async () => await sql`
    SELECT id, api_key, team_id FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
  ` as Array<{ id: string; api_key: string; team_id: string | null }>;

  let accountRows = await findAccounts();

  // 1. Team: join the team of an account that already exists, so the missing
  // account lands beside it; otherwise create/reuse the fixture team.
  let teamId = accountRows.find((r) => r.team_id)?.team_id ?? null;
  if (!teamId) {
    const teamResult = await sql`
      INSERT INTO teams (name, slug, created_at, updated_at)
      VALUES ('integration-test-team', 'integration-test-team', NOW(), NOW())
      ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
      RETURNING id
    ` as Array<{ id: string }>;
    teamId = teamResult[0].id;
  }
  console.log(`Using team: ${teamId}`);

  // 2. Accounts: insert whichever is missing. ON CONFLICT covers a race with a
  // concurrent run; the re-select below picks up rows it created.
  const wanted = [
    { hash: hashedApiKey, prefix: apiKeyPrefix, level: 'worker', name: 'integration-test-api', max: 3 },
    { hash: hashedAdminKey, prefix: adminKeyPrefix, level: 'admin', name: 'integration-test-admin', max: 50 },
  ];
  for (const a of wanted) {
    if (accountRows.some((r) => r.api_key === a.hash)) continue;
    const inserted = await sql`
      INSERT INTO accounts (
        type, level, name, api_key, api_key_prefix, auth_type,
        max_concurrent_workers, total_tasks, team_id, created_at
      ) VALUES (
        'service', ${a.level}, ${a.name}, ${a.hash}, ${a.prefix}, 'api', ${a.max}, 0, ${teamId}, NOW()
      )
      ON CONFLICT (api_key) DO NOTHING
      RETURNING id
    ` as Array<{ id: string }>;
    if (inserted.length > 0) {
      seeded = true;
      console.log(`Created ${a.level} account: ${inserted[0].id}`);
    }
  }
  accountRows = await findAccounts();
  const apiAccountId = accountRows.find((r) => r.api_key === hashedApiKey)?.id;
  const adminAccountId = accountRows.find((r) => r.api_key === hashedAdminKey)?.id;
  if (!apiAccountId || !adminAccountId) {
    throw new Error('Could not create or find both integration test accounts');
  }

  // 3. Workspace: reuse the team's fixture workspace, else create it.
  const existingWs = await sql`
    SELECT id FROM workspaces
    WHERE team_id = ${teamId} AND name = 'integration-test-workspace'
    ORDER BY created_at ASC LIMIT 1
  ` as Array<{ id: string }>;
  let workspaceId = existingWs[0]?.id;
  if (!workspaceId) {
    const workspaceResult = await sql`
      INSERT INTO workspaces (
        name, access_mode, data_class, max_concurrent_tasks,
        config_status, team_id, created_at, updated_at
      ) VALUES (
        'integration-test-workspace',
        'restricted',
        'standard',
        3,
        'unconfigured',
        ${teamId},
        NOW(),
        NOW()
      )
      RETURNING id
    ` as Array<{ id: string }>;
    workspaceId = workspaceResult[0].id;
    seeded = true;
    console.log(`Created workspace: ${workspaceId}`);
  }

  // 4. Links: a restricted workspace is reachable only through these
  // (lib/workspace-access.ts). Both keys create tasks in the integration suite
  // (concurrency, worker-state-machine, artifacts use BUILDD_API_KEY), so both
  // need canCreate — without it POST /api/tasks is a 403. An existing link is
  // raised to claim+create rather than left as it was.
  const linked = await sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create)
    VALUES
      (${apiAccountId}, ${workspaceId}, true, true),
      (${adminAccountId}, ${workspaceId}, true, true)
    ON CONFLICT (account_id, workspace_id)
      DO UPDATE SET can_claim = true, can_create = true
      WHERE account_workspaces.can_claim IS NOT TRUE OR account_workspaces.can_create IS NOT TRUE
    RETURNING account_id
  ` as Array<{ account_id: string }>;
  if (linked.length > 0) seeded = true;

  console.log(seeded
    ? 'Integration test fixtures seeded successfully!'
    : 'Integration test fixtures already seeded, nothing to do.');
  return { seeded };
}

if (import.meta.main) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const apiKey = process.env.BUILDD_API_KEY;
  const adminApiKey = process.env.BUILDD_ADMIN_API_KEY;

  if (!apiKey || !adminApiKey) {
    console.error('BUILDD_API_KEY and BUILDD_ADMIN_API_KEY environment variables are required');
    process.exit(1);
  }

  const sql = neon(DATABASE_URL);

  try {
    await seedFixtures(sql, apiKey, adminApiKey);
  } catch (error) {
    console.error('Error seeding fixtures:', error);
    process.exit(1);
  }
}
