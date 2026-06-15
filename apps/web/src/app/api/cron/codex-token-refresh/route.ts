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
import { codexCredentials } from '@buildd/core/db/schema';
import { lt, sql, isNotNull } from 'drizzle-orm';
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

  // Find credentials expiring within 1 hour that have a refresh token
  const expiringSoon = await db.query.codexCredentials.findMany({
    where: lt(codexCredentials.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
    columns: { workspaceId: true, tokenExpiresAt: true },
  });

  const results: Record<string, string> = {};
  let refreshed = 0;
  let locked = 0;
  let errors = 0;
  let noCredential = 0;

  for (const cred of expiringSoon) {
    const outcome = await refreshCodexCredential(cred.workspaceId);
    results[cred.workspaceId] = outcome;
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
    workspaces: results,
  });
}
