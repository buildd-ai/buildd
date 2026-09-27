/**
 * Family succession for tier pool arms (docs/design/tier-weights.md §4b).
 *
 * A newer release of an arm's family is a reason to lower that arm's cap in an
 * explore pool, and to propose the newer model as a challenger. Everything
 * here is pure: the catalog, the tier and the clock come in as arguments.
 *
 * Succession is deliberately strict. A later `created` alone is not enough,
 * because re-listings and aliases get new dates too; both ids must carry a
 * numeric version and the successor's must be higher.
 */
import {
  MIN_CONTEXT_TOKENS,
  TIER_PRICE_BANDS,
  modelFamily,
  modelVariantFlags,
  snapshotBase,
  vendorOf,
  type CatalogEntry,
  type CatalogTier,
} from './model-catalog';
import type { ArmRoute } from './tier-pool';

/** Days for an old arm's cap multiplier to halve once its successor joins. */
export const SUCCESSION_HALF_LIFE_DAYS = 14;

const DAY_S = 86_400;
const day = (unixSeconds: number) => Math.floor(unixSeconds / DAY_S);

/**
 * The catalog entry for a model id, matched the way `priceFromCatalog` does:
 * exact id, then the dated canonical id, then the undated base.
 */
export function findCatalogEntry(entries: readonly CatalogEntry[], modelId: string): CatalogEntry | null {
  if (!modelId) return null;
  const want = modelId.toLowerCase();
  const bare = snapshotBase(want);
  return entries.find(e => e.id.toLowerCase() === want)
    ?? entries.find(e => e.canonicalId?.toLowerCase() === want)
    ?? entries.find(e => e.id.toLowerCase() === bare)
    ?? null;
}

/**
 * The numeric tokens of a model id's undated base, in order:
 * `claude-sonnet-4-5` → [4, 5], `gpt-5.3-codex` → [5, 3], `qwen3-coder` → [3].
 * Size tokens (`70b`) are not versions. Empty when the id has no version.
 */
export function versionTuple(id: string): number[] {
  const slug = snapshotBase(id.slice(id.indexOf('/') + 1).toLowerCase());
  const out: number[] = [];
  for (const tok of slug.split('-')) {
    const m = /^(?:[a-z]+)?(\d+(?:\.\d+)*)$/.exec(tok);
    if (!m) continue;
    for (const part of m[1].split('.')) out.push(Number(part));
  }
  return out;
}

/** Lexicographic compare with zero padding: [5] = [5, 0] < [5, 1]. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Can a catalog entry be served on this arm's route? */
export function routeServes(route: ArmRoute, entry: CatalogEntry): boolean {
  switch (route) {
    case 'anthropic':
    case 'runner:claude':
      return entry.provider === 'anthropic';
    case 'openai':
    case 'runner:codex':
      return entry.provider === 'openai';
    case 'openrouter':
      return true;
  }
}

export interface SuccessorArgs {
  arm: { route: ArmRoute; model: string };
  tier: CatalogTier;
  catalog: readonly CatalogEntry[];
  /** Unix seconds. */
  now: number;
  /** Popularity percentile for a model id, for the tie-break only. */
  popularity?: (id: string) => number | null;
}

/**
 * The catalog entry that succeeds an arm's model on the arm's route, or null.
 * §4b rules 1–6; ties go to the highest version, then the newest day, then the
 * more popular model, then the shorter id.
 */
export function findSuccessor(args: SuccessorArgs): CatalogEntry | null {
  const a = findCatalogEntry(args.catalog, args.arm.model);
  if (!a) return null;
  const aVersion = versionTuple(a.id);
  if (aVersion.length === 0) return null;
  const vendor = vendorOf(a.id);
  const family = modelFamily(a.id);
  const aBase = snapshotBase(a.id);
  const band = TIER_PRICE_BANDS[args.tier];

  const candidates: Array<{ e: CatalogEntry; v: number[] }> = [];
  for (const s of args.catalog) {
    if (vendorOf(s.id) !== vendor || modelFamily(s.id) !== family) continue;
    const v = versionTuple(s.id);
    if (v.length === 0 || compareVersions(v, aVersion) <= 0) continue;
    if (day(s.created) <= day(a.created)) continue;
    const flags = modelVariantFlags(s.id, { expiresAt: s.expiresAt ?? null, now: args.now });
    if (flags.preview || flags.deprecated) continue;
    if (flags.snapshot && snapshotBase(s.id) === aBase) continue;
    if (s.contextLength < MIN_CONTEXT_TOKENS) continue;
    if (!routeServes(args.arm.route, s)) continue;
    if (!(s.input >= band.minInput && s.input < band.maxInput)) continue;
    candidates.push({ e: s, v });
  }
  if (candidates.length === 0) return null;
  const pop = (id: string) => args.popularity?.(id) ?? 0;
  candidates.sort((x, y) =>
    compareVersions(y.v, x.v)
    || day(y.e.created) - day(x.e.created)
    || pop(y.e.id) - pop(x.e.id)
    || x.e.id.length - y.e.id.length
    || (x.e.id < y.e.id ? -1 : x.e.id > y.e.id ? 1 : 0),
  );
  return candidates[0].e;
}

/** An old arm's cap multiplier `days` after its successor joined: 0.5^(days/14). */
export function decayMultiplier(days: number): number {
  if (!(days > 0)) return 1;
  return Math.pow(0.5, days / SUCCESSION_HALF_LIFE_DAYS);
}
