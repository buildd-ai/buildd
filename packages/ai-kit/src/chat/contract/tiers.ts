/**
 * An app's tier policy: which `/models` tiers it offers its users, what it
 * calls them, which one a new chat starts on, and whether "Auto" is offered.
 *
 * Isomorphic (no React, no SDK), so one policy object serves the composer's
 * `TierPicker`, the composer store and the server that validates a turn's
 * tier. Without a policy the kit behaves as before: Auto first and the
 * default, then Budget / Standard / Premium.
 */

/** `/models`' tiers, most to least capable (the same values as `KitTier`). */
export const CHAT_TIERS = ['premium-plus', 'premium', 'standard', 'budget'] as const;
export type ChatTier = (typeof CHAT_TIERS)[number];

export interface TierPolicyOptions {
  /** The tiers offered, in picker order. Default budget, standard, premium. */
  offer?: readonly ChatTier[];
  /**
   * The tier a new chat starts on when the person has saved nothing. Null =
   * Auto. Default: null when Auto is offered, else `standard` if offered,
   * else the first offered tier.
   */
  defaultTier?: ChatTier | null;
  /** The app's names for its tiers, e.g. `{ budget: 'Economy' }`. */
  labels?: Partial<Record<ChatTier, string>>;
  /** Offer "Auto" (the app picks per turn). Default true. */
  auto?: boolean;
  /** Auto's name. Default "Auto". */
  autoLabel?: string;
}

export interface TierPolicy {
  readonly offer: readonly ChatTier[];
  /** Null = Auto. */
  readonly defaultTier: ChatTier | null;
  readonly auto: boolean;
  readonly autoLabel: string;
  /** A tier's name for this app ("Economy"); Auto's name for null. */
  label(tier: string | null): string;
  /** An offered tier (never Auto, never an unoffered one). */
  isOffered(tier: unknown): tier is ChatTier;
  /** Offered, or null when Auto is offered. Use it to validate a request. */
  accepts(tier: unknown): tier is ChatTier | null;
  /**
   * The first acceptable candidate, else the default. Pass the saved choice
   * first: `resolve(saved)` is saved → app default. Undefined candidates are
   * skipped; null is Auto (skipped when Auto isn't offered).
   */
  resolve(...candidates: unknown[]): ChatTier | null;
  /** `TierPicker` options: every offered tier with its label and optional meta line. */
  options(meta?: Partial<Record<string, string>>): Array<{ tier: ChatTier; label: string; price?: string }>;
}

const KIT_OFFER: readonly ChatTier[] = ['budget', 'standard', 'premium'];

/** The kit's own names: "Premium+", else the tier capitalised. */
export function defaultTierName(tier: string): string {
  return tier === 'premium-plus' ? 'Premium+' : tier ? tier[0].toUpperCase() + tier.slice(1) : tier;
}

export function isChatTier(t: unknown): t is ChatTier {
  return typeof t === 'string' && (CHAT_TIERS as readonly string[]).includes(t);
}

export function defineTierPolicy(opts: TierPolicyOptions = {}): TierPolicy {
  const offer = [...new Set(opts.offer ?? KIT_OFFER)];
  if (offer.length === 0) throw new Error('defineTierPolicy: offer at least one tier');
  for (const t of offer) if (!isChatTier(t)) throw new Error(`defineTierPolicy: unknown tier "${String(t)}"`);
  const auto = opts.auto ?? true;
  const fallback: ChatTier | null = auto ? null : offer.includes('standard') ? 'standard' : offer[0];
  const defaultTier = opts.defaultTier === undefined ? fallback : opts.defaultTier;
  if (defaultTier === null && !auto) throw new Error('defineTierPolicy: defaultTier is Auto but Auto is not offered');
  if (defaultTier !== null && !offer.includes(defaultTier)) throw new Error(`defineTierPolicy: defaultTier "${defaultTier}" is not offered`);
  const autoLabel = opts.autoLabel ?? 'Auto';
  const labels = opts.labels ?? {};
  const set = new Set<string>(offer);
  const isOffered = (t: unknown): t is ChatTier => typeof t === 'string' && set.has(t);
  const accepts = (t: unknown): t is ChatTier | null => (t === null ? auto : isOffered(t));
  const label = (t: string | null) => (t === null ? autoLabel : labels[t as ChatTier] ?? defaultTierName(t));
  return Object.freeze({
    offer,
    defaultTier,
    auto,
    autoLabel,
    label,
    isOffered,
    accepts,
    resolve(...candidates: unknown[]) {
      for (const c of candidates) if (c !== undefined && accepts(c)) return c;
      return defaultTier;
    },
    options(meta: Partial<Record<string, string>> = {}) {
      return offer.map(tier => ({ tier, label: label(tier), ...(meta[tier] ? { price: meta[tier] } : {}) }));
    },
  });
}
