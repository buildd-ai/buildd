/**
 * One-off migration: move rows from the legacy per-workspace `codex_credentials`
 * table into the unified `secrets` table (purpose='codex_credential').
 *
 * The legacy table encrypted access/refresh tokens in SEPARATE columns; the new
 * model stores a single encrypted JSON blob in secrets.encrypted_value. Re-encryption
 * happens at the app layer (AES-GCM), so this cannot be a pure-SQL migration.
 *
 * Each legacy row becomes a WORKSPACE-scoped secret (preserving existing behavior).
 * Users can later widen the scope to team-wide via the settings UI.
 *
 * Usage:
 *   cd /Users/max/buildd/packages/core && bun scripts/backfill-codex-credentials.ts
 *   (add --commit to write; default is a dry run)
 *
 * Safe to run multiple times — skips workspaces that already have a codex_credential secret.
 * Run BEFORE the migration that drops codex_credentials.
 */

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { codexCredentials, secrets, workspaces } from '../db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { encrypt, decrypt } from '../secrets';

const COMMIT = process.argv.includes('--commit');

const client = neon(config.databaseUrl);
const db = drizzle(client, { schema: { codexCredentials, secrets, workspaces } });

async function main() {
  const legacy = await db.select().from(codexCredentials);
  console.log(`Found ${legacy.length} legacy codex_credentials row(s). ${COMMIT ? 'COMMITTING' : 'DRY RUN'}`);

  let migrated = 0;
  let skipped = 0;

  for (const row of legacy) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, row.workspaceId),
      columns: { teamId: true, name: true },
    });
    if (!ws) {
      console.warn(`  ! workspace ${row.workspaceId} not found — skipping`);
      skipped++;
      continue;
    }

    // Idempotency: skip if a workspace-scoped codex secret already exists.
    const existing = await db.query.secrets.findFirst({
      where: and(
        eq(secrets.teamId, ws.teamId),
        eq(secrets.purpose, 'codex_credential'),
        eq(secrets.workspaceId, row.workspaceId),
        isNull(secrets.accountId),
      ),
      columns: { id: true },
    });
    if (existing) {
      console.log(`  = ${ws.name} (${row.workspaceId}) already migrated — skipping`);
      skipped++;
      continue;
    }

    const blob = {
      access_token: decrypt(row.encryptedAccessToken),
      refresh_token: decrypt(row.encryptedRefreshToken),
      account_id: row.accountId,
    };

    console.log(`  → ${ws.name} (${row.workspaceId}) → team ${ws.teamId}, workspace-scoped`);
    if (COMMIT) {
      await db.insert(secrets).values({
        teamId: ws.teamId,
        accountId: null,
        workspaceId: row.workspaceId,
        purpose: 'codex_credential',
        encryptedValue: encrypt(JSON.stringify(blob)),
        tokenExpiresAt: row.tokenExpiresAt ?? null,
        lastRefreshedAt: row.lastRefreshedAt ?? null,
      });
    }
    migrated++;
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped}${COMMIT ? '' : ' (dry run — re-run with --commit)'}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
