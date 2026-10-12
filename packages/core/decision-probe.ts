/**
 * One probe decision through a decision model's exact route, before a team
 * saves it (Settings → Models → Routing → Decision model).
 *
 * A decision call never throws and always has a rule to fall back to, so a
 * model that cannot answer fails silently: every call degrades to the rule
 * and nothing tells anyone. The probe is the one moment a person is watching.
 * It resolves the route the same way a real call does (`resolveDecisionRoute`:
 * the team's own key, gateway or Cloudflare credential, minted run token
 * first), sends one tiny decision on it (`decisionCall` with that key,
 * endpoint and model) and, when it fails, says why in the provider's own
 * words with the key redacted.
 *
 * DB-free apart from the default route lookup, which is imported lazily, so
 * the test injects both halves.
 */
import { choice, describeDecideError, providerErrorExcerpt, redactSecrets, type DecideError, type DecisionEndpoint } from '@builddai/ai-kit/decide';
import { isClefModel, type DecisionModelConfig } from './decision-model';
import type { DecisionKeyScope, DecisionCallParams, DecisionResult } from './decision-client';

/** Long enough for a cold Workers AI model, short enough for a Save button. */
export const DECISION_PROBE_TIMEOUT_MS = 10_000;

type Route = { apiKey: string | null; endpoint?: DecisionEndpoint; model: string };

export interface DecisionProbeDeps {
  resolveRoute?: (config: DecisionModelConfig, scope: DecisionKeyScope) => Promise<Route>;
  call?: (params: DecisionCallParams<any>) => Promise<DecisionResult<any>>;
}

export type DecisionProbeResult =
  | { ok: true; model: string; latencyMs: number }
  | { ok: false; error: string };

const PROBE_QUESTIONS = {
  reachable: choice('Is this a test message?', { yes: 'It says it is a test.', no: 'It does not say so.' }),
};

/** Who answers for this config, in the words the settings page uses. */
function providerName(config: DecisionModelConfig): string {
  if (config.via === 'cloudflare') return 'Cloudflare';
  if (config.via === 'litellm') return 'The LiteLLM gateway';
  return 'OpenRouter';
}

/** What is missing when a config has no route at all. */
function noRouteText(config: DecisionModelConfig): string {
  if (config.via === 'cloudflare') {
    return isClefModel(config.model)
      ? 'No Cloudflare credential to run it with. Add one under Settings → Runners → Cloudflare.'
      : 'Jev through Cloudflare needs an AI Gateway ID on the Cloudflare credential and an OpenRouter key.';
  }
  if (config.via === 'litellm') return 'No LiteLLM gateway is connected. Connect one above first.';
  return 'No OpenRouter key for decisions. Add one under Team keys first.';
}

/**
 * A rejection as a person reads it: the provider's status and its own error
 * messages (Cloudflare's `errors[].message (code N)`, an OpenAI-style
 * `error.message`), else the start of the body. Key redacted either way.
 */
export function providerRejectionText(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ code?: unknown; message?: unknown }>; error?: { message?: unknown } | string; message?: unknown };
    const parts: string[] = [];
    for (const e of parsed.errors ?? []) {
      if (typeof e?.message !== 'string' || !e.message.trim()) continue;
      parts.push(typeof e.code === 'number' || typeof e.code === 'string' ? `${e.message.trim()} (code ${e.code})` : e.message.trim());
    }
    if (parts.length === 0 && typeof parsed.error === 'object' && typeof parsed.error?.message === 'string') parts.push(parsed.error.message.trim());
    if (parts.length === 0 && typeof parsed.error === 'string') parts.push(parsed.error.trim());
    if (parts.length === 0 && typeof parsed.message === 'string') parts.push(parsed.message.trim());
    if (parts.length > 0) return providerErrorExcerpt(status, redactSecrets(parts.join('; ')));
  } catch {
    // not JSON: the excerpt below
  }
  return providerErrorExcerpt(status, body);
}

function failureText(config: DecisionModelConfig, error: DecideError | { kind: string }): string {
  const who = providerName(config);
  const e = error as DecideError;
  switch (e.kind) {
    case 'provider_error': return `${who} rejected a test decision: ${providerRejectionText(e.status, e.body)}`;
    case 'rate_limited': return `${who} rate-limited a test decision. Try again in a minute.`;
    case 'timeout': return `${who} did not answer a test decision within ${Math.round(DECISION_PROBE_TIMEOUT_MS / 1000)}s. Try again.`;
    case 'transport': return `Could not reach ${who === 'The LiteLLM gateway' ? 'the LiteLLM gateway' : who}: ${redactSecrets(e.message)}`;
    case 'uncalibrated': return `${config.model} answered without token logprobs, so its decisions have no confidence. Pick a model that returns logprobs.`;
    case 'missing_key': return noRouteText(config);
    default: return `A test decision failed: ${describeDecideError(e)}`;
  }
}

async function defaultResolveRoute(config: DecisionModelConfig, scope: DecisionKeyScope): Promise<Route> {
  const { resolveDecisionRoute } = await import('./decision-client');
  return resolveDecisionRoute(config, scope);
}

async function defaultCall(params: DecisionCallParams<any>): Promise<DecisionResult<any>> {
  const { decisionCall } = await import('./decision-client');
  return decisionCall(params);
}

/** Probe `config` for this team (and person). Never throws. */
export async function probeDecisionModel(
  config: DecisionModelConfig,
  scope: DecisionKeyScope,
  deps: DecisionProbeDeps = {},
): Promise<DecisionProbeResult> {
  let route: Route;
  try {
    route = await (deps.resolveRoute ?? defaultResolveRoute)(config, scope);
  } catch (e) {
    console.warn(`[decision-probe] route lookup failed for team ${scope.teamId}:`, (e as Error)?.message ?? e);
    return { ok: false, error: 'Could not look up the credentials for this model. Try again.' };
  }
  if (!route.apiKey) return { ok: false, error: noRouteText(config) };

  try {
    const result = await (deps.call ?? defaultCall)({
      // With `apiKey` set the capability is not checked; it only names the call.
      capability: 'task_verdict',
      teamId: scope.teamId,
      workspaceId: scope.workspaceId ?? null,
      accountId: scope.accountId ?? null,
      userId: scope.userId ?? null,
      apiKey: route.apiKey,
      ...(route.endpoint ? { endpoint: route.endpoint } : {}),
      model: route.model,
      state: 'This is a test message from buildd, checking the decision model before it is saved.',
      questions: PROBE_QUESTIONS,
      timeoutMs: DECISION_PROBE_TIMEOUT_MS,
    });
    if (result.ok) return { ok: true, model: result.model, latencyMs: result.latencyMs };
    return { ok: false, error: redactSecrets(failureText(config, result.error), [route.apiKey]) };
  } catch (e) {
    return { ok: false, error: `A test decision failed: ${redactSecrets((e as Error)?.message ?? String(e), [route.apiKey])}` };
  }
}
