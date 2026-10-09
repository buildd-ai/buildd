/**
 * The one write path for model-provider credentials.
 *
 * Every route that stores or removes a model credential calls these:
 * `/api/providers` (all providers and scopes), and the older routes that now
 * adapt onto it with their responses unchanged — `/api/secrets` (model
 * purposes), `/api/inference-keys`, `/api/teams/[id]/agent-endpoint` and
 * `/api/teams/[id]/litellm-gateway`. Which storage a (provider, shape, scope)
 * write lands in is `@buildd/core/providers/manage` `writeStorage`.
 *
 * Callers authorize before calling; nothing here checks permissions, except
 * the team policy check a personal chat key has always had (setProviderKey).
 *
 * Each storage keeps the function that has always validated and written it,
 * so the checks a form had (prefixes, verify-before-store, URL safety, the
 * blank-key-keeps-the-saved-one rule) are the ones this path applies. Loaded
 * lazily so a route pulls in only the storage it writes.
 */
import type { ChatProvider } from '@buildd/shared';

/** Model-credential purposes whose (re)store should put auth-failed tasks back in the queue. */
export const AGENT_AUTH_PURPOSES: ReadonlySet<string> = new Set(['oauth_token', 'anthropic_api_key', 'claude_credential', 'openai_api_key']);

/**
 * Is this storage an agent credential? The legacy agent purposes, and the
 * canonical Anthropic / OpenAI key (`inference_key` + provider label), which
 * agent runs read too (provider parity). Another provider's chat key is not.
 */
export function isAgentAuthStorage(purpose: string, label?: string | null): boolean {
  if (AGENT_AUTH_PURPOSES.has(purpose)) return true;
  if (purpose !== 'inference_key') return false;
  const l = (label ?? '').toLowerCase();
  return l === 'anthropic' || l === 'openai';
}

// ── API keys for chat (canonical `inference_key`, team-wide or personal) ────

export async function writeChatKey(input: { teamId: string; userId: string; provider: ChatProvider; scope: 'user' | 'team'; value: string }) {
  const { setProviderKey } = await import('@/lib/provider-keys');
  return setProviderKey(input);
}

export async function removeChatKey(input: { teamId: string; userId: string; provider: ChatProvider; scope: 'user' | 'team' }) {
  const { deleteProviderKey } = await import('@/lib/provider-keys');
  return deleteProviderKey(input);
}

/** Check an API key with its provider before storing it (the chat key form's check). */
export async function verifyApiKey(provider: ChatProvider, value: string) {
  const { verifyProviderKey } = await import('@buildd/core/inference-keys');
  return verifyProviderKey(provider, value);
}

// ── Any other stored model credential (a legacy purpose, or a workspace row) ─

export interface SharedSecretWrite {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
  purpose: string;
  label?: string | null;
  /** Already sanitized and validated by the caller. */
  value: string;
}

/**
 * Store a shared (non-personal) credential row, replacing the one at the same
 * scope. Returns the row id.
 */
export async function writeSharedSecret(input: SharedSecretWrite): Promise<string> {
  const { getSecretsProvider } = await import('@buildd/core/secrets');
  // Passed through as given: /api/secrets has always stored exactly what it computed.
  return getSecretsProvider().replaceScoped(input.value, {
    teamId: input.teamId,
    accountId: input.accountId as never,
    workspaceId: input.workspaceId as never,
    purpose: input.purpose as never,
    label: input.label as never,
  });
}

/** After an agent credential is stored: put tasks that failed on the old one back. Best-effort. */
export async function requeueAfterAgentCredential(teamId: string, purpose: string, label?: string | null): Promise<number> {
  if (!isAgentAuthStorage(purpose, label)) return 0;
  try {
    const { requeueAuthFailedTasks } = await import('@/lib/credential-recovery');
    return (await requeueAuthFailedTasks(teamId)).requeued.length;
  } catch (err) {
    console.warn('[providers] requeue-on-recovery failed (non-fatal):', err);
    return 0;
  }
}

// ── LiteLLM gateway (team-wide) ──────────────────────────────────────────────

export async function writeGateway(input: { teamId: string; baseUrl: unknown; apiKey: unknown }) {
  const { setTeamGateway } = await import('@/lib/litellm-gateway-settings');
  return setTeamGateway(input);
}

export async function removeGateway(teamId: string) {
  const { deleteTeamGateway } = await import('@/lib/litellm-gateway-settings');
  return deleteTeamGateway(teamId);
}

// ── Agent endpoint (team or workspace) ───────────────────────────────────────

export async function writeAgentEndpoint(input: { teamId: string; workspaceId?: unknown; endpoint: unknown }) {
  const { setTeamAgentEndpoint } = await import('@/lib/agent-endpoint-settings');
  return setTeamAgentEndpoint(input);
}

export async function removeAgentEndpoint(teamId: string, workspaceId: string | null) {
  const { deleteTeamAgentEndpoint } = await import('@/lib/agent-endpoint-settings');
  return deleteTeamAgentEndpoint(teamId, workspaceId);
}
