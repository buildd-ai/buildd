/**
 * The model picker's data model, DOM-free: which rows a route offers, how
 * they group (route first, vendor inside OpenRouter), which badges they earn,
 * what the default filter hides, and how two rows compare.
 *
 * Client-safe: imports only pure catalog helpers. Consumers:
 * - Settings → Model tiers, base models (single select, one `(route, model)`)
 * - Settings → Model tiers, pool arms (multi select, max `MAX_POOL_ARMS`)
 *
 * See knowledge-base: buildd/design/tier-model-pools.md §2 (Picker).
 */
import {
  TIER_PRICE_BANDS,
  modelFamily,
  modelVariantFlags,
  snapshotBase,
  vendorOf,
  type CatalogTier,
} from '@buildd/core/model-catalog';
import { fuzzyScore } from '@/components/ui/listbox';

/** One `/api/models` entry, with the optional picker metadata. */
export interface PickerModelInput {
  id: string;
  displayName?: string;
  provider: string;
  openRouterId?: string;
  inputPrice?: number;
  outputPrice?: number;
  vendor?: string;
  contextLength?: number;
  created?: number;
  expiresAt?: number | null;
}

/** Which model ids a route takes. */
export type RouteCatalog = 'anthropic' | 'openai' | 'openrouter';

export interface PickerRouteSpec {
  /** Stored as the tier row's provider, or the pool arm's route. */
  id: string;
  /** Group heading, named for what pays: "Anthropic key", "Runner · Codex". */
  label: string;
  catalog: RouteCatalog;
  /** Whether the credential behind the route is present. `unknown` shows nothing. */
  key?: 'set' | 'missing' | 'unknown';
  /** Short "who can use it" line under the heading. */
  note?: string;
}

export interface PickerValue {
  route: string;
  model: string;
}

export type Band = 'in' | 'below' | 'above' | 'unknown';
export type Badge = 'current' | 'recommended' | 'newest' | 'cheapest';
export type HiddenReason = 'preview' | 'snapshot' | 'deprecated' | 'superseded';

export interface PickerRow {
  key: string;
  route: string;
  /** The exact string stored for this route. */
  model: string;
  vendor: string;
  /** Model id without the vendor prefix (the vendor is on the group heading). */
  short: string;
  displayName: string;
  inputPrice?: number;
  outputPrice?: number;
  contextLength?: number;
  created?: number;
  band: Band;
  family: string;
  /** Why the default view hides it, or null. Current rows are never hidden. */
  hidden: HiddenReason | null;
  badges: Badge[];
  /** False for a current value the catalog does not list. */
  listed: boolean;
}

export const pickerKey = (v: PickerValue) => `${v.route}::${v.model}`;

/** Case-, dot- and snapshot-insensitive identity: `anthropic/claude-sonnet-4.5` = `anthropic/claude-sonnet-4-5`. */
export function sameModel(a: string, b: string): boolean {
  const n = (s: string) => s.trim().toLowerCase().replace(/\./g, '-');
  if (n(a) === n(b)) return true;
  return n(snapshotBase(a)) === n(b) || n(a) === n(snapshotBase(b));
}

const VENDOR_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek', qwen: 'Qwen',
  'meta-llama': 'Meta', meta: 'Meta', mistralai: 'Mistral', 'x-ai': 'xAI', moonshotai: 'Moonshot', 'z-ai': 'Z.ai',
  minimax: 'MiniMax', 'bytedance-seed': 'ByteDance', amazon: 'Amazon', nvidia: 'NVIDIA', cohere: 'Cohere',
  microsoft: 'Microsoft', xiaomi: 'Xiaomi', tencent: 'Tencent', baidu: 'Baidu', inception: 'Inception',
  openrouter: 'OpenRouter', other: 'Other',
};

/** Vendors in the order the picker lists them inside OpenRouter; the rest follow alphabetically. */
export const VENDOR_ORDER = ['anthropic', 'openai', 'google', 'deepseek', 'qwen', 'meta-llama', 'meta', 'mistralai', 'x-ai', 'moonshotai', 'z-ai'];

export function vendorLabel(v: string): string {
  return VENDOR_LABEL[v] ?? v.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function vendorRank(v: string): number {
  const i = VENDOR_ORDER.indexOf(v);
  return i === -1 ? VENDOR_ORDER.length : i;
}

export function compareVendors(a: string, b: string): number {
  return vendorRank(a) - vendorRank(b) || vendorLabel(a).localeCompare(vendorLabel(b));
}

function modelFor(route: PickerRouteSpec, m: PickerModelInput): string | undefined {
  if (route.catalog === 'openrouter') return m.openRouterId ?? (m.provider === 'openrouter' && m.id.includes('/') ? m.id : undefined);
  if (route.catalog === 'anthropic') return m.provider === 'anthropic' ? m.id : undefined;
  return m.provider === 'openai' || m.provider === 'openai-codex' ? m.id : undefined;
}

export function bandOf(tier: CatalogTier, input: number | undefined): Band {
  if (input === undefined) return 'unknown';
  const b = TIER_PRICE_BANDS[tier];
  if (input < b.minInput) return 'below';
  if (input >= b.maxInput) return 'above';
  return 'in';
}

const MIN_CONTEXT = 200_000;
const day = (t?: number) => Math.floor((t ?? 0) / 86_400);

/**
 * Every row the routes offer for one tier, deduplicated per route, badged and
 * flagged. `current` values always appear (as unlisted rows when the catalog
 * does not carry them), so opening the picker never loses a saved choice.
 */
export function buildPickerRows(
  models: readonly PickerModelInput[],
  routes: readonly PickerRouteSpec[],
  tier: CatalogTier,
  current: readonly PickerValue[] = [],
  now = Math.floor(Date.now() / 1000),
): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const route of routes) {
    const mine: PickerRow[] = [];
    for (const m of models) {
      const model = modelFor(route, m);
      if (!model) continue;
      const dup = mine.find((r) => sameModel(r.model, model) && !modelVariantFlags(model).snapshot === !modelVariantFlags(r.model).snapshot);
      if (dup) {
        // Merge: a registry or credentialed entry has no price; the public one does.
        dup.inputPrice ??= m.inputPrice;
        dup.outputPrice ??= m.outputPrice;
        dup.contextLength ??= m.contextLength;
        dup.created ??= m.created;
        dup.band = bandOf(tier, dup.inputPrice);
        continue;
      }
      const vendor = m.vendor ?? vendorOf(model);
      const flags = modelVariantFlags(model, { expiresAt: m.expiresAt, now });
      mine.push({
        key: pickerKey({ route: route.id, model }),
        route: route.id,
        model,
        vendor,
        short: model.includes('/') ? model.slice(model.indexOf('/') + 1) : model,
        displayName: m.displayName && !m.displayName.endsWith(')') ? m.displayName.replace(/^[^:]+:\s*/, '') : model,
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        contextLength: m.contextLength,
        created: m.created,
        band: bandOf(tier, m.inputPrice),
        family: modelFamily(model),
        hidden: flags.deprecated ? 'deprecated' : flags.preview ? 'preview' : null,
        badges: [],
        listed: true,
        ...(flags.snapshot ? { _snapshot: true } : {}),
      } as PickerRow);
    }

    // A dated snapshot hides behind its undated sibling.
    for (const r of mine) {
      if (!(r as { _snapshot?: boolean })._snapshot || r.hidden) continue;
      const base = snapshotBase(r.model);
      if (mine.some((o) => o !== r && sameModel(o.model, base))) r.hidden = 'snapshot';
    }
    for (const r of mine) delete (r as { _snapshot?: boolean })._snapshot;

    // Superseded: an older member of a family with a newer visible member.
    const newestByFamily = new Map<string, PickerRow>();
    for (const r of mine) {
      if (r.hidden || r.created === undefined) continue;
      const best = newestByFamily.get(r.family);
      if (!best || (r.created ?? 0) > (best.created ?? 0)) newestByFamily.set(r.family, r);
    }
    const familySize = new Map<string, number>();
    for (const r of mine) if (!r.hidden) familySize.set(r.family, (familySize.get(r.family) ?? 0) + 1);
    for (const r of mine) {
      const best = newestByFamily.get(r.family);
      if (!best || r.hidden) continue;
      if (best === r) {
        if ((familySize.get(r.family) ?? 0) > 1) r.badges.push('newest');
      } else if (day(best.created) > day(r.created)) {
        r.hidden = 'superseded';
      }
    }

    // Current values: always shown, synthesized when the catalog lacks them.
    for (const c of current) {
      if (c.route !== route.id) continue;
      let hit = mine.find((r) => r.model === c.model) ?? mine.find((r) => sameModel(r.model, c.model));
      if (!hit) {
        hit = {
          key: pickerKey(c), route: route.id, model: c.model, vendor: vendorOf(c.model),
          short: c.model.includes('/') ? c.model.slice(c.model.indexOf('/') + 1) : c.model,
          displayName: c.model, band: 'unknown', family: modelFamily(c.model), hidden: null, badges: [], listed: false,
        };
        mine.unshift(hit);
      }
      hit.hidden = null;
      if (!hit.badges.includes('current')) hit.badges.unshift('current');
    }

    // buildd's pick for the tier on this route: the rule pickTierModel applies
    // (newest in band by day, then pricier, then shorter id), on Anthropic
    // models for Anthropic/OpenRouter routes and OpenAI models otherwise.
    const pickVendor = route.catalog === 'openai' ? 'openai' : 'anthropic';
    const eligible = mine.filter((r) => r.listed && !r.hidden && r.band === 'in' && (r.contextLength === undefined || r.contextLength >= MIN_CONTEXT));
    const rec = eligible
      .filter((r) => r.vendor === pickVendor)
      .sort((a, b) => day(b.created) - day(a.created) || (b.inputPrice ?? 0) - (a.inputPrice ?? 0) || a.model.length - b.model.length)[0];
    if (rec) rec.badges.push('recommended');
    const cheap = [...eligible].sort((a, b) => (a.inputPrice ?? 0) + (a.outputPrice ?? 0) / 4 - ((b.inputPrice ?? 0) + (b.outputPrice ?? 0) / 4) || day(b.created) - day(a.created))[0];
    if (cheap && cheap !== rec) cheap.badges.push('cheapest');
    for (const r of mine) {
      if (r.badges.includes('recommended') || r.badges.includes('current')) r.badges = r.badges.filter((b) => b !== 'newest');
      r.badges.sort((a, b) => BADGE_ORDER.indexOf(a) - BADGE_ORDER.indexOf(b));
    }

    rows.push(...mine);
  }
  return rows;
}

const BADGE_ORDER: Badge[] = ['current', 'recommended', 'cheapest', 'newest'];

export interface PickerFilter {
  query: string;
  /** `fits`: the tier's price band only (default). `all`: every price. */
  band: 'fits' | 'all';
  /** Show previews, snapshots, deprecated and superseded rows. */
  showHidden: boolean;
  /** `${route}::${vendor}` groups the user expanded past the first few rows. */
  expanded: ReadonlySet<string>;
  /** Rows kept visible regardless of filters (the multi-select draft). */
  pinned?: ReadonlySet<string>;
}

export interface VendorGroup {
  id: string;
  vendor: string;
  rows: PickerRow[];
  /** Rows folded behind "+N more". */
  more: number;
}

export interface RouteGroup {
  route: PickerRouteSpec;
  vendors: VendorGroup[];
  /** Rows the filter dropped (so the heading can say "4 more at other prices"). */
  filtered: number;
}

/** Rows per vendor before "+N more" in the default (no-search) view. */
export const COLLAPSE_AT = 3;

function textOf(r: PickerRow, route: PickerRouteSpec): string {
  return `${r.model} ${r.displayName} ${vendorLabel(r.vendor)} ${r.vendor} ${route.label}`;
}

/**
 * Filter, rank and group the rows for display. With a query, every row that
 * matches is shown (band and collapse ignored) ranked by fuzzy score; hidden
 * variants still need `showHidden`. Without one, the tier's band is the
 * default filter and each vendor folds after `COLLAPSE_AT` rows.
 */
export function groupPickerRows(rows: readonly PickerRow[], routes: readonly PickerRouteSpec[], f: PickerFilter): RouteGroup[] {
  const q = f.query.trim();
  const out: RouteGroup[] = [];
  for (const route of routes) {
    const mine = rows.filter((r) => r.route === route.id);
    const scored = new Map<PickerRow, number>();
    let filtered = 0;
    const keep = mine.filter((r) => {
      const always = r.badges.includes('current') || f.pinned?.has(r.key);
      if (!always && r.hidden && !f.showHidden) return false;
      if (q) {
        const s = fuzzyScore(q, textOf(r, route));
        if (s === null) return false;
        scored.set(r, s);
        return true;
      }
      if (!always && f.band === 'fits' && r.band !== 'in') { filtered++; return false; }
      return true;
    });
    const byVendor = new Map<string, PickerRow[]>();
    for (const r of keep) {
      const v = route.catalog === 'openrouter' ? r.vendor : route.id;
      byVendor.set(v, [...(byVendor.get(v) ?? []), r]);
    }
    const vendors: VendorGroup[] = [...byVendor.entries()]
      .sort(([a], [b]) => (q ? (Math.max(...byVendor.get(b)!.map((r) => scored.get(r) ?? 0)) - Math.max(...byVendor.get(a)!.map((r) => scored.get(r) ?? 0))) || compareVendors(a, b) : compareVendors(a, b)))
      .map(([vendor, list]) => {
        const sorted = [...list].sort((a, b) =>
          (q ? (scored.get(b) ?? 0) - (scored.get(a) ?? 0) : 0)
          || rank(b) - rank(a)
          || (a.band === 'in' ? 0 : 1) - (b.band === 'in' ? 0 : 1)
          || day(b.created) - day(a.created)
          || (b.inputPrice ?? 0) - (a.inputPrice ?? 0)
          || a.model.localeCompare(b.model));
        const id = `${route.id}::${vendor}`;
        if (q || f.expanded.has(id) || sorted.length <= COLLAPSE_AT + 1) return { id, vendor, rows: sorted, more: 0 };
        const head = sorted.slice(0, COLLAPSE_AT);
        const tail = sorted.slice(COLLAPSE_AT);
        const stick = tail.filter((r) => r.badges.includes('current') || r.badges.includes('recommended') || f.pinned?.has(r.key));
        return { id, vendor, rows: [...head, ...stick], more: tail.length - stick.length };
      });
    if (vendors.length > 0 || !q) out.push({ route, vendors, filtered });
  }
  return out;
}

function rank(r: PickerRow): number {
  return (r.badges.includes('current') ? 4 : 0) + (r.badges.includes('recommended') ? 2 : 0);
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatPrice(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n === 0) return '$0';
  if (n < 0.1) return `$${n.toFixed(3).replace(/0+$/, '')}`;
  if (n < 10) return `$${n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}`;
  return `$${Math.round(n)}`;
}

export function formatContext(n: number | undefined): string {
  if (!n) return '–';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1000)}k`;
}

export function formatReleased(created: number | undefined): string {
  if (!created) return '–';
  return new Date(created * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface CompareCell {
  label: string;
  value: string;
  /** Relative to the baseline: `-40%`, `2.5x`, `newer`. Empty when equal or unknown. */
  delta: string;
  /** For a price, lower is good; for context and recency, higher is. */
  better: boolean | null;
}

function ratio(value: number | undefined, base: number | undefined, lowerIsBetter: boolean): Pick<CompareCell, 'delta' | 'better'> {
  if (value === undefined || base === undefined || base === 0 || value === base) return { delta: value === base && value !== undefined ? '=' : '', better: null };
  const r = value / base;
  const delta = r >= 2 ? `${r.toFixed(r >= 10 ? 0 : 1).replace(/\.0$/, '')}x` : `${r > 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`;
  return { delta, better: lowerIsBetter ? r < 1 : r > 1 };
}

/** The four numbers the compare strip shows for `row` against `base`. */
export function compareRows(row: PickerRow, base: PickerRow | null): CompareCell[] {
  const b = base && base.key !== row.key ? base : null;
  return [
    { label: 'in', value: formatPrice(row.inputPrice), ...(b ? ratio(row.inputPrice, b.inputPrice, true) : { delta: '', better: null }) },
    { label: 'out', value: formatPrice(row.outputPrice), ...(b ? ratio(row.outputPrice, b.outputPrice, true) : { delta: '', better: null }) },
    { label: 'ctx', value: formatContext(row.contextLength), ...(b ? ratio(row.contextLength, b.contextLength, false) : { delta: '', better: null }) },
    {
      label: 'released',
      value: formatReleased(row.created),
      ...(b && row.created && b.created && day(row.created) !== day(b.created)
        ? { delta: day(row.created) > day(b.created) ? 'newer' : 'older', better: day(row.created) > day(b.created) }
        : { delta: '', better: null }),
    },
  ];
}

// ── Route presets ───────────────────────────────────────────────────────────

/**
 * Settings → Model tiers, base models. The ids are the registry's providers
 * (`POST /api/model-tiers`); the order is the owner's: the key that pays first.
 */
export const TIER_ROUTES: readonly PickerRouteSpec[] = [
  { id: 'anthropic', label: 'Anthropic key', catalog: 'anthropic', note: 'agent runs, chat · also Claude runners' },
  { id: 'openai', label: 'OpenAI key', catalog: 'openai', note: 'chat only' },
  { id: 'openrouter', label: 'OpenRouter key', catalog: 'openrouter', note: 'agent runs, chat' },
  { id: 'openai-codex', label: 'Runner · Codex', catalog: 'openai', note: 'agent runs only · Codex seat' },
];

/** Pool arm routes (`ArmRoute` in @buildd/core/tier-pool) as picker groups. */
export const ARM_ROUTE_SPECS: Record<string, PickerRouteSpec> = {
  anthropic: { id: 'anthropic', label: 'Anthropic key', catalog: 'anthropic' },
  openai: { id: 'openai', label: 'OpenAI key', catalog: 'openai' },
  openrouter: { id: 'openrouter', label: 'OpenRouter key', catalog: 'openrouter' },
  'runner:claude': { id: 'runner:claude', label: 'Runner · Claude', catalog: 'anthropic' },
  'runner:codex': { id: 'runner:codex', label: 'Runner · Codex', catalog: 'openai' },
};

/** Attach key status from `GET /api/inference-keys` to key-backed routes. */
export function withKeyStatus(
  routes: readonly PickerRouteSpec[],
  keys: Partial<Record<'anthropic' | 'openai' | 'openrouter', boolean>> | null,
): PickerRouteSpec[] {
  if (!keys) return [...routes];
  return routes.map((r) => {
    const k = r.id === 'anthropic' || r.id === 'openai' || r.id === 'openrouter' ? keys[r.id] : undefined;
    return k === undefined ? r : { ...r, key: k ? 'set' : 'missing' };
  });
}

// ── Where the pick will run ─────────────────────────────────────────────────

/** What the chosen model will be used for. Omitted = no check. */
export type PickerTarget = 'chat' | 'claude-code' | 'cloud' | 'codex';

/** Resolve a picker's `target`, which may vary by route (a coding cell mixes Claude and Codex runners). */
export function targetOf(target: PickerTarget | ((routeId: string) => PickerTarget | undefined) | undefined, routeId: string): PickerTarget | undefined {
  return typeof target === 'function' ? target(routeId) : target;
}

/** What a tier cell's pick will run: chat is chat; coding is Codex on the Codex runner, Claude Code otherwise. */
export function cellTarget(surface: 'agent' | 'chat'): (routeId: string) => PickerTarget {
  return (routeId) => (surface === 'chat' ? 'chat' : routeId === 'runner:codex' ? 'codex' : 'claude-code');
}

const OPENAI_ROUTES = new Set(['openai', 'openai-codex', 'runner:codex']);
const needsAnthropicWire = (t: PickerTarget) => t === 'claude-code' || t === 'cloud';

const TARGET_WORD: Record<PickerTarget, string> = {
  chat: 'chat', 'claude-code': 'Claude Code', cloud: 'cloud coding', codex: 'Codex',
};

/**
 * Why a route can't serve `target`, or null. An OpenAI API key or Codex seat
 * speaks the OpenAI wire; Claude Code and cloud coding need an
 * Anthropic-compatible one (Anthropic, OpenRouter, a gateway), and an OpenAI
 * key does not serve chat from a Codex seat either.
 */
export function routeUnsupported(route: Pick<PickerRouteSpec, 'id' | 'catalog'>, target: PickerTarget | undefined): string | null {
  if (!target) return null;
  const openai = OPENAI_ROUTES.has(route.id) || route.catalog === 'openai';
  if (openai && needsAnthropicWire(target)) {
    return `${route.id === 'openai-codex' || route.id === 'runner:codex' ? 'A Codex seat' : 'An OpenAI key'} can't run ${TARGET_WORD[target]}: it needs an Anthropic-compatible route. Use Anthropic or OpenRouter.`;
  }
  if (route.id === 'openai-codex' && target === 'chat') return "A Codex seat signs in Codex only; it can't serve chat. Use an OpenAI API key.";
  if (!openai && target === 'codex' && route.id !== 'openrouter') return `${route.id} models don't run in Codex. Use an OpenAI key or Codex seat.`;
  return null;
}

/**
 * A row's warning for `target`: the route can't serve it, or the model itself is
 * OpenAI's on a route that carries it to Claude Code / cloud (e.g. via OpenRouter).
 */
export function rowWarning(row: Pick<PickerRow, 'route' | 'vendor'>, route: Pick<PickerRouteSpec, 'id' | 'catalog'>, target: PickerTarget | undefined): string | null {
  const r = routeUnsupported(route, target);
  if (r) return r;
  if (target && needsAnthropicWire(target) && row.vendor === 'openai') {
    return `OpenAI models don't run in ${TARGET_WORD[target]} reliably: the tool protocol differs. Pick a Claude model, or use Codex.`;
  }
  return null;
}
