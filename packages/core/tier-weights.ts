/**
 * Weight-based split shares for tier pools (knowledge-base: buildd/design/tier-weights.md §1, §2).
 *
 * An admin sets a weight level per arm — `off`/`low`/`med`/`high` — and buildd
 * computes the share. No admin arithmetic, no model call: `sharesFromWeights`
 * and `suggestWeight` are pure functions of their arguments.
 */
import type { Allocation, AllocationCheck } from './tier-pool';
import type { TokenPrice } from './model-catalog';

export const WEIGHT_LEVELS = ['off', 'low', 'med', 'high'] as const;
export type WeightLevel = typeof WEIGHT_LEVELS[number];
export type Weights = Record<string, WeightLevel>;

export const WEIGHT_VALUES: Record<WeightLevel, number> = { off: 0, low: 1, med: 2, high: 3 };

export function isWeightLevel(v: unknown): v is WeightLevel {
  return typeof v === 'string' && (WEIGHT_LEVELS as readonly string[]).includes(v);
}

/**
 * Largest-remainder apportionment of `total` units across `armOrder` by each
 * arm's weight value. Ties go to the earlier arm in `armOrder` (incumbent
 * first, then by when it joined — the same order the draw uses). Null when
 * every arm is `off`.
 */
function distribute(weights: Weights, armOrder: readonly string[], total: number): Record<string, number> | null {
  const w = armOrder.reduce((s, id) => s + WEIGHT_VALUES[weights[id] ?? 'off'], 0);
  if (w === 0) return null;

  const exact = armOrder.map(id => (WEIGHT_VALUES[weights[id] ?? 'off'] / w) * total);
  const floors = exact.map(Math.floor);
  const remaining = total - floors.reduce((s, v) => s + v, 0);

  const byRemainder = armOrder
    .map((id, i) => ({ id, i, rem: exact[i] - floors[i] }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);

  const out: Record<string, number> = {};
  armOrder.forEach((id, i) => { out[id] = floors[i]; });
  for (let k = 0; k < remaining; k++) out[byRemainder[k].id] += 1;
  return out;
}

/**
 * armId → share (fractions of 1, at 1e-4 / basis-point precision — the same
 * rounding `validateAllocation` uses), for `split` mode. Rejects an all-`off`
 * pool: at least one live arm must carry a weight.
 */
export function sharesFromWeights(weights: Weights, armOrder: readonly string[]): AllocationCheck {
  const bp = distribute(weights, armOrder, 10_000);
  if (!bp) return { ok: false, error: 'at least one arm must have a weight above off' };
  const allocation: Allocation = {};
  for (const id of armOrder) allocation[id] = bp[id] / 10_000;
  return { ok: true, allocation };
}

/** armId → whole-percent display value. Always sums to 100 when any arm is above `off`. */
export function displayPercents(weights: Weights, armOrder: readonly string[]): Record<string, number> {
  return distribute(weights, armOrder, 100) ?? Object.fromEntries(armOrder.map(id => [id, 0]));
}

/**
 * A one-arm fallback for a pool whose `weights` predate this feature (every
 * pool created before this shipped has `weights = {}`): snap a share to the
 * nearest level by threshold, so the first weight-based write to a legacy
 * pool does not zero out an arm nobody touched. Once written, the pool's own
 * `weights` value is used and this is never consulted again for that arm.
 */
export function nearestWeightForShare(share: number): WeightLevel {
  if (share <= 0) return 'off';
  if (share < 0.15) return 'low';
  if (share < 0.7) return 'med';
  return 'high';
}

/** Fill in a level for every arm `current` has none for yet, from its live share. */
export function backfillWeights(
  current: Weights,
  arms: readonly { id: string; share: number }[],
): Weights {
  const out: Weights = { ...current };
  for (const a of arms) if (!(a.id in out)) out[a.id] = nearestWeightForShare(a.share);
  return out;
}

// ── Suggested weight for a new arm (§2) ─────────────────────────────────────

/** USD per MTok, weighted 3:1 input to output — the mix a tool-calling agent turn sees. */
export function blendedPrice(price: TokenPrice): number {
  return (3 * price.input + price.output) / 4;
}

const PRICIER_RATIO = 1.25;

/**
 * A new arm's preset weight, from its catalog price relative to the
 * incumbent's. Never `high`: only a person puts a new model on equal footing
 * with the incumbent's default `high`. An unknown price on either side reads
 * as pricier, since guessing cheap is the wrong direction to err.
 */
export function suggestWeight(challenger: TokenPrice | null, incumbent: TokenPrice | null): WeightLevel {
  if (!challenger || !incumbent) return 'low';
  const ratio = blendedPrice(challenger) / blendedPrice(incumbent);
  return ratio > PRICIER_RATIO ? 'low' : 'med';
}
