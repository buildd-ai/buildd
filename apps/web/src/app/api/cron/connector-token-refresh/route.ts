// Cron endpoint: GET /api/cron/connector-token-refresh
//
// Proactively refreshes and verifies the credentials buildd itself holds:
//   1. MCP connector OAuth tokens due within this cron's own cadence (standard OAuth 2.1 refresh)
//   2. The Anthropic API key (canonical or legacy storage) — cheap GET /v1/models ping to catch
//      out-of-band revocations between spawns
//
// Formerly /api/cron/codex-token-refresh, which also refreshed stored Codex and
// Claude subscription logins. buildd no longer stores, refreshes or serves one,
// so what is left is connector refresh, and the route is named for it. The old
// path stays as an alias (../codex-token-refresh/route.ts) until the external
// scheduler has been re-synced to this one.
//
// Auth: Bearer CRON_SECRET, via withCronRun. The only accepted credential —
// platform-native cron does not fire in this project (cron-manifest.json).
// Schedule: every 4 hours.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { eq, isNull, lt, or, sql } from 'drizzle-orm';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';
import { verifyAnthropicApiKey } from '@/lib/anthropic-auth';
import { agentKeyPurposes, isAgentKeyRow } from '@buildd/core/providers/agent-keys';
import { sweepLookaheadMinutes } from '@/lib/cron-cadence';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { sqlWhere } from '@buildd/core/db/relational-sql';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('connector-token-refresh', req, report => runCronJob(req, report));
}

async function runCronJob(_req: NextRequest, report: CronReport): Promise<NextResponse> {
  // ── MCP connector credentials due for refresh ──────────────────────────────
  // The window is derived from this cron's own cadence (cron-cadence.ts), not
  // hand-typed: it used to look 10 minutes ahead while the cron ran every 4
  // hours, so anything expiring in (10min, 4h] was only seen *after* it died.
  //
  // A NULL tokenExpiresAt is included, not excluded. It is not a healthy state
  // for an OAuth credential — it is either an AS that omitted `expires_in`, or a
  // credential this sweep previously marked dead (the failure path nulls it).
  // Excluding it meant such a row was never retried again, so a manual reconnect
  // was the only way out. Non-OAuth secrets also match, and short-circuit to
  // 'skipped' after one cheap connector lookup.
  //
  // Not moved to runner-side: MCP servers are often remote, not colocated with the runner.
  const mcpLookaheadMinutes = sweepLookaheadMinutes();
  const expiringMcp = await db.query.secrets.findMany({
    where: sqlWhere(teamCredentialWhere(
      { purpose: 'mcp_connector_credential' },
      or(
        isNull(secrets.tokenExpiresAt),
        lt(secrets.tokenExpiresAt, sql`NOW() + (${mcpLookaheadMinutes} * INTERVAL '1 minute')`),
      ),
    )),
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
    `[Cron] MCP connector refresh: lookahead=${mcpLookaheadMinutes}m checked=${expiringMcp.length} refreshed=${mcpRefreshed} locked=${mcpLocked} errors=${mcpErrors} expired=${mcpExpired} skipped=${mcpSkipped}`,
  );

  // ── Anthropic API key verification (active liveness ping) ──────────────────
  // Catch out-of-band revocations that would otherwise only surface at the next
  // worker spawn failure. A team's key is read by agent runs from canonical
  // storage (`inference_key` + label `anthropic`) as well as the legacy purpose,
  // so both are pinged. That purpose also holds other providers' and personal
  // keys, which are dropped.
  const keyRows = (await db.query.secrets.findMany({
    where: sqlWhere(or(...agentKeyPurposes('anthropic').map((p) => eq(secrets.purpose, p)))),
    columns: { id: true, purpose: true, label: true, userId: true },
  })).filter((r) => !r.userId && isAgentKeyRow(r, 'anthropic'));

  const keyVerifyResults: Record<string, { verified: boolean; error: string | null }> = {};
  let keysVerified = 0;
  let keysFailed = 0;

  for (const cred of keyRows) {
    const result = await verifyAnthropicApiKey(cred.id);
    keyVerifyResults[cred.id] = result;
    if (result.verified) keysVerified++;
    else keysFailed++;
  }

  console.log(
    `[Cron] Anthropic API key verification: checked=${keyRows.length} verified=${keysVerified} failed=${keysFailed}`,
  );

  // A token-refresh job that silently stops refreshing is how every credential
  // in the system expires at once, so the health signal is the connector sweep.
  report({
    processed: expiringMcp.length,
    changed: mcpRefreshed,
    errors: mcpErrors,
    result: {
      mcp: { checked: expiringMcp.length, refreshed: mcpRefreshed, errors: mcpErrors },
      apiKeys: { checked: keyRows.length, verified: keysVerified, failed: keysFailed },
    },
  });

  return NextResponse.json({
    mcp: {
      checked: expiringMcp.length,
      refreshed: mcpRefreshed,
      locked: mcpLocked,
      errors: mcpErrors,
      expired: mcpExpired,
      skipped: mcpSkipped,
      secrets: mcpResults,
    },
    apiKeyVerify: {
      checked: keyRows.length,
      verified: keysVerified,
      failed: keysFailed,
      secrets: keyVerifyResults,
    },
  });
}
