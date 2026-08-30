#!/usr/bin/env bun
/**
 * One-time migration: move teams.memory_api_key (plaintext) → secrets table (encrypted).
 *
 * Run BEFORE applying the Drizzle migration that drops the column:
 *
 *   DATABASE_URL=... ENCRYPTION_KEY=... MEMORY_API_URL=... \
 *   bun scripts/migrate-memory-api-keys.ts [--dry-run] [--verify]
 *
 * Flags:
 *   --dry-run  Print what would be migrated, make no changes.
 *   --verify   After migrating each key, make an authenticated call to the
 *              memory service to confirm the key still works (requires
 *              MEMORY_API_URL to be set and the service to be reachable).
 *
 * Rollback: if you need to abort before the column-drop migration runs,
 * the plaintext values are still in teams.memory_api_key. You can verify
 * with: SELECT id, left(memory_api_key,8) FROM teams WHERE memory_api_key IS NOT NULL;
 * After the column-drop migration is applied, rollback requires restoring
 * from the DB backup taken immediately before the deploy.
 */

import { db } from '../packages/core/db/index';
import { sql } from 'drizzle-orm';
import { setMemoryApiKeyForTeam, getMemoryApiKeyForTeam } from '../packages/core/secrets/memory-api-key';

const dryRun = process.argv.includes('--dry-run');
const verify = process.argv.includes('--verify');

const MEMORY_API_URL = process.env.MEMORY_API_URL;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is required');
  process.exit(1);
}
if (verify && !MEMORY_API_URL) {
  console.error('MEMORY_API_URL is required for --verify');
  process.exit(1);
}

async function verifyKey(teamId: string, key: string): Promise<boolean> {
  if (!MEMORY_API_URL) return true;
  try {
    const res = await fetch(`${MEMORY_API_URL}/api/memories`, {
      headers: { 'x-api-key': key },
    });
    if (res.ok || res.status === 404) return true;
    console.error(`  [verify] HTTP ${res.status} for team ${teamId}`);
    return false;
  } catch (err) {
    console.error(`  [verify] fetch error for team ${teamId}:`, err);
    return false;
  }
}

async function main() {
  // Read plaintext keys directly from the column using raw SQL
  // (the Drizzle schema no longer declares this column, but it still exists
  // in the database until the column-drop migration runs)
  const rows = await db.execute<{ id: string; memory_api_key: string }>(
    sql`SELECT id, memory_api_key FROM teams WHERE memory_api_key IS NOT NULL`
  );

  const teamsWithKeys = rows.rows ?? (rows as any);

  if (!Array.isArray(teamsWithKeys) || teamsWithKeys.length === 0) {
    console.log('No teams with memory_api_key found — nothing to migrate.');
    return;
  }

  console.log(`Found ${teamsWithKeys.length} team(s) to migrate.`);
  if (dryRun) console.log('[dry-run mode — no changes will be made]');

  let ok = 0;
  let failed = 0;

  for (const row of teamsWithKeys) {
    const teamId = row.id;
    const plainKey = row.memory_api_key;
    console.log(`\nMigrating team ${teamId} (key starts with: ${plainKey.slice(0, 8)}...)`);

    if (dryRun) {
      console.log('  [dry-run] would encrypt and insert into secrets table');
      ok++;
      continue;
    }

    try {
      await setMemoryApiKeyForTeam(teamId, plainKey);
      console.log('  Encrypted and stored in secrets table.');

      // Verify the round-trip decrypt matches
      const readBack = await getMemoryApiKeyForTeam(teamId);
      if (readBack !== plainKey) {
        console.error('  ERROR: round-trip mismatch — decrypted value differs from original!');
        failed++;
        continue;
      }
      console.log('  Round-trip decrypt: OK');

      if (verify) {
        const live = await verifyKey(teamId, readBack);
        if (!live) {
          console.error('  ERROR: live memory service call FAILED with migrated key!');
          failed++;
          continue;
        }
        console.log('  Live memory service call: OK');
      }

      ok++;
    } catch (err) {
      console.error(`  ERROR migrating team ${teamId}:`, err);
      failed++;
    }
  }

  console.log(`\nDone: ${ok} succeeded, ${failed} failed.`);
  if (failed > 0) {
    console.error('Some migrations failed — do NOT proceed with the column-drop migration.');
    process.exit(1);
  }
  if (dryRun) {
    console.log('Dry run complete. Re-run without --dry-run to apply.');
  } else {
    console.log('Migration complete. You can now run the Drizzle migration to drop the column.');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
