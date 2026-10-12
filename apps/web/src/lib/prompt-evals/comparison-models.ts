/**
 * The model comparison's request vocabulary (`./compare-run.ts`): how the
 * admin API names a model, and the run's defaults and limits. Kept apart so
 * the route can validate without loading the run.
 */
import { isClefModel, isJevModel, normalizeDecisionModel, type DecisionModelConfig } from '@buildd/core/decision-model';

export const COMPARISON_DEFAULTS = {
  costCapUsd: 2,
  concurrency: 4,
  limitPerKind: 200,
  sinceDays: 30,
} as const;

export const COMPARISON_LIMITS = {
  models: 6,
  costCapUsd: 25,
  concurrency: 16,
  limitPerKind: 1000,
  sinceDays: 90,
} as const;

/**
 * A model as the admin API names it: a model id, or `{ model, via?, endpoint? }`.
 * A bare id is reached the way an experiment override is (`evalModelConfig` in
 * `./run.ts`: Jev on System One, any other id as a chat model through the
 * production route's `via`), except Clef, which only Cloudflare serves.
 */
export function parseComparisonModel(input: unknown, prod: DecisionModelConfig | null): { ok: true; value: DecisionModelConfig } | { ok: false; error: string } {
  if (typeof input === 'string') {
    const id = input.trim();
    if (!id) return { ok: false, error: 'a model id is empty' };
    if (isClefModel(id)) return normalizeDecisionModel({ model: id }) as { ok: true; value: DecisionModelConfig };
    const checked = normalizeDecisionModel(isJevModel(id)
      ? { endpoint: 'systemone', model: id, via: 'openrouter' }
      : { endpoint: 'chat', model: id, via: prod?.via ?? 'openrouter' });
    return checked.ok && checked.value ? { ok: true, value: checked.value } : { ok: false, error: checked.ok ? 'a model id is empty' : checked.error };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'each model is a model id or { model, via?, endpoint? }' };
  const v = input as Record<string, unknown>;
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  const endpoint = v.endpoint ?? (isJevModel(model) ? 'systemone' : undefined);
  const checked = normalizeDecisionModel({ ...v, model, ...(endpoint ? { endpoint } : {}) });
  if (!checked.ok) return checked;
  if (!checked.value) return { ok: false, error: 'a model is empty' };
  return { ok: true, value: checked.value };
}
