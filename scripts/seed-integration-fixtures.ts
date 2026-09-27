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
 * Idempotent: safe to run multiple times, safe against a partially
 * cleaned-up prior run (e.g. the team row deleted without its accounts) —
 * checked against the accounts.api_key unique constraint directly rather
 * than proxying through the team's existence — and safe against a partial
 * prior seed that created only one of the two accounts (repairs the missing
 * one under the existing team/workspace instead of skipping forever).
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

  // 1. Check which of the two accounts already exist (idempotency). Checked
  // against the accounts themselves, not the team — accounts.api_key is the
  // unique constraint an interrupted or partially-cleaned-up prior run
  // actually collides on, and a team row can go missing (manual cleanup, no
  // cascade) while the account it pointed at survives.
  //
  // Checked per-key rather than "any match => fully seeded": a prior run
  // that created the worker account but failed (or was killed) before the
  // admin account insert leaves a permanent partial state. Short-circuiting
  // on "at least one exists" would skip seeding forever and the admin key
  // would 401 on every subsequent run — this is what actually happened.
  const existing = await sql`
    SELECT id, api_key FROM accounts WHERE api_key IN (${hashedApiKey}, ${hashedAdminKey})
  ` as Array<{ id: string; api_key: string }>;

  let apiAccountId = existing.find((r) => r.api_key === hashedApiKey)?.id;
  let adminAccountId = existing.find((r) => r.api_key === hashedAdminKey)?.id;

  if (apiAccountId && adminAccountId) {
    console.log('Integration test fixtures already seeded, skipping...');
    return { seeded: false };
  }

  console.log('Seeding integration test fixtures...');

  // 2. Resolve the team. Reuse the team of whichever account already exists
  // so a partial-state repair doesn't fork a second team; otherwise create
  // (or reuse) the fixture team by slug.
  let teamId: string;
  if (apiAccountId || adminAccountId) {
    const anchorId = (apiAccountId ?? adminAccountId)!;
    const teamRows = await sql`
      SELECT team_id FROM accounts WHERE id = ${anchorId}
    ` as Array<{ team_id: string }>;
    teamId = teamRows[0].team_id;
  } else {
    const teamResult = await sql`
      INSERT INTO teams (name, slug, created_at, updated_at)
      VALUES ('integration-test-team', 'integration-test-team', NOW(), NOW())
      ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
      RETURNING id
    ` as Array<{ id: string }>;
    teamId = teamResult[0].id;
  }
  console.log(`Using team: ${teamId}`);

  // 3. Create whichever accounts are missing. ON CONFLICT guards a race with
  // a concurrent run between the check above and this insert; re-select the
  // row it created if we lost that race.
  if (!apiAccountId) {
    const rows = await sql`
      INSERT INTO accounts (
        type, level, name, api_key, api_key_prefix, auth_type,
        max_concurrent_workers, total_tasks, team_id, created_at
      ) VALUES
        ('service', 'worker', 'integration-test-api', ${hashedApiKey}, ${apiKeyPrefix}, 'api', 3, 0, ${teamId}, NOW())
      ON CONFLICT (api_key) DO NOTHING
      RETURNING id
    ` as Array<{ id: string }>;
    apiAccountId = rows[0]?.id ?? (
      (await sql`SELECT id FROM accounts WHERE api_key = ${hashedApiKey}` as Array<{ id: string }>)[0].id
    );
    console.log(`Created API account: ${apiAccountId}`);
  }

  if (!adminAccountId) {
    const rows = await sql`
      INSERT INTO accounts (
        type, level, name, api_key, api_key_prefix, auth_type,
        max_concurrent_workers, total_tasks, team_id, created_at
      ) VALUES
        ('service', 'admin', 'integration-test-admin', ${hashedAdminKey}, ${adminKeyPrefix}, 'api', 50, 0, ${teamId}, NOW())
      ON CONFLICT (api_key) DO NOTHING
      RETURNING id
    ` as Array<{ id: string }>;
    adminAccountId = rows[0]?.id ?? (
      (await sql`SELECT id FROM accounts WHERE api_key = ${hashedAdminKey}` as Array<{ id: string }>)[0].id
    );
    console.log(`Created admin account: ${adminAccountId}`);
  }

  // 4. Create the test workspace, or reuse it if a partial-state repair
  // already has one under this team.
  const existingWorkspace = await sql`
    SELECT id FROM workspaces WHERE team_id = ${teamId} AND name = 'integration-test-workspace'
  ` as Array<{ id: string }>;

  let workspaceId: string;
  if (existingWorkspace.length > 0) {
    workspaceId = existingWorkspace[0].id;
    console.log(`Using existing workspace: ${workspaceId}`);
  } else {
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
  }

  // 5. Link accounts to workspace via accountWorkspaces (idempotent: the
  // primary key is (account_id, workspace_id), so a repair run that only
  // needed to create one account still links safely).
  await sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create)
    VALUES (${apiAccountId}, ${workspaceId}, true, false)
    ON CONFLICT (account_id, workspace_id) DO NOTHING
  `;
  await sql`
    INSERT INTO account_workspaces (account_id, workspace_id, can_claim, can_create)
    VALUES (${adminAccountId}, ${workspaceId}, true, true)
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
