/**
 * Model tier ceilings, the parts that need model knowledge.
 *
 * The rule itself (layers, precedence, explicit-vs-auto) is isomorphic and
 * lives in @buildd/shared (model-tier-ceiling.ts). This module adds what only
 * the server can judge: which SPEND BAND a concrete model id is in.
 *
 * A tier label is a name; what a run costs is the model behind it. A team's
 * registry row, a pool arm or an experiment arm can put any model behind
 * `standard` — including one priced like premium-plus. So a ceiling is checked
 * twice: on the tier asked for, and on the model finally served. The second
 * check uses the price bands that define the tiers (`TIER_PRICE_BANDS`), so it
 * is provider-independent: an OpenAI or OpenRouter model is banded by its
 * price exactly like a Claude one.
 *
 * Unknown price (not in the catalog, catalog unavailable): Claude ids are
 * banded by family (opus/fable/haiku/sonnet); anything else is `null` =
 * unknown, which callers treat as "cannot prove it is over the cap" → allow,
 * with a warning. Blocking every unpriced model would make a ceiling deny
 * work for a catalog outage the team cannot fix.
 */

import { TIER_PRICE_BANDS, snapshotBase, type CatalogEntry } from './model-catalog';
import { tierForModelId } from './dispatch-model-guard';
import {
  enforceTierCeiling,
  policyDenied,
  tierWithin,
  type CeilingTier,
  type CeilingVerdict,
  type TierCeiling,
  type TierRequestOrigin,
} from '@buildd/shared';

/** The tier whose price band holds this input price ($/MTok). Above every band → premium-plus. */
export function bandForInputPrice(input: number): CeilingTier {
  for (const [tier, band] of Object.entries(TIER_PRICE_BANDS) as Array<[CeilingTier, { minInput: number; maxInput: number }]>) {
    if (input >= band.minInput && input < band.maxInput) return tier;
  }
  return 'premium-plus';
}

/** Strip a provider prefix and `[1m]` / `:variant` suffix for catalog lookup. */
function lookupId(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[1m\]$/, '');
  const colon = m.indexOf(':');
  if (colon >= 0) m = m.slice(0, colon);
  return m;
}

/**
 * The spend band of a concrete model id, or null when it cannot be priced.
 * Router shorthands (`opus`/`sonnet`/`haiku`) are not model ids — the caller
 * resolves them as tiers.
 */
export function modelSpendBand(model: string, catalog: readonly CatalogEntry[]): CeilingTier | null {
  const id = lookupId(model);
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const entry = catalog.find((e) =>
    e.id.toLowerCase() === bare ||
    e.openRouterId.toLowerCase() === id ||
    e.canonicalId?.toLowerCase() === bare ||
    e.permaslug?.toLowerCase() === id,
  ) ?? catalog.find((e) => e.id.toLowerCase() === snapshotBase(bare));
  if (entry && Number.isFinite(entry.input)) return bandForInputPrice(entry.input);
  if (bare.startsWith('claude-')) return tierForModelId(bare);
  return null;
}

/**
 * Hold a concrete model against the ceiling by its spend band. An unpriced
 * model passes with `unknownBand` set so the caller can warn.
 */
export function enforceModelCeiling(args: {
  ceiling: TierCeiling;
  model: string;
  origin: TierRequestOrigin;
  catalog: readonly CatalogEntry[];
}): CeilingVerdict & { unknownBand?: true } {
  const band = modelSpendBand(args.model, args.catalog);
  if (!band) return { ok: true, tier: args.ceiling.max ?? 'premium-plus', unknownBand: true };
  if (tierWithin(band, args.ceiling.max)) return { ok: true, tier: band };
  return { ok: false, denied: policyDenied({ ceiling: args.ceiling, tier: band, origin: args.origin, model: args.model }) };
}

/**
 * The served model's band vs the tier label it was resolved for. A model
 * priced above its label is the "tier label does not correspond to spend
 * band" case: under a ceiling it is denied by enforceModelCeiling; with no
 * ceiling it is only worth a warning.
 */
export function bandExceedsLabel(model: string, label: CeilingTier, catalog: readonly CatalogEntry[]): CeilingTier | null {
  const band = modelSpendBand(model, catalog);
  return band && !tierWithin(band, label) ? band : null;
}

/**
 * What a claim is asking for, and on whose authority, in the claim route's
 * precedence (pin → tasks.tier → role → router matrix). Only the router's own
 * pick is `auto`; anything a person or a role configured is explicit, so it is
 * denied over the ceiling rather than quietly served cheaper.
 *
 * `roleFloor` is the role's tier floor: when the router's tier is no higher
 * than it, the role is what put the task there.
 */
export type ClaimTierRequest =
  | { kind: 'model'; model: string; origin: TierRequestOrigin }
  | { kind: 'tier'; tier: CeilingTier; origin: TierRequestOrigin };

export function claimTierRequest(args: {
  /** The caller pin (readModelPin), or null. */
  pin: string | null;
  /** An exact model id is being served as-is (explicit_override, no shorthand). */
  exactModel: string | null;
  pinTier: CeilingTier | null;
  taskTier: CeilingTier | null | undefined;
  roleTierOverride: CeilingTier | null;
  roleFloor: CeilingTier | null;
  routerTier: CeilingTier;
}): ClaimTierRequest {
  if (args.exactModel) return { kind: 'model', model: args.exactModel, origin: args.pin ? 'model_pin' : 'role_model' };
  if (args.pinTier) return { kind: 'tier', tier: args.pinTier, origin: 'model_pin' };
  if (args.taskTier) return { kind: 'tier', tier: args.taskTier, origin: 'task_tier' };
  if (args.roleTierOverride) return { kind: 'tier', tier: args.roleTierOverride, origin: 'role_model' };
  const byRole = !!args.roleFloor && tierWithin(args.routerTier, args.roleFloor);
  return { kind: 'tier', tier: args.routerTier, origin: byRole ? 'role_model' : 'auto' };
}

export { enforceTierCeiling };
