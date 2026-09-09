// Cron endpoint: GET /api/cron/codex-token-refresh
//
// Proactively refreshes and verifies agent-backend credentials:
//   1. Codex OAuth tokens expiring within 1 hour (OpenAI rotates refresh token on each use)
//   2. Claude OAuth tokens (claude_credential) expiring within 1 hour (Anthropic rotates refresh token on each use)
//   3. MCP connector OAuth tokens due within this cron's own cadence (standard OAuth 2.1 refresh)
//   4. Claude credentials (oauth_token / anthropic_api_key) — cheap GET /v1/models ping
//      to catch out-of-band revocations between spawns
//
// Auth: Bearer CRON_SECRET, via withCronRun. The only accepted credential —
// platform-native cron does not fire in this project (cron-manifest.json).
// Schedule: every 4 hours.
//
// Mode:
//   BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true  → direct token-endpoint calls from Vercel (opt-in break-glass)
//   default (unset)                          → observe only: count what is expiring, act on nothing
//
// Who actually refreshes: the runner-side credential broker
// (apps/runner/src/broker.ts → runnerRefreshCredential), which learns which
// credentials it holds from the claim response and refreshes them from a stable
// egress IP. This route does NOT hand the work to an agent. It used to, by
// filing a `[sys] refresh credential …` task per expiring credential — a title
// no runner code matched, so the row went down the ordinary claim path and a
// general-purpose agent picked it up, 401'd for want of a control-plane key, and
// failed. Every sweep. One of those agents also took the refresh lock, called
// the provider, and lost the rotated refresh token to output redaction; because
// the provider rotates on use, that killed the credential outright. The title
// leaked the credential's identifier into the dashboard and push notifications
// on the way. Filing work an agent cannot do is worse than filing nothing.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { refreshCodexCredential } from '@/lib/codex-credential';
import { refreshClaudeCredential, verifyClaudeCredential } from '@/lib/claude-credential';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';
import { recordCredentialAuthSuccess } from '@/lib/credential-health';
import { notifyTeam } from '@/lib/notify';
import { sweepLookaheadMinutes } from '@/lib/cron-cadence';
import { withCronRun, type CronReport } from '@/lib/cron-run';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return withCronRun('codex-token-refresh', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {

  const ALLOW_CONTROL_PLANE_REFRESH = process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH === 'true';

  // ── Codex credentials expiring within 1 hour ────────────────────────────────
  // Skip revoked rows — invalid_grant permanently kills the refresh_token family.
  // Retrying wastes calls and rotates no new token.
  //
  // A NULL tokenExpiresAt is swept in, not filtered out — same reasoning as the
  // connector branch below. NULL is not "no deadline", it is "we do not know
  // when this dies": the provider omitted expires_in, or a failed refresh
  // cleared the column. Under isNotNull() such a row dropped out of every
  // subsequent sweep, making the state a one-way trap with manual reconnect the
  // only exit.
  const expiringCodex = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'codex_credential'),
      or(
        isNull(secrets.tokenExpiresAt),
        lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
      ),
      ne(secrets.healthStatus, 'revoked'),
    ),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  const codexResults: Record<string, string> = {};
  let codexRefreshed = 0;
  let codexLocked = 0;
  let codexErrors = 0;
  let codexNoCredential = 0;
  let codexRevoked = 0;

  if (ALLOW_CONTROL_PLANE_REFRESH) {
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
      } else if (outcome === 'revoked') {
        // Provider permanently invalidated the refresh_token family (invalid_grant).
        // refreshCodexCredential already marked healthStatus='revoked' in the DB.
        // Alert the team immediately — this is a user-action-required event.
        codexRevoked++;
        void notifyTeam(cred.teamId, 'credentialExpired', {
          title: 'Codex credential revoked — action required',
          message: 'Your Codex (ChatGPT) OAuth session was revoked by OpenAI. Re-authenticate in Settings → Agent Backends to resume Codex tasks.',
          url: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev'}/app/settings`,
          urlTitle: 'Open settings',
          priority: 1,
        });
      } else if (outcome === 'no_credential') {
        codexNoCredential++;
      }
    }
  }
  // Flag off: the runner's broker refreshes these from its own stable IP. There
  // is nothing for the control plane to do but say what it saw.

  console.log(
    ALLOW_CONTROL_PLANE_REFRESH
      ? `[Cron] Codex token refresh: checked=${expiringCodex.length} refreshed=${codexRefreshed} locked=${codexLocked} errors=${codexErrors} revoked=${codexRevoked}`
      : `[Cron] Codex tokens expiring: checked=${expiringCodex.length} (observe only; runner broker owns refresh)`,
  );

  // ── Claude credentials (claude_credential) expiring within 1 hour ───────────
  // Skip revoked rows — 400/401 from Anthropic means the refresh_token family is
  // permanently dead. Retrying wastes calls and won't recover; the user must reconnect.
  //
  // NULL tokenExpiresAt is included for the same reason as the codex branch: an
  // unknown deadline needs a look, and excluding it guaranteed the row was
  // never looked at again. `healthStatus` is what marks a credential beyond
  // saving; a null column should not be doing that job silently.
  const expiringClaude = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'claude_credential'),
      or(
        isNull(secrets.tokenExpiresAt),
        lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
      ),
      ne(secrets.healthStatus, 'revoked'),
    ),
    columns: { id: true, teamId: true, workspaceId: true },
  });

  const claudeRefreshResults: Record<string, string> = {};
  let claudeRefreshed = 0;
  let claudeLocked = 0;
  let claudeErrors = 0;
  let claudeNoCredential = 0;

  if (ALLOW_CONTROL_PLANE_REFRESH) {
    // BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true: opt-in fallback that retains this
    // direct token-endpoint call from Vercel's rotating IP. Default OFF because
    // an IP-flip on the first refresh after a quiet period is the root cause of
    // invalid_grant revocations. Only set this flag if the runner is persistently
    // offline and you accept the revocation risk.
    for (const cred of expiringClaude) {
      const outcome = await refreshClaudeCredential(cred.id);
      claudeRefreshResults[cred.id] = outcome;
      if (outcome === 'refreshed') claudeRefreshed++;
      else if (outcome === 'locked') claudeLocked++;
      else if (outcome === 'error') claudeErrors++;
      else if (outcome === 'no_credential') claudeNoCredential++;
    }
  }
  // Flag off: observe only, as above.

  console.log(
    ALLOW_CONTROL_PLANE_REFRESH
      ? `[Cron] Claude token refresh: checked=${expiringClaude.length} refreshed=${claudeRefreshed} locked=${claudeLocked} errors=${claudeErrors}`
      : `[Cron] Claude tokens expiring: checked=${expiringClaude.length} (observe only; runner broker owns refresh)`,
  );

  // ── Zombie claude_credential detection ────────────────────────────────────────
  // Rows with tokenExpiresAt = null: a refresh that returned 400/401 clears the
  // column, and so does a token response without expires_in. The sweep above now
  // retries them rather than stranding them, so this is no longer a terminal
  // diagnosis — it is the ops view of which workspaces are running on an unknown
  // deadline. Workers fall back to the setup token (oauth_token purpose)
  // automatically via the health-aware resolver, so these don't block work — but
  // they silently imply managed refresh is degraded until the user reconnects.
  // Kept regardless of BUILDD_ALLOW_CONTROL_PLANE_REFRESH for ops visibility.
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
        `[Cron] Zombie claude_credential: id=${z.id} team=${z.teamId} workspace=${z.workspaceId ?? 'team-wide'} healthStatus=${z.healthStatus} lastError=${z.lastVerificationError ?? 'none'} — expiry unknown, managed refresh degraded until reconnect`,
      );
    }
  }

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
    where: and(
      eq(secrets.purpose, 'mcp_connector_credential'),
      or(
        isNull(secrets.tokenExpiresAt),
        lt(secrets.tokenExpiresAt, sql`NOW() + (${mcpLookaheadMinutes} * INTERVAL '1 minute')`),
      ),
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
    `[Cron] MCP connector refresh: lookahead=${mcpLookaheadMinutes}m checked=${expiringMcp.length} refreshed=${mcpRefreshed} locked=${mcpLocked} errors=${mcpErrors} expired=${mcpExpired} skipped=${mcpSkipped}`,
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

  // Three credential families in one sweep; the health signal is the sum. A
  // token-refresh job that silently stops refreshing is how every credential
  // in the system expires at once.
  //
  // With the flag off, codex/claude contribute 0 to `changed` by design — the
  // broker does that work and reports its own outcome. `changed` staying 0 does
  // not alarm on its own (see cron-health: it needs errors too), so an
  // observe-only pass reads as healthy idle, which is what it is.
  report({
    processed: expiringCodex.length + expiringClaude.length + expiringMcp.length,
    changed: codexRefreshed + claudeRefreshed + mcpRefreshed,
    errors: codexErrors + claudeErrors + mcpErrors,
    result: {
      controlPlaneRefresh: ALLOW_CONTROL_PLANE_REFRESH,
      codex: { checked: expiringCodex.length, refreshed: codexRefreshed, errors: codexErrors },
      claude: { checked: expiringClaude.length, refreshed: claudeRefreshed, errors: claudeErrors },
      mcp: { checked: expiringMcp.length, refreshed: mcpRefreshed, errors: mcpErrors },
    },
  });

  return NextResponse.json({
    // False means the runner-side broker owns codex/claude refresh and this pass
    // only counted. Without it, `checked: n` with no outcome fields is ambiguous.
    controlPlaneRefresh: ALLOW_CONTROL_PLANE_REFRESH,
    codex: {
      checked: expiringCodex.length,
      ...(ALLOW_CONTROL_PLANE_REFRESH
        ? { refreshed: codexRefreshed, locked: codexLocked, errors: codexErrors, revoked: codexRevoked, noCredential: codexNoCredential }
        : {}),
      secrets: codexResults,
    },
    claudeRefresh: {
      checked: expiringClaude.length,
      ...(ALLOW_CONTROL_PLANE_REFRESH
        ? { refreshed: claudeRefreshed, locked: claudeLocked, errors: claudeErrors, noCredential: claudeNoCredential }
        : {}),
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
