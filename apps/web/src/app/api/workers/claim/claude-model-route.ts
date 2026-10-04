/**
 * Which model credential a Claude task's run will actually spend, decided at
 * claim time BEFORE the budget failover. The answer is what lets the claim
 * tell "the Claude OAuth seat is walled" apart from "this task does not use
 * the seat at all".
 *
 * It follows the same delivery rules as the credential attach steps further
 * down the claim (./agent-endpoint-injection, ./credential-injection) and the
 * cloud egress (apps/web/src/app/api/runner/model-endpoint/route.ts):
 *
 * - cloud executor: no credential is ever in the claim; egress applies the
 *   team endpoint, the team's own Anthropic key, or the dispatcher's own
 *   route, and never carries a seat token.
 * - the runner's own provider (`llmProviderOverride`): its per-machine
 *   provider wins, and the server seat/key are withheld.
 * - the team agent model endpoint, when it wins `resolveAgentModelRoute` and
 *   the runner declares the endpoint feature: the only model credential sent.
 * - a live `anthropic_api_key` visible to the task: delivered as
 *   ANTHROPIC_API_KEY, which Claude Code prefers over an OAuth token. Metered
 *   per token, not seat-bound.
 * - otherwise the OAuth seat (server `oauth_token`, `claude_credential`, or
 *   the runner's own login).
 *
 * Every doubt (a lookup error, no ENCRYPTION_KEY, no team) answers
 * `oauth_seat`: the pre-existing behaviour, where a walled seat defers or
 * fails the task over.
 */
import { resolveAgentModelRoute, type AgentModelDecision } from '@buildd/core/agent-endpoint';

export type ClaudeModelRoute =
  | 'oauth_seat'
  | 'agent_endpoint'
  | 'anthropic_api_key'
  | 'runner_provider'
  | 'cloud_egress';

/** The one seat predicate: budget failover, seat walls and OAuth pacing all read it. */
export function routeUsesOauthSeat(route: ClaudeModelRoute): boolean {
  return route === 'oauth_seat';
}

export interface ClaudeRouteInput {
  teamId?: string | null;
  workspaceId: string;
  accountId: string;
  cloudExecutor: boolean;
  llmProviderOverride: boolean;
  runnerSupportsEndpoint: boolean;
  encryptionKeySet: boolean;
}

export interface AnthropicKeyRow {
  accountId: string | null;
  workspaceId: string | null;
  healthStatus?: string | null;
}

export interface ClaudeRouteDeps {
  resolveEndpoint: (opts: { teamId: string; workspaceId: string; accountId: string; backend: 'claude' }) => Promise<AgentModelDecision | null>;
  listAnthropicKeys: (opts: { teamId: string; workspaceId: string; accountId: string }) => Promise<AnthropicKeyRow[]>;
}

async function listAnthropicKeys(opts: { teamId: string; workspaceId: string; accountId: string }): Promise<AnthropicKeyRow[]> {
  const { db } = await import('@buildd/core/db');
  const { secrets } = await import('@buildd/core/db/schema');
  const { eq, isNull, or } = await import('drizzle-orm');
  const { teamCredentialWhere } = await import('@buildd/core/secrets/team-scope');
  // Same scoping as attachServerManagedSecrets: team-wide, this account, this workspace.
  const rows = await db.query.secrets.findMany({
    where: teamCredentialWhere(
      { teamId: opts.teamId, purpose: 'anthropic_api_key' },
      or(isNull(secrets.accountId), eq(secrets.accountId, opts.accountId)),
      or(isNull(secrets.workspaceId), eq(secrets.workspaceId, opts.workspaceId)),
    ),
    columns: { accountId: true, workspaceId: true, healthStatus: true },
  });
  return (rows ?? []) as AnthropicKeyRow[];
}

// Read through the live import binding on each call, not captured once.
const DEFAULT_DEPS: ClaudeRouteDeps = {
  resolveEndpoint: (opts) => resolveAgentModelRoute(opts),
  listAnthropicKeys: (opts) => listAnthropicKeys(opts),
};

export async function resolveClaudeModelRoute(
  input: ClaudeRouteInput,
  deps: ClaudeRouteDeps = DEFAULT_DEPS,
): Promise<ClaudeModelRoute> {
  if (input.cloudExecutor) return 'cloud_egress';
  if (input.llmProviderOverride) return 'runner_provider';
  const teamId = input.teamId;
  if (!teamId || !input.encryptionKeySet) return 'oauth_seat';
  const scope = { teamId, workspaceId: input.workspaceId, accountId: input.accountId };
  try {
    if (input.runnerSupportsEndpoint) {
      const decision = await deps.resolveEndpoint({ ...scope, backend: 'claude' });
      if (decision?.winner === 'endpoint') return 'agent_endpoint';
    }
    const keys = await deps.listAnthropicKeys(scope);
    // Re-check the scoping in code so a loose query cannot widen it.
    const live = keys.some(k =>
      k.healthStatus !== 'revoked'
      && (!k.workspaceId || k.workspaceId === input.workspaceId)
      && (!k.accountId || k.accountId === input.accountId));
    if (live) return 'anthropic_api_key';
  } catch (err) {
    console.warn(`[claim] Claude model route lookup failed for workspace ${input.workspaceId}; treating it as the OAuth seat:`, err);
  }
  return 'oauth_seat';
}
