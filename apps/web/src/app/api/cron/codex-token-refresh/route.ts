// Cron endpoint: GET /api/cron/codex-token-refresh
//
// Proactively refreshes and verifies agent-backend credentials:
//   1. Codex OAuth tokens expiring within 1 hour (OpenAI rotates refresh token on each use)
//   2. Claude OAuth tokens (claude_credential) expiring within 1 hour (Anthropic rotates refresh token on each use)
//   3. MCP connector OAuth tokens expiring within 10 minutes (standard OAuth 2.1 refresh)
//   4. Claude credentials (oauth_token / anthropic_api_key) — cheap GET /v1/models ping
//      to catch out-of-band revocations between spawns
//
// Auth: Bearer CRON_SECRET (external scheduler) or x-vercel-cron: 1 (Vercel native cron).
// Schedule: every 4 hours.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { refreshCodexCredential } from '@/lib/codex-credential';
import { refreshClaudeCredential, verifyClaudeCredential } from '@/lib/claude-credential';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';
import { recordCredentialAuthFailure, recordCredentialAuthSuccess } from '@/lib/credential-health';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Accept either CRON_SECRET (external scheduler) or Vercel's native cron header
  const isVercelCron = req.headers.get('x-vercel-cron') === '1';
  if (!isVercelCron) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (token !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // ── Codex credentials expiring within 1 hour ────────────────────────────────
  const expiringCodex = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'codex_credential'),
      isNotNull(secrets.tokenExpiresAt),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
    ),
    columns: { id: true },
  });

  const codexResults: Record<string, string> = {};
  let codexRefreshed = 0;
  let codexLocked = 0;
  let codexErrors = 0;
  let codexNoCredential = 0;

  for (const cred of expiringCodex) {
    const outcome = await refreshCodexCredential(cred.id);
    codexResults[cred.id] = outcome;
    if (outcome === 'refreshed') {
      codexRefreshed++;
      await recordCredentialAuthSuccess(cred.id);
    } else if (outcome === 'locked') {
      codexLocked++;
    } else if (outcome === 'error') {
      codexErrors++;
      await recordCredentialAuthFailure(cred.id, 'Codex token refresh failed');
    } else if (outcome === 'no_credential') {
      codexNoCredential++;
    }
  }

  console.log(
    `[Cron] Codex token refresh: checked=${expiringCodex.length} refreshed=${codexRefreshed} locked=${codexLocked} errors=${codexErrors}`,
  );

  // ── Claude credentials (claude_credential) expiring within 1 hour ───────────
  // Skip revoked rows — 400/401 from Anthropic means the refresh_token family is
  // permanently dead. Retrying wastes calls and won't recover; the user must reconnect.
  const expiringClaude = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'claude_credential'),
      isNotNull(secrets.tokenExpiresAt),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
      ne(secrets.healthStatus, 'revoked'),
    ),
    columns: { id: true },
  });

  const claudeRefreshResults: Record<string, string> = {};
  let claudeRefreshed = 0;
  let claudeLocked = 0;
  let claudeErrors = 0;
  let claudeNoCredential = 0;

  for (const cred of expiringClaude) {
    const outcome = await refreshClaudeCredential(cred.id);
    claudeRefreshResults[cred.id] = outcome;
    if (outcome === 'refreshed') claudeRefreshed++;
    else if (outcome === 'locked') claudeLocked++;
    else if (outcome === 'error') claudeErrors++;
    else if (outcome === 'no_credential') claudeNoCredential++;
  }

  console.log(
    `[Cron] Claude token refresh: checked=${expiringClaude.length} refreshed=${claudeRefreshed} locked=${claudeLocked} errors=${claudeErrors}`,
  );

  // ── Zombie claude_credential detection ────────────────────────────────────────
  // Rows with tokenExpiresAt = null (set by 400/401 on refresh) are permanently dead.
  // Log them so ops can see which workspaces need user reconnect. Workers fall back to
  // the setup token (oauth_token purpose) automatically via the health-aware resolver,
  // so these zombies don't block work — but they silently imply the managed refresh
  // is disabled until the user reconnects.
  const zombieClaude = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'claude_credential'),
      isNull(secrets.tokenExpiresAt),
    ),
    columns: { id: true, teamId: true, workspaceId: true, healthStatus: true, lastVerificationError: true },
  });

  if (zombieClaude.length > 0) {
    for (const z of zombieClaude) {
      console.warn(
        `[Cron] Zombie claude_credential: id=${z.id} team=${z.teamId} workspace=${z.workspaceId ?? 'team-wide'} healthStatus=${z.healthStatus} lastError=${z.lastVerificationError ?? 'none'} — user must reconnect`,
      );
    }
  }

  // ── MCP connector credentials expiring within 10 minutes ───────────────────
  // Only query rows that have a tokenExpiresAt — header-auth secrets never set it.
  const expiringMcp = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'mcp_connector_credential'),
      isNotNull(secrets.tokenExpiresAt),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '10 minutes'`),
    ),
    columns: { id: true },
  });

  const mcpResults: Record<string, string> = {};
  let mcpRefreshed = 0;
  let mcpLocked = 0;
  let mcpErrors = 0;
  let mcpExpired = 0;
  let mcpSkipped = 0;

  for (const cred of expiringMcp) {
    const outcome = await refreshMcpConnectorCredential(cred.id);
    mcpResults[cred.id] = outcome;
    if (outcome === 'refreshed') mcpRefreshed++;
    else if (outcome === 'locked') mcpLocked++;
    else if (outcome === 'error') mcpErrors++;
    else if (outcome === 'expired') mcpExpired++;
    else if (outcome === 'skipped') mcpSkipped++;
  }

  console.log(
    `[Cron] MCP connector refresh: checked=${expiringMcp.length} refreshed=${mcpRefreshed} locked=${mcpLocked} errors=${mcpErrors} expired=${mcpExpired} skipped=${mcpSkipped}`,
  );

  // ── Claude credential verification (active liveness ping) ──────────────────
  // Catch out-of-band revocations (e.g. user logged out from another device)
  // that would otherwise only surface at next worker spawn failure.
  const claudeCreds = await db.query.secrets.findMany({
    where: or(
      eq(secrets.purpose, 'oauth_token'),
      eq(secrets.purpose, 'anthropic_api_key'),
    ),
    columns: { id: true, purpose: true },
  });

  const claudeVerifyResults: Record<string, { verified: boolean; error: string | null }> = {};
  let claudeVerified = 0;
  let claudeFailed = 0;

  for (const cred of claudeCreds) {
    const result = await verifyClaudeCredential(cred.id);
    claudeVerifyResults[cred.id] = result;
    if (result.verified) claudeVerified++;
    else claudeFailed++;
  }

  console.log(
    `[Cron] Claude credential verification: checked=${claudeCreds.length} verified=${claudeVerified} failed=${claudeFailed}`,
  );

  return NextResponse.json({
    codex: {
      checked: expiringCodex.length,
      refreshed: codexRefreshed,
      locked: codexLocked,
      errors: codexErrors,
      noCredential: codexNoCredential,
      secrets: codexResults,
    },
    claudeRefresh: {
      checked: expiringClaude.length,
      refreshed: claudeRefreshed,
      locked: claudeLocked,
      errors: claudeErrors,
      noCredential: claudeNoCredential,
      secrets: claudeRefreshResults,
      zombies: zombieClaude.length,
    },
    mcp: {
      checked: expiringMcp.length,
      refreshed: mcpRefreshed,
      locked: mcpLocked,
      errors: mcpErrors,
      expired: mcpExpired,
      skipped: mcpSkipped,
      secrets: mcpResults,
    },
    claudeVerify: {
      checked: claudeCreds.length,
      verified: claudeVerified,
      failed: claudeFailed,
      secrets: claudeVerifyResults,
    },
  });
}
