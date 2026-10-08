/**
 * Model auth variables for a runner-spawned agent.
 *
 * Invariant: server-managed Anthropic credentials (the team's API key or OAuth
 * seat, and a tenant's OAuth token) are only given to an agent whose model
 * traffic goes to Anthropic. When it goes anywhere else, at most one model auth
 * variable is set — the provider key, or failing that the operator's own
 * passthrough credential — and a variable that should be unset is deleted,
 * never left as ''.
 *
 * "Anywhere else" means a configured LLM provider with a base URL (OpenRouter
 * included), or an operator-set ANTHROPIC_BASE_URL whose origin is not
 * https://api.anthropic.com. The one exception is an origin the operator
 * explicitly trusts via BUILDD_TRUSTED_MODEL_BASE_URL (e.g. a local proxy that
 * forwards to Anthropic); unset by default, exact-origin match, and never
 * applied to a configured provider.
 *
 * A team agent model endpoint delivered on the claim (`modelEndpoint`,
 * docs/design/agent-model-endpoint.md) is applied here too: base URL, then
 * exactly one auth variable per its `authHeader`, every other one deleted. A
 * per-machine provider keeps priority over it (`teamEndpointIgnored`).
 *
 * Deferred tool loading (ToolSearch): Claude Code turns it off by itself for
 * any non-Anthropic ANTHROPIC_BASE_URL. `ENABLE_TOOL_SEARCH=true` is set only
 * for a Claude run under a team endpoint whose claim says `toolSearch` (the
 * winning row's effective capability) — derived per run, so one runner can
 * serve endpoints that differ. Every other path deletes the variable: it is
 * not in RUNNER_ENV_PASSTHROUGH, and an inherited one is never trusted.
 *
 * A Codex task applies it differently: `OPENAI_BASE_URL` = the endpoint's
 * `openAiBaseUrl`, `OPENAI_API_KEY` = its key — present only for an
 * OpenAI-compatible kind (gateway, openrouter). A machine that already has
 * `OPENAI_BASE_URL` set keeps it, the same way a per-machine Claude provider
 * keeps priority. An endpoint with no `openAiBaseUrl` (anthropic-compatible:
 * Anthropic Messages format only) can't serve Codex at all — the result
 * carries `error` instead of applying anything, so the caller fails the task
 * with a clear message rather than silently falling back to local auth.
 *
 * Pure: mutates and returns `env`, no I/O. The caller logs (and throws on
 * `error`).
 */
import type { ClaimModelEndpoint } from '@buildd/shared';
import { mapAgentModel } from '@buildd/core/agent-endpoint';
import type { ProviderConfig } from './types';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api';
/** Runner-side env var (not passed to the agent) naming a trusted base URL origin. */
export const TRUSTED_MODEL_BASE_URL_ENV = 'BUILDD_TRUSTED_MODEL_BASE_URL';

const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export type ServerCredential = 'serverApiKey' | 'serverOauthToken' | 'tenantOauthToken';

export interface ModelEnvInput {
  llmProvider?: ProviderConfig;
  serverApiKey?: string;
  serverOauthToken?: string;
  /** Already decrypted. */
  tenantOauthToken?: string;
  isCodexTask: boolean;
  /** Value of BUILDD_TRUSTED_MODEL_BASE_URL on the runner, if any. */
  trustedBaseUrl?: string;
  /** The team's agent model endpoint, when the claim delivered it. */
  modelEndpoint?: ClaimModelEndpoint;
  /** The claim said an endpoint won but withheld its key (this runner reported an override). */
  teamEndpointWithheld?: boolean;
  /** Native budget model; mapped through the endpoint into ANTHROPIC_DEFAULT_HAIKU_MODEL. */
  budgetModel?: string;
  /**
   * The runner machine's own Claude subscription login (host-seat.ts). When
   * set, it wins over a server-delivered seat: no `serverOauthToken` is
   * injected and no claim-delivered Claude credential is materialized.
   */
  hostSeat?: 'env' | 'login' | null;
}

export interface ModelEnvResult {
  env: Record<string, string>;
  /**
   * `anthropic`: default endpoint. `trusted`: operator-trusted origin.
   * `team`: the team's agent model endpoint from the claim. `custom`: anything else.
   */
  endpoint: 'anthropic' | 'trusted' | 'team' | 'custom';
  /** A team endpoint was delivered (or withheld for this runner) but the per-machine provider won. */
  teamEndpointIgnored: boolean;
  /**
   * Whether ENABLE_TOOL_SEARCH=true was set for this run (team endpoint,
   * Claude, `toolSearch`). For logs/telemetry only; carries no secret.
   */
  toolSearch: boolean;
  /** Origin of the effective base URL (no path, no userinfo), when one is set and parseable. */
  baseUrlOrigin?: string;
  injected: ServerCredential[];
  /** Server/tenant credentials that were available but not given to the agent. */
  withheld: ServerCredential[];
  /**
   * The machine's own login is the agent's Claude seat (Anthropic-bound,
   * non-Codex, no tenant token). The claim's Claude credential is then not
   * used either (`shouldUseClaudeCredential`).
   */
  hostSeatUsed?: boolean;
  /**
   * Set when a Codex task's team endpoint cannot serve Codex at all (an
   * `anthropic-compatible` endpoint — Anthropic Messages format only, no
   * OpenAI-compatible route). Nothing in `env` is changed for the endpoint in
   * this case; the caller must fail the task with this message rather than
   * fall back to local Codex auth as if no endpoint had been configured.
   */
  error?: string;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * The wire model names for a session through the team endpoint (§5). Without
 * one, unchanged. The native id stays the one recorded and priced.
 */
export function endpointSessionModels(
  endpoint: ClaimModelEndpoint | undefined,
  models: { model: string; fallbackModel?: string },
): { model: string; fallbackModel?: string } {
  if (!endpoint) return { model: models.model, fallbackModel: models.fallbackModel };
  return {
    model: mapAgentModel(endpoint, models.model),
    fallbackModel: models.fallbackModel ? mapAgentModel(endpoint, models.fallbackModel) : undefined,
  };
}

/**
 * Whether the runner writes the claim's Claude credential (the seat's access
 * token, or the broker-held one) into the session. Never under the team's
 * agent model endpoint: a Claude seat token must not ride along to a
 * third-party host.
 */
export function shouldUseClaudeCredential(
  modelEnv: Pick<ModelEnvResult, 'endpoint'> & { hostSeatUsed?: boolean },
  worker: { claudeAccessToken?: string | null; claudeCredentialId?: string | null },
): boolean {
  if (modelEnv.endpoint === 'team') return false;
  // The machine's own login wins over a server-delivered seat.
  if (modelEnv.hostSeatUsed) return false;
  return !!(worker.claudeAccessToken || worker.claudeCredentialId);
}

export const TOOL_SEARCH_ENV = 'ENABLE_TOOL_SEARCH';

export function applyModelEnv(env: Record<string, string>, input: ModelEnvInput): ModelEnvResult {
  const { llmProvider, serverApiKey, serverOauthToken, tenantOauthToken, isCodexTask } = input;

  // Only the team endpoint branch below may turn deferred tool loading on.
  delete env[TOOL_SEARCH_ENV];

  // A machine that already points OPENAI_BASE_URL somewhere specific keeps
  // that over the team's agent model endpoint — checked on the INCOMING env,
  // before anything below might set it.
  const codexMachineOverride = isCodexTask && !!env.OPENAI_BASE_URL;

  // Codex tasks run against OpenAI: an inherited Anthropic key must not reach
  // the Codex CLI subprocess.
  if (isCodexTask) delete env.ANTHROPIC_API_KEY;

  const teamEndpointIgnored = isCodexTask
    ? codexMachineOverride && (!!input.modelEndpoint || !!input.teamEndpointWithheld)
    : !!llmProvider && (!!input.modelEndpoint || !!input.teamEndpointWithheld);

  // The team endpoint: the only model credential this agent gets. A
  // per-machine provider/base-URL keeps priority, per backend.
  const teamEndpoint = isCodexTask
    ? (codexMachineOverride ? undefined : input.modelEndpoint)
    : (!llmProvider ? input.modelEndpoint : undefined);
  if (teamEndpoint) {
    const withheld: ServerCredential[] = [];
    if (serverApiKey) withheld.push('serverApiKey');
    if (serverOauthToken) withheld.push('serverOauthToken');
    if (tenantOauthToken) withheld.push('tenantOauthToken');

    if (isCodexTask) {
      if (!teamEndpoint.openAiBaseUrl) {
        return {
          env, endpoint: 'team', baseUrlOrigin: originOf(teamEndpoint.baseUrl), injected: [], withheld, teamEndpointIgnored: false, toolSearch: false,
          error: `The team's agent model endpoint (${teamEndpoint.kind}) speaks only the Anthropic Messages API — it has no OpenAI-compatible route for a Codex task. Configure an OpenAI-compatible endpoint (a LiteLLM gateway or OpenRouter) for this team/workspace, or run this task on a runner with its own OPENAI_BASE_URL / Codex credential.`,
        };
      }
      delete env.OPENAI_API_KEY;
      env.OPENAI_BASE_URL = teamEndpoint.openAiBaseUrl;
      env.OPENAI_API_KEY = teamEndpoint.authToken;
      return { env, endpoint: 'team', baseUrlOrigin: originOf(teamEndpoint.openAiBaseUrl), injected: [], withheld, teamEndpointIgnored: false, toolSearch: false };
    }

    for (const k of AUTH_VARS) delete env[k];
    env.ANTHROPIC_BASE_URL = teamEndpoint.baseUrl;
    env[teamEndpoint.authHeader === 'x-api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = teamEndpoint.authToken;
    if (input.budgetModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = mapAgentModel(teamEndpoint, input.budgetModel);
    const toolSearch = teamEndpoint.toolSearch === true;
    if (toolSearch) env[TOOL_SEARCH_ENV] = 'true';
    return { env, endpoint: 'team', baseUrlOrigin: originOf(teamEndpoint.baseUrl), injected: [], withheld, teamEndpointIgnored: false, toolSearch };
  }

  // A configured provider always means third-party model traffic.
  let providerKey: string | undefined;
  let providerConfigured = false;
  if (llmProvider?.provider === 'openrouter') {
    env.ANTHROPIC_BASE_URL = llmProvider.baseUrl || OPENROUTER_DEFAULT_BASE_URL;
    providerKey = llmProvider.apiKey || undefined;
    providerConfigured = true;
  } else if (llmProvider?.baseUrl) {
    env.ANTHROPIC_BASE_URL = llmProvider.baseUrl;
    providerKey = llmProvider.apiKey || undefined;
    providerConfigured = true;
  }

  const baseUrl = env.ANTHROPIC_BASE_URL;
  const baseUrlOrigin = originOf(baseUrl);
  const trustedOrigin = originOf(input.trustedBaseUrl);
  let endpoint: ModelEnvResult['endpoint'];
  if (providerConfigured) endpoint = 'custom';
  else if (!baseUrl || baseUrlOrigin === ANTHROPIC_API_ORIGIN) endpoint = 'anthropic';
  else if (trustedOrigin && baseUrlOrigin === trustedOrigin) endpoint = 'trusted';
  else endpoint = 'custom';

  const injected: ServerCredential[] = [];
  const withheld: ServerCredential[] = [];

  if (endpoint !== 'custom') {
    if (!isCodexTask && serverApiKey && !env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = serverApiKey;
      injected.push('serverApiKey');
    }
    // The machine's own seat (an env token, or `claude login` on the host)
    // wins: a server-delivered seat only fills in when the machine has none.
    const hostSeat = !isCodexTask && !tenantOauthToken && (input.hostSeat || (env.CLAUDE_CODE_OAUTH_TOKEN ? 'env' : null));
    if (!isCodexTask && serverOauthToken && !env.CLAUDE_CODE_OAUTH_TOKEN && !hostSeat) {
      env.CLAUDE_CODE_OAUTH_TOKEN = serverOauthToken;
      injected.push('serverOauthToken');
    }
    if (tenantOauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = tenantOauthToken;
      injected.push('tenantOauthToken');
    }
    return { env, endpoint, baseUrlOrigin, injected, withheld, teamEndpointIgnored, toolSearch: false, ...(hostSeat ? { hostSeatUsed: true } : {}) };
  }

  if (!isCodexTask && serverApiKey) withheld.push('serverApiKey');
  if (!isCodexTask && serverOauthToken) withheld.push('serverOauthToken');
  if (tenantOauthToken) withheld.push('tenantOauthToken');

  // Exactly one credential for the non-Anthropic host: the provider key, else
  // the operator's own (auth token preferred), else none.
  const chosen: [typeof AUTH_VARS[number], string] | undefined = providerKey
    ? ['ANTHROPIC_AUTH_TOKEN', providerKey]
    : env.ANTHROPIC_AUTH_TOKEN
      ? ['ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_AUTH_TOKEN]
      : env.ANTHROPIC_API_KEY
        ? ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY]
        : undefined;
  for (const k of AUTH_VARS) delete env[k];
  if (chosen) env[chosen[0]] = chosen[1];

  return { env, endpoint, baseUrlOrigin, injected, withheld, teamEndpointIgnored, toolSearch: false };
}
