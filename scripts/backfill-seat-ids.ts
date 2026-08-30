#!/usr/bin/env bun
/**
 * Backfill accounts.seat_id for all OAuth accounts.
 *
 * For each team that has OAuth accounts with null seat_id AND a claude_credential
 * secret, decode the access token JWT to extract the `sub` claim (stable Anthropic
 * user ID) and write it to those accounts.
 *
 * Run from the repo root:
 *   bun run scripts/backfill-seat-ids.ts [--dry-run]
 *
 * Requires DATABASE_URL and ENCRYPTION_KEY env vars (same as production).
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import * as schema from '../packages/core/db/schema';
import { decrypt } from '../packages/core/secrets/crypto';

const DRY_RUN = process.argv.includes('--dry-run');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ERROR: ENCRYPTION_KEY is not set');
  process.exit(1);
}

function extractJwtSub(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

const sql = neon(DATABASE_URL!);
const db = drizzle(sql, { schema });

async function main() {
  console.log(`[backfill-seat-ids] mode=${DRY_RUN ? 'dry-run' : 'live'}`);

  // Find all OAuth accounts with null seatId
  const oauthAccounts = await db.query.accounts.findMany({
    where: and(
      eq(schema.accounts.authType, 'oauth'),
      isNull(schema.accounts.seatId),
    ),
    columns: { id: true, name: true, teamId: true },
  });

  if (oauthAccounts.length === 0) {
    console.log('[backfill-seat-ids] No OAuth accounts with null seatId — nothing to do.');
    return;
  }

  console.log(`[backfill-seat-ids] Found ${oauthAccounts.length} OAuth account(s) with null seatId`);

  // Group by teamId
  const byTeam = new Map<string, Array<{ id: string; name: string }>>();
  for (const acct of oauthAccounts) {
    const existing = byTeam.get(acct.teamId) ?? [];
    existing.push({ id: acct.id, name: acct.name });
    byTeam.set(acct.teamId, existing);
  }

  let updatedTotal = 0;
  let skippedTotal = 0;

  for (const [teamId, teamAccounts] of byTeam) {
    // Prefer team-wide credential; fall back to any workspace-scoped one.
    const creds = await db.query.secrets.findMany({
      where: and(
        eq(schema.secrets.teamId, teamId),
        eq(schema.secrets.purpose, 'claude_credential'),
      ),
      columns: { encryptedValue: true, workspaceId: true, healthStatus: true },
      orderBy: (s, { asc }) => [asc(s.workspaceId)], // null (team-wide) sorts first
    });

    if (creds.length === 0) {
      console.log(`  team=${teamId}: no claude_credential — skipping ${teamAccounts.length} account(s)`);
      skippedTotal += teamAccounts.length;
      continue;
    }

    let seatId: string | null = null;

    for (const cred of creds) {
      let blob: Record<string, unknown>;
      try {
        blob = JSON.parse(decrypt(cred.encryptedValue)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const accessToken = typeof blob.access_token === 'string' ? blob.access_token : null;
      if (!accessToken) continue;
      seatId = extractJwtSub(accessToken);
      if (seatId) break;
    }

    if (!seatId) {
      console.log(`  team=${teamId}: no sub claim found in any claude_credential JWT — skipping ${teamAccounts.length} account(s)`);
      skippedTotal += teamAccounts.length;
      continue;
    }

    const names = teamAccounts.map(a => a.name).join(', ');
    console.log(`  team=${teamId}: seatId=${seatId} → ${DRY_RUN ? '[dry-run] would update' : 'updating'} ${teamAccounts.length} account(s): ${names}`);

    if (!DRY_RUN) {
      await db
        .update(schema.accounts)
        .set({ seatId })
        .where(inArray(schema.accounts.id, teamAccounts.map(a => a.id)));
    }
    updatedTotal += teamAccounts.length;
  }

  console.log(
    `\n[backfill-seat-ids] Done: updated=${updatedTotal} skipped=${skippedTotal}${DRY_RUN ? ' (dry-run — no writes)' : ''}`,
  );
}

main().catch((err) => {
  console.error('[backfill-seat-ids] Fatal error:', err);
  process.exit(1);
});
