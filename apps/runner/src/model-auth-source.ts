/**
 * Which paying route a self-hosted runner's Claude agent may use:
 * `BUILDD_MODEL_AUTH_SOURCE` on the runner.
 *
 * - unset / `auto` (default): unchanged. A server-delivered or inherited API
 *   key is used as before (agent-model-env.ts, host-seat.ts).
 * - `runner` ("runner-managed", no automatic paid fallback): the operator's own
 *   sign-in to the unmodified native `claude` CLI is the model auth. Metered
 *   credentials are used only when a paid route was deliberately selected:
 *     - the team's agent model endpoint on the claim (`modelEndpoint`),
 *     - this runner's own LLM_PROVIDER (OpenRouter / LiteLLM / gateway),
 *     - an operator-set ANTHROPIC_BASE_URL (its key belongs to that host).
 *   A team API key row, an inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 *   or any server-delivered seat is NOT consent to spend, so none of them
 *   reaches the agent. With no selected route and no local sign-in the run
 *   does not start ("No coding authentication available") and never retries
 *   on another paid route.
 *
 * buildd neither stores, reads nor validates the subscription login. Presence
 * is all this looks at (host-seat.ts), and no value is returned or logged.
 * Applies to Claude Coding runs only; Codex, Chat and inference calls are
 * outside this switch. Hosted managed runners never set it.
 */
import { detectHostSeat, type HostSeat, type HostSeatProbe } from './host-seat';

export const MODEL_AUTH_SOURCE_ENV = 'BUILDD_MODEL_AUTH_SOURCE';

export type ModelAuthSourceMode = 'auto' | 'runner';

/** Non-sensitive label for run diagnostics. */
export type ModelAuthSourceLabel = 'runner-managed' | 'api-provider';

export const NO_CODING_AUTH_MESSAGE =
  'No coding authentication available: this runner is set to runner-managed model auth '
  + `(${MODEL_AUTH_SOURCE_ENV}=runner) but is not logged in. Run \`claude login\` as the runner's user `
  + '(unauthenticated until then), or select a paid provider route. No paid fallback was used.';

export function modelAuthSourceMode(env: Record<string, string | undefined> = process.env): ModelAuthSourceMode {
  return (env[MODEL_AUTH_SOURCE_ENV] ?? '').trim().toLowerCase() === 'runner' ? 'runner' : 'auto';
}

export interface ModelAuthSourceInput {
  isCodexTask: boolean;
  /** The claim's runnerLocalAllowed (false: the claim carries the requester's own key). */
  runnerLocalAllowed: boolean;
  /** The team's agent model endpoint was delivered. A withheld one (modelEndpointIgnored) is not selected. */
  teamEndpointSelected: boolean;
  /** This runner's own LLM_PROVIDER is a paid route (openrouter or a base URL). */
  runnerProviderSelected: boolean;
  /** Cloud executor: egress decides, the runner holds no credential. */
  cloud?: boolean;
  probe?: HostSeatProbe;
}

export interface ModelAuthSourceDecision {
  mode: ModelAuthSourceMode;
  /** Whether this switch changes anything for the run. */
  active: boolean;
  label?: ModelAuthSourceLabel;
  /** Strip server-delivered API key / seat from the model env input. */
  dropServerCredentials: boolean;
  /** Strip inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the agent env. */
  dropInheritedApiKeys: boolean;
  /** Refuse to start: runner-managed with no local sign-in and no selected paid route. */
  blocked: boolean;
  localSeat: HostSeat | null;
}

export function decideModelAuthSource(
  env: Record<string, string | undefined>,
  input: ModelAuthSourceInput,
): ModelAuthSourceDecision {
  const mode = modelAuthSourceMode(env);
  const inert: ModelAuthSourceDecision = {
    mode, active: false, dropServerCredentials: false, dropInheritedApiKeys: false, blocked: false, localSeat: null,
  };
  if (mode !== 'runner' || input.isCodexTask || input.cloud || !input.runnerLocalAllowed) return inert;

  const operatorBaseUrl = (env.ANTHROPIC_BASE_URL ?? '').trim().length > 0;
  const paidSelected = input.teamEndpointSelected || input.runnerProviderSelected || operatorBaseUrl;
  if (paidSelected) {
    return { ...inert, active: true, label: 'api-provider' };
  }
  const localSeat = detectHostSeat({ ...input.probe, env: { ...(input.probe?.env ?? env) } });
  return {
    mode,
    active: true,
    label: 'runner-managed',
    dropServerCredentials: true,
    dropInheritedApiKeys: true,
    blocked: !localSeat,
    localSeat,
  };
}

/** Remove inherited metered credentials from the agent env (never reads their values). */
export function stripInheritedApiKeys(env: Record<string, string>): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
}

export interface ClaimCredentials {
  serverApiKey?: string;
  serverOauthToken?: string;
  tenantOauthToken?: string;
  claudeAccessToken?: string | null;
  claudeCredentialId?: string | null;
}

export interface ModelAuthSourceClaim {
  isCodexTask: boolean;
  runnerLocalAllowed: boolean;
  /** The claim's team agent model endpoint, if one was delivered. A withheld one (modelEndpointIgnored) is absent. */
  modelEndpoint?: unknown;
  llmProvider?: { provider?: string; baseUrl?: string } | null;
  cloud?: boolean;
  credentials: ClaimCredentials;
  probe?: HostSeatProbe;
}

export interface ResolvedModelAuthSource {
  decision: ModelAuthSourceDecision;
  /** The credentials the rest of the launch may consume: empty when server credentials are dropped. */
  credentials: ClaimCredentials;
  /** Whether a server-delivered Claude seat is present in `credentials`. */
  serverSeatDelivered: boolean;
}

/**
 * The launch-boundary glue: derives the selected-route inputs from the claim,
 * decides, throws NO_CODING_AUTH_MESSAGE when blocked (before any spawn), and
 * returns the only credentials later code may use. Callers must read claim
 * credentials from `credentials`, never from the claim directly.
 */
export function resolveModelAuthSource(
  env: Record<string, string | undefined>,
  claim: ModelAuthSourceClaim,
): ResolvedModelAuthSource {
  const decision = decideModelAuthSource(env, {
    isCodexTask: claim.isCodexTask,
    runnerLocalAllowed: claim.runnerLocalAllowed,
    teamEndpointSelected: !!claim.modelEndpoint,
    runnerProviderSelected: !!(claim.llmProvider?.provider === 'openrouter' || claim.llmProvider?.baseUrl),
    cloud: claim.cloud,
    probe: claim.probe,
  });
  if (decision.blocked) throw new Error(NO_CODING_AUTH_MESSAGE);
  const credentials: ClaimCredentials = decision.dropServerCredentials ? {} : { ...claim.credentials };
  const c = credentials;
  return {
    decision,
    credentials,
    serverSeatDelivered: !!(c.serverOauthToken || c.claudeAccessToken || c.claudeCredentialId),
  };
}
