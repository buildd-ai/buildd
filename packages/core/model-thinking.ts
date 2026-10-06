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
 * effort level, not only xhigh/max: on Fable and Mythos thinking is always on
 * and the parameter has to be omitted entirely, so any explicit disable is a 400.
 *
 * Load-bearing for the `premium-plus` tier, which points at Fable — a workspace
 * carrying `thinking: disabled` would otherwise 400 on every task routed there.
 */
export function rejectsDisabledThinking(modelId: string): boolean {
  return /claude-(fable|mythos)/i.test(modelId);
}

/**
 * Resolve the effective thinking config, stripping a "disabled" override when
 * the model requires thinking at xhigh/max effort (API returns 400 otherwise).
 */
export function resolveEffectiveThinking(
  model: string,
  configuredEffort: Effort,
  configuredThinking: ThinkingConfig,
): ThinkingConfig {
  const id = model || '';
  const mustStrip =
    // Fable/Mythos: disabled is rejected regardless of effort.
    rejectsDisabledThinking(id) ||
    // Opus 5: disabled is accepted at effort `high` or below, 400 above it.
    (/claude-opus-5/i.test(id) && (configuredEffort === 'xhigh' || configuredEffort === 'max'));
  return mustStrip && (configuredThinking as any)?.type === 'disabled'
    ? undefined
    : configuredThinking;
}
