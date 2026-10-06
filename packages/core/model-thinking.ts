/**
 * Extended-thinking guards used at dispatch time.
 *
 * Kept free of any database import: the runner reaches this module, and
 * `./db/client` pulls in `./config`, whose `dotenv.config()` would read a .env
 * from whatever folder `buildd` was started in. `model-aliases.ts` re-exports
 * these for its existing importers.
 */

export type ThinkingConfig = { type: 'enabled' | 'disabled' | 'adaptive' } | undefined;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;

/**
 * Returns true for models that require extended thinking to be enabled
 * at xhigh/max effort levels (passing thinking: { type: "disabled" } returns 400).
 */
export function requiresThinkingEnabled(modelId: string): boolean {
  return /claude-opus-5/i.test(modelId) || rejectsDisabledThinking(modelId);
}

/**
 * Returns true for models that reject `thinking: { type: "disabled" }` at EVERY
 * effort level, not only xhigh/max. Fable/Mythos require thinking; Sonnet/Haiku
 * 5.5 use a different thinking mode instead of "disabled". Omit the override
 * so the API chooses its default ("between_tools" is effort-limited).
 *
 * Load-bearing for the `premium-plus` tier, which points at Fable — a workspace
 * carrying `thinking: disabled` would otherwise 400 on every task routed there.
 */
export function rejectsDisabledThinking(modelId: string): boolean {
  return (
    /claude-(fable|mythos)/i.test(modelId) ||
    /claude-(sonnet|haiku)-5-5(?:-|$)/i.test(modelId)
  );
}

/**
 * Resolve the effective thinking config, stripping a "disabled" override when
 * the model rejects it outright or requires thinking at xhigh/max effort.
 */
export function resolveEffectiveThinking(
  model: string,
  configuredEffort: Effort,
  configuredThinking: ThinkingConfig,
): ThinkingConfig {
  const id = model || '';
  const mustStrip =
    // Fable/Mythos and Sonnet/Haiku 5.5 reject disabled regardless of effort.
    rejectsDisabledThinking(id) ||
    // Opus 5: disabled is accepted at effort `high` or below, 400 above it.
    (/claude-opus-5/i.test(id) && (configuredEffort === 'xhigh' || configuredEffort === 'max'));
  return mustStrip && (configuredThinking as any)?.type === 'disabled'
    ? undefined
    : configuredThinking;
}
