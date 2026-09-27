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

  // 1. Check if fixtures already exist (idempotency). Checked against the
  // accounts themselves, not the team — accounts.api_key is the unique
  // constraint an interrupted or partially-cleaned-up prior run actually
  // collides on, and a team row can go missing (manual cleanup, no cascade)
  // while the account it pointed at survives.
  const existing = await sql`
    SELECT id FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
  ` as Array<{ id: string }>;

  if (existing.length > 0) {
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
  console.log(`Created team: ${teamId}`);

  // 3. Create test accounts (one for regular API key, one for admin).
  // ON CONFLICT guards a race with a concurrent run between the check above
  // and this insert; re-select the rows it created if we lost that race.
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

  let apiAccountId: string;
  let adminAccountId: string;
  if (accountResult.length === 2) {
    [apiAccountId, adminAccountId] = [accountResult[0].id, accountResult[1].id];
  } else {
    const rows = await sql`
      SELECT id, api_key FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
    ` as Array<{ id: string; api_key: string }>;
    apiAccountId = rows.find((r) => r.api_key === hashedApiKey)!.id;
    adminAccountId = rows.find((r) => r.api_key === hashedAdminKey)!.id;
  }
  console.log(`Created API account: ${apiAccountId}`);
  console.log(`Created admin account: ${adminAccountId}`);

  // 4. Create test workspace
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

  const workspaceId = workspaceResult[0].id;
  console.log(`Created workspace: ${workspaceId}`);

  // 5. Link accounts to workspace via accountWorkspaces
  await sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create)
    VALUES
      (${apiAccountId}, ${workspaceId}, true, false),
      (${adminAccountId}, ${workspaceId}, true, true)
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
