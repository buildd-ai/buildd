/**
 * Task model pin vs routed result.
 *
 * `task.context.model` is overloaded: it is where a caller pins a model
 * (create_task `model`, update_task `model`), AND where the claim route writes
 * the model it resolved so the runner can read it (resolveSessionModel). A
 * requeue keeps the context, so reading `context.model` as a pin made every
 * task sticky after its first claim — the router's own output came back as
 * `explicit_override` and tier/complexity/registry changes never applied again.
 *
 * The marker `context.modelPinned` separates the two:
 *   - `true`  → caller pin; honour `context.model` on every claim.
 *   - `false` → routed result (or a cleared pin); route afresh.
 *   - absent  → a row written before the marker existed. Decide from
 *     `routingReason`, which only the claim route writes: no reason means the
 *     model came from the caller (never claimed yet) → pin; a reason other than
 *     `explicit_override` means the claim route produced it → not a pin.
 *     `explicit_override` stays a pin — it is the conservative reading for a
 *     row whose origin cannot be recovered.
 */

import { TIERS, type Tier } from './model-tier-defaults';

export interface ModelPinContext {
  model?: unknown;
  modelPinned?: unknown;
  routingReason?: unknown;
}

/** The caller-pinned model for this task, or null when routing should decide. */
export function readModelPin(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const c = context as ModelPinContext;
  const model = typeof c.model === 'string' ? c.model.trim() : '';
  if (!model) return null;
  if (c.modelPinned === true) return model;
  if (c.modelPinned === false) return null;
  if (typeof c.routingReason === 'string' && c.routingReason && c.routingReason !== 'explicit_override') {
    return null;
  }
  return model;
}

/** True when `value` is in the task tier vocabulary (premium-plus|premium|standard|budget). */
export function isTaskTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** Router shorthands that are valid pins alongside full model ids. */
const MODEL_SHORTHANDS = new Set(['opus', 'sonnet', 'haiku']);

/**
 * Accepts an Anthropic-shaped model id (`claude-…`, optionally provider-prefixed
 * `anthropic/claude-…`, optionally with a `[1m]` context suffix) or a router
 * shorthand. There is no static known-model list to check against — the
 * catalog is fetched at runtime — so this rejects typos of shape, not of name.
 */
export function isAcceptableModelPin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v || v.length > 128) return false;
  if (MODEL_SHORTHANDS.has(v)) return true;
  return /^(anthropic\/)?claude-[a-z0-9][a-z0-9.\-]*(\[1m\])?$/i.test(v);
}
