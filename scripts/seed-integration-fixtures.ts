/**
 * Seed integration test fixtures into an ephemeral Neon branch.
 *
 * Creates:
 *   - A test team
 *   - Test accounts for BUILDD_API_KEY and BUILDD_ADMIN_API_KEY
 *   - A test workspace
 *   - Links between accounts and workspaces
 *
 * Idempotent: safe to run multiple times (skips if fixtures already exist).
 *
 * Usage:
 *   DATABASE_URL="…" bun run scripts/seed-integration-fixtures.ts
 *     (uses environment variables: BUILDD_API_KEY, BUILDD_ADMIN_API_KEY)
 */

import { createHash } from 'crypto';
import { neon } from '@neondatabase/serverless';

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

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function extractApiKeyPrefix(key: string): string {
  return key.substring(0, 12);
}

const sql = neon(DATABASE_URL);

async function seedFixtures() {
  try {
    // 1. Check if fixtures already exist (idempotency)
    const existing = await sql`
      SELECT id FROM teams WHERE name = 'integration-test-team' LIMIT 1
    ` as Array<{ id: string }>;

    if (existing.length > 0) {
      console.log('Integration test fixtures already seeded, skipping...');
      return;
    }

    console.log('Seeding integration test fixtures...');

    // 2. Create test team
    const teamResult = await sql`
      INSERT INTO teams (name, slug, created_at, updated_at)
      VALUES ('integration-test-team', 'integration-test-team', NOW(), NOW())
      RETURNING id
    ` as Array<{ id: string }>;

    const teamId = teamResult[0].id;
    console.log(`Created team: ${teamId}`);

    // 3. Create test accounts (one for regular API key, one for admin)
    const hashedApiKey = hashApiKey(apiKey);
    const hashedAdminKey = hashApiKey(adminApiKey);
    const apiKeyPrefix = extractApiKeyPrefix(apiKey);
    const adminKeyPrefix = extractApiKeyPrefix(adminApiKey);

    const accountResult = await sql`
      INSERT INTO accounts (
        type, level, name, api_key, api_key_prefix, auth_type,
        max_concurrent_workers, total_tasks, team_id, created_at
      ) VALUES
        ('service', 'worker', 'integration-test-api', ${hashedApiKey}, ${apiKeyPrefix}, 'api', 3, 0, ${teamId}, NOW()),
        ('service', 'admin', 'integration-test-admin', ${hashedAdminKey}, ${adminKeyPrefix}, 'api', 50, 0, ${teamId}, NOW())
      RETURNING id
    ` as Array<{ id: string }>;

    const [apiAccountId, adminAccountId] = [accountResult[0].id, accountResult[1].id];
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
  } catch (error) {
    console.error('Error seeding fixtures:', error);
    process.exit(1);
  }
}

await seedFixtures();
