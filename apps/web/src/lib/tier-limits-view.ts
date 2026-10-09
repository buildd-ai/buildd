/**
 * View rules for Settings → Model tiers → Maximum allowed. Pure: it only shapes
 * what the server's read model (`GET /api/teams/[id]/model-ceilings`) already
 * decided. The browser never works out an effective maximum itself.
 */
import {
  CEILING_TIER_ORDER,
  lowerTier,
  tierRank,
  type CeilingSurface,
  type CeilingTier,
  type SurfaceCeilings,
} from '@buildd/shared';

export const NO_LIMIT = 'none' as const;
export type LimitValue = CeilingTier | typeof NO_LIMIT;

export const TIER_LABEL: Record<CeilingTier, string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
  'premium-plus': 'Premium-plus',
};

const TIER_NOTE: Record<CeilingTier, string> = {
  budget: 'Cheapest models',
  standard: 'Everyday work',
  premium: 'Strongest everyday models',
  'premium-plus': 'Most capable, opt-in',
};

export const SOURCE_LABEL: Record<string, string> = {
  team: 'the team',
  workspace: 'this workspace',
  member_admin: 'a team admin',
  member_self: 'you',
};

export interface LimitOption {
  value: LimitValue;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * Options for one limit picker. `bound` is the lowest cap set by anyone else
 * (a self-set limit can only lower it): tiers above it are listed but disabled,
 * with the reason, so the person sees why rather than a missing choice.
 * "No limit" is disabled under a bound too.
 */
export function limitOptions(bound: CeilingTier | null, boundBy?: string): LimitOption[] {
  const why = bound ? `Above ${boundBy ?? 'the'} maximum (${TIER_LABEL[bound]})` : undefined;
  const none: LimitOption = bound
    ? { value: NO_LIMIT, label: 'No limit', description: why, disabled: true }
    : { value: NO_LIMIT, label: 'No limit', description: 'No extra restriction' };
  const tiers = [...CEILING_TIER_ORDER].reverse().map((t): LimitOption => {
    const blocked = !!bound && tierRank(t) > tierRank(bound);
    return { value: t, label: TIER_LABEL[t], description: blocked ? why : TIER_NOTE[t], disabled: blocked };
  });
  return [none, ...tiers];
}

interface EffectiveLike {
  layers: { source: string; tier: CeilingTier }[];
}

/** The lowest cap on a surface set by a layer other than `except`. */
export function boundFrom(eff: EffectiveLike | undefined, except: string): CeilingTier | null {
  let out: CeilingTier | null = null;
  for (const l of eff?.layers ?? []) if (l.source !== except) out = lowerTier(out, l.tier);
  return out;
}

/** For the "all surfaces" picker: only bound when both surfaces are bound. */
export function boundForAll(agent: CeilingTier | null, chat: CeilingTier | null): CeilingTier | null {
  if (!agent || !chat) return null;
  return tierRank(agent) >= tierRank(chat) ? agent : chat;
}

export const toValue = (t: CeilingTier | undefined | null): LimitValue => t ?? NO_LIMIT;

/** A caps object with one key set or cleared; the rest are kept. */
export function withCap(caps: SurfaceCeilings | undefined, key: 'all' | CeilingSurface, v: LimitValue): SurfaceCeilings {
  const next: SurfaceCeilings = { ...(caps ?? {}) };
  if (v === NO_LIMIT) delete next[key];
  else next[key] = v;
  return next;
}

/** True when a layer sets a per-surface cap, so Advanced should open by itself. */
export const hasSurfaceCaps = (caps: SurfaceCeilings | undefined) => !!(caps?.agent || caps?.chat);

export const SURFACE_TITLE: Record<CeilingSurface, string> = { agent: 'Coding', chat: 'Chat' };

/** True when `tier` ranks above the server's effective maximum (null = no limit). Labelling only. */
export function overMaximum(tier: string, max: string | null | undefined): boolean {
  if (!max) return false;
  return (CEILING_TIER_ORDER as readonly string[]).includes(tier) && tierRank(tier as CeilingTier) > tierRank(max as CeilingTier);
}
