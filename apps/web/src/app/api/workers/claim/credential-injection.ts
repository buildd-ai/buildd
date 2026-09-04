/**
 * Credential injection — attaches decrypted agent-backend credentials to the
 * claim response so the runner never needs DB access.
 *
 * Every function here is a no-op without ENCRYPTION_KEY, and every failure is
 * non-fatal: a claim must still succeed with no credentials attached (the
 * worker can fall back to local ones).
 *
 * Runner trust model: access is gated on the same API key auth used for all
 * claim requests. Any account-level API key can receive decrypted tokens for
 * tasks in workspaces it can claim. There is no concept of a "public-repo
 * runner" in this architecture — runners are private processes that present a
 * buildd API key. If an API key is compromised, the attacker gains the same
 * access as the key holder. Protect API keys accordingly.
 */
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import { getSecretsProvider } from '@buildd/core/secrets';
import { resolveCodexCredential } from '@/lib/codex-credential';
import { resolveClaudeCredential } from '@/lib/claude-credential';

/** The claim-candidate rows the credential blocks look tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

/**
 * Attach inline decrypted server-managed credentials (Anthropic API key and/or
 * OAuth token, plus flat mcp_credential values).
 *
 * Secrets are scoped by the task's workspace team to prevent cross-team leakage.
 */
export async function attachServerManagedSecrets(
  claimedWorkers: ClaimTasksResponse['workers'],
  accountId: string,
): Promise<void> {
  if (claimedWorkers.length === 0 || !process.env.ENCRYPTION_KEY) return;
  try {
    const provider = getSecretsProvider();

    for (const cw of claimedWorkers) {
      const task = cw.task as any;
      const workspaceTeamId = task?.workspace?.teamId;

      if (!workspaceTeamId) continue;
      // Codex tasks use OpenAI credentials, not Anthropic. Skip injecting
      // Anthropic secrets so they don't reach the Codex CLI subprocess and
      // cause spurious Claude auth errors if the team's Claude token is bad.
      if (task?.backend === 'codex') continue;

      const workerSecrets = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, workspaceTeamId),
          inArray(secrets.purpose, ['anthropic_api_key', 'oauth_token', 'mcp_credential']),
          or(
            isNull(secrets.accountId),
            eq(secrets.accountId, accountId),
          ),
          or(
            isNull(secrets.workspaceId),
            eq(secrets.workspaceId, task.workspaceId),
          ),
        ),
        columns: { id: true, purpose: true, label: true, healthStatus: true, updatedAt: true },
      });

      if (workerSecrets.length === 0) continue;

      // Pick the best row per purpose: prefer a non-revoked credential, then the
      // most recently updated. With replaceScoped enforcing one row per scope this
      // is normally a single row; the ordering is defense-in-depth so a stale or
      // revoked leftover can never shadow a healthy credential (the bug that let a
      // revoked token be handed to workers while a fresh one sat unused).
      const pickBest = (purpose: string) =>
        workerSecrets
          .filter(s => s.purpose === purpose)
          .sort((a, b) =>
            (a.healthStatus === 'revoked' ? 1 : 0) - (b.healthStatus === 'revoked' ? 1 : 0) ||
            (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))[0];

      const apiKeySecret = pickBest('anthropic_api_key');
      const oauthSecret = pickBest('oauth_token');

      const [decryptedApiKey, decryptedOauthToken] = await Promise.all([
        apiKeySecret ? provider.get(apiKeySecret.id) : null,
        oauthSecret ? provider.get(oauthSecret.id) : null,
      ]);

      if (decryptedApiKey) {
        (cw as any).serverApiKey = decryptedApiKey;
      }
      if (decryptedOauthToken) {
        (cw as any).serverOauthToken = decryptedOauthToken;
      }
      // Inject mcp_credential secrets as flat mcpSecrets so the runner can resolve
      // ${VAR} references in .mcp.json HTTP headers. The connector system only
      // supports a single headerName per connector — it cannot model servers like
      // Cue that require two headers (x-api-key + x-tenant-id). mcp_credential
      // secrets keyed by their label (the env var name) remain the viable path
      // until connectors gain a headers JSONB column.
      const mcpCredSecrets = workerSecrets.filter(s => s.purpose === 'mcp_credential');
      if (mcpCredSecrets.length > 0) {
        const mcpSecretsMap: Record<string, string> = {};
        await Promise.all(mcpCredSecrets.map(async (s) => {
          if (!s.label) return;
          const val = await provider.get(s.id).catch(() => null);
          if (val) mcpSecretsMap[s.label] = val;
        }));
        if (Object.keys(mcpSecretsMap).length > 0) {
          (cw as any).mcpSecrets = mcpSecretsMap;
          console.log(`[claim] Injected ${Object.keys(mcpSecretsMap).length} mcp_credential secret(s) for worker ${cw.id}: ${Object.keys(mcpSecretsMap).join(', ')}`);
        }
      }
    }
  } catch (err) {
    // Non-fatal: worker can still use local credentials
    console.warn('Failed to decrypt server-managed secrets:', err);
  }
}

/**
 * Attach the Codex credential for codex-backend tasks only — never for other
 * backends, to limit token exposure.
 *
 * Refresh is runner-side (see `pendingCredentialRefreshes`); this only reads.
 */
export async function attachCodexCredentials(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) return;
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if ((task as any)?.backend !== 'codex') continue;

    const wsId = task?.workspaceId;
    const teamId = (task as any)?.workspace?.teamId;
    if (!wsId || !teamId) continue;

    try {
      // Resolve the most-specific credential: workspace > account > team-wide.
      // Refresh is now runner-side (pendingCredentialRefreshes); we only read the DB here.
      const cred = await resolveCodexCredential({ teamId, accountId, workspaceId: wsId });
      if (cred) {
        (cw as any).codexCredential = {
          credentialType: cred.credentialType,
          // OAuth fields (only set for OAuth credentials)
          ...(cred.credentialType === 'oauth'
            ? {
                accessToken: cred.accessToken,
                refreshToken: cred.refreshToken,
                accountId: cred.accountId,
                idToken: cred.idToken,
              }
            : {}),
          // API key (only set for api_key credentials)
          ...(cred.credentialType === 'api_key' ? { apiKey: cred.apiKey } : {}),
          expiresAt: cred.tokenExpiresAt,
        };
      }
    } catch (err) {
      console.warn(`[claim] Failed to fetch Codex credential for workspace ${wsId}:`, err);
    }
  }
}

/**
 * Attach the managed Claude OAuth credential (claude_credential) for
 * Claude-backend tasks.
 *
 * Workers receive ONLY the access_token — never the refresh_token. This
 * prevents in-session token rotation: with no refresh_token in the credentials
 * file the SDK cannot call Anthropic's token endpoint, which eliminates the
 * "token family revocation" cascade that occurs when multiple workers rotate
 * concurrently.
 *
 * Refresh is runner-side: the runner calls /api/runner/credential-refresh
 * before spawning its subprocess when pendingCredentialRefreshes is non-empty.
 * The cron job nudges runners proactively before tokens expire.
 */
export async function attachClaudeCredentials(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) return;
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    // Only inject for Claude-backend tasks; Codex tasks already handled above.
    if ((task as any)?.backend === 'codex') continue;

    const wsId = task?.workspaceId;
    const teamId = (task as any)?.workspace?.teamId;
    if (!wsId || !teamId) continue;

    try {
      // Refresh is now runner-side (pendingCredentialRefreshes); we only read the DB here.
      // NOTE: credentials with healthStatus = 'revoked' (killed by prior Vercel IP-flip refreshes)
      // cannot be recovered by this cutover — users must reconnect via the OAuth device-code flow.
      // The first refresh after reconnect comes from the runner (workers.ts BUILDD_RUNNER_REFRESH gate).
      const cred = await resolveClaudeCredential({ teamId, workspaceId: wsId });
      if (cred) {
        (cw as any).claudeAccessToken = cred.accessToken;
        (cw as any).claudeTokenExpiresAt = cred.tokenExpiresAt ? cred.tokenExpiresAt.toISOString() : null;
        console.log(`[claim] Attached claude_credential access_token for workspace ${wsId}`);
      }
    } catch (err) {
      console.warn(`[claim] Failed to fetch Claude credential for workspace ${wsId}:`, err);
    }
  }
}

/**
 * Populate `pendingCredentialRefreshes`: credentials expiring within 2 hours
 * that the runner should pre-refresh before spawning its subprocess. Both
 * claude_credential and codex_credential rows visible to each task's
 * workspace/team are included.
 *
 * Server-side claim-gate refresh has been removed; the runner is the sole
 * refresh origin.
 */
export async function attachPendingCredentialRefreshes(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) return;
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    const wsId = task?.workspaceId;
    const teamId = (task as any)?.workspace?.teamId;
    if (!wsId || !teamId) continue;

    try {
      const twoHoursFromNow = sql`NOW() + INTERVAL '2 hours'`;
      const pendingRows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, teamId),
          inArray(secrets.purpose, ['claude_credential', 'codex_credential']),
          not(eq(secrets.healthStatus, 'revoked')),
          isNotNull(secrets.tokenExpiresAt),
          lt(secrets.tokenExpiresAt, twoHoursFromNow),
          or(isNull(secrets.workspaceId), eq(secrets.workspaceId, wsId)),
        ),
        columns: { id: true, purpose: true, tokenExpiresAt: true },
      });

      if (pendingRows.length > 0) {
        (cw as any).pendingCredentialRefreshes = pendingRows.map(row => ({
          secretId: row.id,
          purpose: row.purpose as 'claude_credential' | 'codex_credential',
          expiresAt: row.tokenExpiresAt ? (row.tokenExpiresAt as Date).toISOString() : null,
        }));
      }
    } catch (err) {
      console.warn(`[claim] Failed to query pending credential refreshes for workspace ${wsId}:`, err);
    }
  }
}
