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
//
// Mode:
//   BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true  → direct token-endpoint calls from Vercel (opt-in fallback)
//   default (unset)                           → nudge mode: per-credential runner tasks

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { refreshCodexCredential } from '@/lib/codex-credential';
import { refreshClaudeCredential, verifyClaudeCredential } from '@/lib/claude-credential';
import { refreshMcpConnectorCredential } from '@/lib/mcp-connector-refresh';
import { recordCredentialAuthSuccess } from '@/lib/credential-health';
import { notifyTeam } from '@/lib/notify';

export const maxDuration = 60;

// For team-wide secrets (workspaceId = null), look up any workspace for the team.
async function resolveWorkspaceForTeam(
  teamId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(teamId)) return cache.get(teamId)!;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.teamId, teamId),
    columns: { id: true },
  });
  const wsId = ws?.id ?? null;
  cache.set(teamId, wsId);
  return wsId;
}

// Create a nudge task for a credential refresh if one is not already pending.
// Returns 'nudged' if a new task was created, 'deduped' if one already exists,
// or 'no_workspace' if no workspace could be resolved for the credential.
async function nudgeCredentialRefresh(
  credId: string,
  purpose: 'codex_credential' | 'claude_credential',
  credWorkspaceId: string | null,
  teamId: string,
  teamWorkspaceCache: Map<string, string | null>,
): Promise<'nudged' | 'deduped' | 'no_workspace'> {
  const wsId = credWorkspaceId ?? (await resolveWorkspaceForTeam(teamId, teamWorkspaceCache));
  if (!wsId) return 'no_workspace';

  const title = `[sys] refresh credential ${credId}`;
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.title, title), eq(tasks.status, 'pending')),
    columns: { id: true },
  });
  if (existing) return 'deduped';

  await db.insert(tasks).values({
    workspaceId: wsId,
    title,
    description: `Refresh expiring ${purpose} credential.\n\nSecretId: ${credId}\nPurpose: ${purpose}\n\nCall POST /api/runner/credential-refresh with secretId, purpose, and action=lock to claim the refresh lock, then action=commit with the new tokens.`,
    priority: 50,
    tier: 'budget',
    outputRequirement: 'none',
  });
  return 'nudged';
}

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

  const ALLOW_CONTROL_PLANE_REFRESH = process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH === 'true';

  // ── Codex credentials expiring within 1 hour ────────────────────────────────
  // Skip revoked rows — invalid_grant permanently kills the refresh_token family.
  // Retrying wastes calls and rotates no new token.
  const expiringCodex = await db.query.secrets.findMany({
    where: and(
      eq(secrets.purpose, 'codex_credential'),
      isNotNull(secrets.tokenExpiresAt),
      lt(secrets.tokenExpiresAt, sql`NOW() + INTERVAL '1 hour'`),
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
  let codexNudged = 0;
  let codexDeduped = 0;

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
  } else {
    // Nudge mode: create runner tasks to refresh instead of direct token-endpoint calls.
    // IP-flip on Vercel's rotating egress is the root cause of invalid_grant revocations;
    // delegating to a colocated runner avoids the IP change.
    const teamWorkspaceCache = new Map<string, string | null>();
    for (const cred of expiringCodex) {
      const outcome = await nudgeCredentialRefresh(
        cred.id,
        'codex_credential',
        cred.workspaceId ?? null,
        cred.teamId,
        teamWorkspaceCache,
      );
      codexResults[cred.id] = outcome;
      if (outcome === 'nudged') codexNudged++;
      else if (outcome === 'deduped') codexDeduped++;
    }
  }

  console.log(
    ALLOW_CONTROL_PLANE_REFRESH
      ? `[Cron] Codex token refresh: checked=${expiringCodex.length} refreshed=${codexRefreshed} locked=${codexLocked} errors=${codexErrors} revoked=${codexRevoked}`
      : `[Cron] Codex token nudge: checked=${expiringCodex.length} nudged=${codexNudged} deduped=${codexDeduped}`,
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
    columns: { id: true, teamId: true, workspaceId: true },
  });

  const claudeRefreshResults: Record<string, string> = {};
  let claudeRefreshed = 0;
  let claudeLocked = 0;
  let claudeErrors = 0;
  let claudeNoCredential = 0;
  let claudeNudged = 0;
  let claudeDeduped = 0;

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
  } else {
    // Nudge mode: create runner tasks to refresh instead of direct token-endpoint calls.
    const teamWorkspaceCache = new Map<string, string | null>();
    for (const cred of expiringClaude) {
      const outcome = await nudgeCredentialRefresh(
        cred.id,
        'claude_credential',
        cred.workspaceId ?? null,
        cred.teamId,
        teamWorkspaceCache,
      );
      claudeRefreshResults[cred.id] = outcome;
      if (outcome === 'nudged') claudeNudged++;
      else if (outcome === 'deduped') claudeDeduped++;
    }
  }

  console.log(
    ALLOW_CONTROL_PLANE_REFRESH
      ? `[Cron] Claude token refresh: checked=${expiringClaude.length} refreshed=${claudeRefreshed} locked=${claudeLocked} errors=${claudeErrors}`
      : `[Cron] Claude token nudge: checked=${expiringClaude.length} nudged=${claudeNudged} deduped=${claudeDeduped}`,
  );

  // ── Zombie claude_credential detection ────────────────────────────────────────
  // Rows with tokenExpiresAt = null (set by 400/401 on refresh) are permanently dead.
  // Log them so ops can see which workspaces need user reconnect. Workers fall back to
  // the setup token (oauth_token purpose) automatically via the health-aware resolver,
  // so these zombies don't block work — but they silently imply the managed refresh
  // is disabled until the user reconnects.
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
        `[Cron] Zombie claude_credential: id=${z.id} team=${z.teamId} workspace=${z.workspaceId ?? 'team-wide'} healthStatus=${z.healthStatus} lastError=${z.lastVerificationError ?? 'none'} — user must reconnect`,
      );
    }
  }

  // ── MCP connector credentials expiring within 10 minutes ───────────────────
  // Only query rows that have a tokenExpiresAt — header-auth secrets never set it.
  // Not moved to runner-side: MCP servers are often remote, not colocated with the runner.
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

  const nudgeMode = !ALLOW_CONTROL_PLANE_REFRESH;
  const nudgedCredentials = codexNudged + claudeNudged;

  return NextResponse.json({
    nudgeMode,
    nudgedCredentials,
    codex: {
      checked: expiringCodex.length,
      ...(ALLOW_CONTROL_PLANE_REFRESH
        ? { refreshed: codexRefreshed, locked: codexLocked, errors: codexErrors, revoked: codexRevoked, noCredential: codexNoCredential }
        : { nudged: codexNudged, deduped: codexDeduped }),
      secrets: codexResults,
    },
    claudeRefresh: {
      checked: expiringClaude.length,
      ...(ALLOW_CONTROL_PLANE_REFRESH
        ? { refreshed: claudeRefreshed, locked: claudeLocked, errors: claudeErrors, noCredential: claudeNoCredential }
        : { nudged: claudeNudged, deduped: claudeDeduped }),
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
