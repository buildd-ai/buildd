/**
 * Model alias map — short names (haiku, sonnet, opus) → full model IDs — plus the
 * extended-thinking guards used at dispatch time.
 *
 * Honest state of this module (verified 2026-08-30):
 * - `DEFAULT_ALIASES` is the in-code map, read by POST /api/admin/refresh-model-aliases.
 * - `updateModelAliases` writes that map to `system_cache.model_aliases`. Its only
 *   caller is that same admin route, i.e. a human-triggered refresh. Nothing in this
 *   repo (runner included) calls it automatically, and nothing reads the cache row
 *   back — the two resolvers that used to (`resolveModelName`, `resolveModelNameSync`)
 *   had no reachable callers and were deleted. Treat the row as an operator-visible
 *   record, not as an input to routing.
 * - Claim-time model selection lives in `model-router.ts` + `model-tier-registry.ts`.
 */
import { db } from './db/client';
import { systemCache } from './db/schema';
import { eq } from 'drizzle-orm';

const CACHE_KEY = 'model_aliases';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The in-code alias map. Also the default payload POST /api/admin/refresh-model-aliases
 * publishes to `system_cache.model_aliases` for any alias the operator omits.
 */
export const DEFAULT_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

type ThinkingConfig = { type: 'enabled' | 'disabled' | 'adaptive' } | undefined;
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;

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

/**
 * Publish an alias map to `system_cache.model_aliases`.
 *
 * Only caller: POST /api/admin/refresh-model-aliases (human-triggered). Accepts the
 * `{ value, label? }[]` shape a supportedModels() response uses and slots entries by
 * name substring. Failures are swallowed — this row is informational, not on any
 * request path.
 */
export async function updateModelAliases(
  models: Array<{ value: string; label?: string }>
): Promise<void> {
  const aliases: Record<string, string> = {};

  for (const model of models) {
    const id = model.value.toLowerCase();
    if (id.includes('haiku')) aliases.haiku = model.value;
    if (id.includes('sonnet')) aliases.sonnet = model.value;
    if (id.includes('opus')) aliases.opus = model.value;
  }

  // Only write if we found at least one alias
  if (Object.keys(aliases).length === 0) return;

  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);

  try {
    await db
      .insert(systemCache)
      .values({
        key: CACHE_KEY,
        value: aliases,
        updatedAt: new Date(),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: systemCache.key,
        set: {
          value: aliases,
          updatedAt: new Date(),
          expiresAt,
        },
      });
  } catch {
    // Non-fatal — the operator can just re-run the refresh.
  }
}
