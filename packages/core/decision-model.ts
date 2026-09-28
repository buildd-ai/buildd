/**
 * Which model answers a team's decision calls (`teams.decision_model`).
 *
 * Null (the default) is Jev on OpenRouter's System One API. A team may instead
 * name any model behind an OpenAI-compatible API, reached through OpenRouter's
 * chat API or the team's LiteLLM gateway (`litellm-gateway.ts`). The chat
 * endpoint answers the same typed questions with confidence from token
 * logprobs (`@builddai/ai-kit/decide`, `endpoint: { kind: 'chat' }`).
 *
 * Thresholds were measured on Jev. A call site that auto-applies an answer
 * checks `isJevModel(result.model)` and records, but does not apply, another
 * model's pick until that model has its own eval.
 *
 * Pure: no DB, no env, no imports (the task route imports it statically).
 */

export type DecisionModelVia = 'openrouter' | 'litellm';

export interface DecisionModelConfig {
  /** `systemone`: a System One model (Jev) on OpenRouter. `chat`: any chat model, via OpenRouter or the gateway. */
  endpoint: 'systemone' | 'chat';
  model: string;
  via: DecisionModelVia;
}

export const OPENROUTER_CHAT_BASE_URL = 'https://openrouter.ai/api/v1';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** True for a Jev model id, versioned (`typesafe/jev-1.13-20260917`) or pinned. */
export function isJevModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^typesafe\/jev-/.test(model);
}

/**
 * Normalise an operator-supplied config. Null clears it (back to Jev); a
 * malformed value is an error string, so the API can say what was wrong.
 */
export function normalizeDecisionModel(input: unknown): { ok: true; value: DecisionModelConfig | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'decisionModel must be an object or null' };
  const v = input as Record<string, unknown>;
  const endpoint = v.endpoint ?? 'chat';
  if (endpoint !== 'systemone' && endpoint !== 'chat') return { ok: false, error: "decisionModel.endpoint must be 'systemone' or 'chat'" };
  const via = v.via ?? 'openrouter';
  if (via !== 'openrouter' && via !== 'litellm') return { ok: false, error: "decisionModel.via must be 'openrouter' or 'litellm'" };
  if (endpoint === 'systemone' && via !== 'openrouter') return { ok: false, error: 'a System One model is served by OpenRouter only' };
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!MODEL_RE.test(model)) return { ok: false, error: 'decisionModel.model must be a model id' };
  return { ok: true, value: { endpoint, model, via } };
}

/** A stored value read defensively: anything malformed reads as the default. */
export function readDecisionModel(stored: unknown): DecisionModelConfig | null {
  const r = normalizeDecisionModel(stored);
  return r.ok ? r.value : null;
}
