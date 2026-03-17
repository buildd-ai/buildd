/**
 * Fix drizzle migration tracking table.
 *
 * The migration journal was regenerated/squashed, creating timestamps newer
 * than what's in the production `drizzle.__drizzle_migrations` table. This
 * causes drizzle to try re-running all migrations from scratch.
 *
 * Fix: Delete old tracking rows and insert one row for migration 0017
 * (the last migration that's already applied in prod). This makes drizzle
 * skip 0000-0017 and only run 0018+.
 *
 * Usage: DATABASE_URL="..." bun run scripts/fix-migration-tracking.ts
 */
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, '..', 'drizzle');
const journalPath = path.join(drizzleDir, 'meta', '_journal.json');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

// Compute hash for each migration (same algorithm as drizzle)
function getMigrationHash(tag: string): string {
  const sql = fs.readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf-8');
  return crypto.createHash('sha256').update(sql).digest('hex');
}

// We want to mark 0000-0017 as applied (18 entries, idx 0-17)
const lastAppliedIdx = 17; // 0017_amused_misty_knight

const sql = neon(databaseUrl);

async function main() {
  // Check current state
  const existing = await sql`
    SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5
  `;
  console.log('Current tracking rows (last 5):');
  for (const row of existing) {
    console.log(`  id=${row.id} created_at=${row.created_at} hash=${row.hash.slice(0, 16)}...`);
  }

  // Clear all rows
  await sql`DELETE FROM drizzle.__drizzle_migrations`;
  console.log('\nCleared all tracking rows.');

  // Insert rows for migrations 0000-0017
  let inserted = 0;
  for (const entry of journal.entries) {
    if (entry.idx > lastAppliedIdx) break;

    const hash = getMigrationHash(entry.tag);
    await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    inserted++;
  }

  console.log(`Inserted ${inserted} tracking rows (0000-0017).`);
  console.log(`Migrations 0018+ are now pending.`);

  // Verify
  const verify = await sql`
    SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3
  `;
  console.log('\nVerification (last 3 rows):');
  for (const row of verify) {
    console.log(`  id=${row.id} created_at=${row.created_at} hash=${row.hash.slice(0, 16)}...`);
  }

  // Show what's pending
  const lastCreatedAt = Number(verify[0]?.created_at || 0);
  const pending = journal.entries.filter((e: any) => e.when > lastCreatedAt);
  console.log(`\nPending migrations: ${pending.map((e: any) => e.tag).join(', ') || 'none'}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
