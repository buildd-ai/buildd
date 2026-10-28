/**
 * Credential injection — attaches decrypted agent-backend API keys to the
 * claim response so the runner never needs DB access.
 *
 * A claim carries no subscription (OAuth) login (model credentials spec R-2 /
 * AC-3): no stored login value of any kind. The runner uses its own machine
 * login (`claude login`, `codex login`) first, then an API key delivered here,
 * then refuses the task.
 *
 * Every function here is a no-op without ENCRYPTION_KEY, and every failure is
 * non-fatal: a claim must still succeed with no credentials attached (the
 * worker can fall back to local ones).
 *
 * Runner trust model: access is gated on the same API key auth used for all
 * claim requests. Any account-level API key can receive decrypted API keys for
 * tasks in workspaces it can claim. There is no concept of a "public-repo
 * runner" in this architecture — runners are private processes that present a
 * buildd API key. If an API key is compromised, the attacker gains the same
 * access as the key holder. Protect API keys accordingly.
 */
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { eq, isNull, or } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import { getSecretsProvider } from '@buildd/core/secrets';
import { resolveCodexApiKey } from '@/lib/codex-api-key';
import { resolveOpenAiApiKey } from '@/lib/openai-credential';
import { pickMostSpecificCredential, pickTeamAgentApiKey, teamCredentialWhere } from '@buildd/core/secrets/team-scope';
import { agentKeyPurposes } from '@buildd/core/providers/agent-keys';
import { sqlWhere } from '@buildd/core/db/relational-sql';

/** The claim-candidate rows the credential blocks look tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

/**
 * Attach inline decrypted server-managed credentials: the Anthropic API key
 * and flat mcp_credential values. A subscription login is never read or
 * delivered.
 *
 * The Anthropic key is read from its canonical storage (`inference_key` /
 * `anthropic`, the key chat uses) and its legacy alias (`anthropic_api_key`);
 * within one scope the canonical row wins (`pickTeamAgentApiKey`). Personal
 * rows are excluded in SQL (`teamCredentialWhere`) and again in the pick: a
 * requester's own key reaches a claim only via ./personal-credential-injection.
 *
 * Secrets are scoped by the task's workspace team to prevent cross-team leakage.
 */
export async function attachServerManagedSecrets(
  claimedWorkers: ClaimTasksResponse['workers'],
  accountId: string,
  /** Workers whose agent model endpoint won (./agent-endpoint-injection): no Anthropic key for them. */
  endpointWorkers: ReadonlySet<string> = new Set(),
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
        where: sqlWhere(teamCredentialWhere(
          { teamId: workspaceTeamId, purpose: [...agentKeyPurposes('anthropic'), 'mcp_credential'] },
          or(
            isNull(secrets.accountId),
            eq(secrets.accountId, accountId),
          ),
          or(
            isNull(secrets.workspaceId),
            eq(secrets.workspaceId, task.workspaceId),
          ),
        )),
        columns: {
          id: true, purpose: true, label: true, healthStatus: true, updatedAt: true,
          accountId: true, workspaceId: true, userId: true,
        },
      });

      if (workerSecrets.length === 0) continue;

      // Pick the best row per purpose with the documented precedence
      // (docs/credentials-architecture.md): a live row over a revoked one, then
      // the most specific scope (workspace > account > team-wide), then the most
      // recently updated. Sorting on recency alone let a newer team-wide key
      // shadow a workspace's own key; a revoked leftover must still never shadow
      // a healthy credential.
      const scopeTarget = { accountId, workspaceId: task.workspaceId };

      // The endpoint is the only model credential for its workers; MCP secrets
      // below are not model credentials and are still delivered.
      const endpointWon = endpointWorkers.has(cw.id);
      const apiKeySecret = endpointWon ? undefined : pickTeamAgentApiKey(workerSecrets, scopeTarget, 'anthropic');
      const decryptedApiKey = apiKeySecret ? await provider.get(apiKeySecret.id) : null;
      if (decryptedApiKey) {
        (cw as any).serverApiKey = decryptedApiKey;
      }
      // Inject mcp_credential secrets as flat mcpSecrets so the runner can resolve
      // ${VAR} references in .mcp.json HTTP headers. The connector system only
      // supports a single headerName per connector — it cannot model servers like
      // Cue that require two headers (x-api-key + x-tenant-id). mcp_credential
      // secrets keyed by their label (the env var name) remain the viable path
      // until connectors gain a headers JSONB column.
      // Many rows legitimately (one per env-var label), so precedence applies per
      // label: a workspace override of CUE_API_KEY beats the team-wide value of
      // CUE_API_KEY without touching any other label.
      const mcpByLabel = new Map<string, typeof workerSecrets>();
      for (const s of workerSecrets) {
        if (s.purpose !== 'mcp_credential' || !s.label) continue;
        mcpByLabel.set(s.label, [...(mcpByLabel.get(s.label) ?? []), s]);
      }
      const mcpCredSecrets = [...mcpByLabel.values()]
        .map(rows => pickMostSpecificCredential(rows, scopeTarget))
        .filter((s): s is NonNullable<typeof s> => !!s);
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
 * Attach a Codex API key for codex-backend tasks only — never for other
 * backends, to limit key exposure.
 *
 * Only API keys: one stored in a `codex_credential` row, else a plain
 * `openai_api_key`. A stored ChatGPT/OAuth login is never delivered (spec
 * R-2); the runner uses its own `codex login`.
 */
export async function attachCodexCredentials(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
  /** Workers whose agent model endpoint won: no Codex credential for them. */
  endpointWorkers: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) return;
  for (const cw of claimedWorkers) {
    if (endpointWorkers.has(cw.id)) continue;
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if ((task as any)?.backend !== 'codex') continue;

    const wsId = task?.workspaceId;
    const teamId = (task as any)?.workspace?.teamId;
    if (!wsId || !teamId) continue;

    try {
      // Most specific first: workspace > account > team-wide. A codex_credential
      // API key wins over a plain openai_api_key (purpose `openai_api_key`,
      // stored via Settings like `anthropic_api_key`). Both use the one `api_key`
      // wire shape, which writeCodexApiKeyToHome materializes into auth.json.
      // See docs/credentials-architecture.md for why these are two purposes.
      const scope = { teamId, accountId, workspaceId: wsId };
      const apiKey = (await resolveCodexApiKey(scope))?.apiKey ?? (await resolveOpenAiApiKey(scope))?.apiKey;
      if (apiKey) {
        (cw as any).codexCredential = { credentialType: 'api_key', apiKey, expiresAt: null };
      }
    } catch (err) {
      console.warn(`[claim] Failed to fetch Codex credential for workspace ${wsId}:`, err);
    }
  }
}
