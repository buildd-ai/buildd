// Cron endpoint: GET /api/cron/codex-token-refresh
//
// Proactively refreshes Codex OAuth tokens that are expiring within 1 hour.
// OpenAI rotates the refresh token on each use — refreshCodexCredential always
// persists the new refresh token to prevent silent logouts.
//
// Auth: Bearer token matching CRON_SECRET env var.
// Recommended schedule: every 4 hours.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, lt, sql } from 'drizzle-orm';
import { refreshCodexCredential } from '@/lib/codex-credential';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const token = authHeader?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Find Codex credentials expiring within 1 hour
  const expiringSoon = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'codex_credential'),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
    ),
    columns: { id: true },
  });

  const results: Record<string, string> = {};
  let refreshed = 0;
  let locked = 0;
  let errors = 0;
  let noCredential = 0;

  for (const cred of expiringSoon) {
    const outcome = await refreshCodexCredential(cred.id);
    results[cred.id] = outcome;
    if (outcome === 'refreshed') refreshed++;
    else if (outcome === 'locked') locked++;
    else if (outcome === 'error') errors++;
    else if (outcome === 'no_credential') noCredential++;
  }

  console.log(`[Cron] Codex token refresh: checked=${expiringSoon.length} refreshed=${refreshed} locked=${locked} errors=${errors}`);

  return NextResponse.json({
    checked: expiringSoon.length,
    refreshed,
    locked,
    errors,
    noCredential,
    secrets: results,
  });
}
