// Cron endpoint: GET /api/cron/codex-token-refresh
//
// Proactively refreshes three credential types:
//   1. Codex OAuth tokens expiring within 1 hour (OpenAI rotates refresh token on each use)
//   2. Claude OAuth tokens expiring within 1 hour (Anthropic rotates refresh token on each use)
//   3. MCP connector OAuth tokens expiring within 10 minutes (standard OAuth 2.1 refresh)
//
// Auth: Bearer token matching CRON_SECRET env var.
// Recommended schedule: every 4 hours.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { refreshCodexCredential } from '@/lib/codex-credential';
import { refreshClaudeCredential } from '@/lib/claude-credential';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';

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

  // ── Codex credentials expiring within 1 hour ────────────────────────────────
  const expiringCodex = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'codex_credential'),
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
    if (outcome === 'refreshed') codexRefreshed++;
    else if (outcome === 'locked') codexLocked++;
    else if (outcome === 'error') codexErrors++;
    else if (outcome === 'no_credential') codexNoCredential++;
  }

  console.log(
    `[Cron] Codex token refresh: checked=${expiringCodex.length} refreshed=${codexRefreshed} locked=${codexLocked} errors=${codexErrors}`,
  );

  // ── Claude credentials expiring within 1 hour ───────────────────────────────
  const expiringClaude = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'claude_credential'),
      isNotNull(secrets.tokenExpiresAt),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
    ),
    columns: { id: true },
  });

  const claudeResults: Record<string, string> = {};
  let claudeRefreshed = 0;
  let claudeLocked = 0;
  let claudeErrors = 0;
  let claudeNoCredential = 0;

  for (const cred of expiringClaude) {
    const outcome = await refreshClaudeCredential(cred.id);
    claudeResults[cred.id] = outcome;
    if (outcome === 'refreshed') claudeRefreshed++;
    else if (outcome === 'locked') claudeLocked++;
    else if (outcome === 'error') claudeErrors++;
    else if (outcome === 'no_credential') claudeNoCredential++;
  }

  console.log(
    `[Cron] Claude token refresh: checked=${expiringClaude.length} refreshed=${claudeRefreshed} locked=${claudeLocked} errors=${claudeErrors}`,
  );

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

  return NextResponse.json({
    codex: {
      checked: expiringCodex.length,
      refreshed: codexRefreshed,
      locked: codexLocked,
      errors: codexErrors,
      noCredential: codexNoCredential,
      secrets: codexResults,
    },
    claude: {
      checked: expiringClaude.length,
      refreshed: claudeRefreshed,
      locked: claudeLocked,
      errors: claudeErrors,
      noCredential: claudeNoCredential,
      secrets: claudeResults,
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
  });
}
