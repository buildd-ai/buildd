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
 * Idempotent: safe to run multiple times, and safe against a partially
 * cleaned-up prior run (e.g. the team row deleted without its accounts) —
 * checked against the accounts.api_key unique constraint directly rather
 * than proxying through the team's existence.
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

  // 1. Check if fixtures already exist (idempotency). Checked per-account,
  // not "any match" — a partially-repaired database (e.g. the admin account
  // manually deleted while the regular one survives) must still get the
  // missing account, and its workspace link, recreated. A single "does at
  // least one of these two keys exist" check would treat that partial state
  // as fully seeded forever, permanently 401ing whichever key never got
  // re-created.
  const existingAccounts = await sql`
    SELECT id, api_key FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
  ` as Array<{ id: string; api_key: string }>;

  if (existingAccounts.length === 2) {
    console.log('Integration test fixtures already seeded, skipping...');
    return { seeded: false };
  }

  console.log('Seeding integration test fixtures...');

  // 2. Create test team (or reuse it if it already exists without matching accounts)
  const teamResult = await sql`
    INSERT INTO teams (name, slug, created_at, updated_at)
    VALUES ('integration-test-team', 'integration-test-team', NOW(), NOW())
    ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
    RETURNING id
  ` as Array<{ id: string }>;

  const teamId = teamResult[0].id;
  console.log(`Using team: ${teamId}`);

  // 3. Create whichever accounts are still missing (one for regular API key,
  // one for admin). ON CONFLICT guards both a race with a concurrent run and
  // an account that already survived a partial cleanup; re-select by key for
  // whichever side didn't come back with a fresh id.
  const accountResult = await sql`
    INSERT INTO accounts (
      type, level, name, api_key, api_key_prefix, auth_type,
      max_concurrent_workers, total_tasks, team_id, created_at
    ) VALUES
      ('service', 'worker', 'integration-test-api', ${hashedApiKey}, ${apiKeyPrefix}, 'api', 3, 0, ${teamId}, NOW()),
      ('service', 'admin', 'integration-test-admin', ${hashedAdminKey}, ${adminKeyPrefix}, 'api', 50, 0, ${teamId}, NOW())
    ON CONFLICT (api_key) DO NOTHING
    RETURNING id, api_key
  ` as Array<{ id: string; api_key: string }>;

  let apiAccountId = accountResult.find((r) => r.api_key === hashedApiKey)?.id;
  let adminAccountId = accountResult.find((r) => r.api_key === hashedAdminKey)?.id;
  if (!apiAccountId || !adminAccountId) {
    const rows = await sql`
      SELECT id, api_key FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
    ` as Array<{ id: string; api_key: string }>;
    apiAccountId ??= rows.find((r) => r.api_key === hashedApiKey)!.id;
    adminAccountId ??= rows.find((r) => r.api_key === hashedAdminKey)!.id;
  }
  console.log(`API account: ${apiAccountId}`);
  console.log(`Admin account: ${adminAccountId}`);

  // 4. Reuse the fixture workspace if one already exists for this team (this
  // run may only be repairing a missing account), else create it. Workspaces
  // have no unique constraint to ON CONFLICT against, so this has to be an
  // explicit check-then-insert.
  const existingWorkspace = await sql`
    SELECT id FROM workspaces WHERE team_id = ${teamId} AND name = 'integration-test-workspace'
  ` as Array<{ id: string }>;

  let workspaceId = existingWorkspace[0]?.id;
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
    console.log(`Created workspace: ${workspaceId}`);
  } else {
    console.log(`Reusing workspace: ${workspaceId}`);
  }

  // 5. Link accounts to workspace via accountWorkspaces. ON CONFLICT guards
  // an account that already had this link from before this run.
  await sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create)
    VALUES
      (${apiAccountId}, ${workspaceId}, true, false),
      (${adminAccountId}, ${workspaceId}, true, true)
    ON CONFLICT (account_id, workspace_id) DO NOTHING
  `;
  console.log('Linked accounts to workspace');

  console.log('Integration test fixtures seeded successfully!');
  return { seeded: true };
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
