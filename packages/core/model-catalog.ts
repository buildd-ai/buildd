/**
 * Live model catalog, read from OpenRouter's PUBLIC model list.
 *
 * Why OpenRouter and not the vendors directly: `api.anthropic.com/v1/models`
 * and OpenAI's equivalent both require a credential, so every catalog-dependent
 * check we had either needed a key we do not set in CI (`auditTierModels`) or
 * silently degraded to nothing. `openrouter.ai/api/v1/models` needs no key,
 * covers both vendors in one call, and — the part the vendor endpoints do not
 * give us — carries PRICING, which is the field tier selection actually needs.
 *
 * No DB dependencies: pure functions plus one fetch. The cached/persisted layer
 * lives in `model-catalog-cache.ts` so this module stays importable anywhere
 * (runner, web, tests) without a database.
 *
 * This is a discovery source, not a policy source. It tells us what exists and
 * what it costs; `TIER_PRICE_BANDS` below is where our policy lives.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export type CatalogProvider = 'anthropic' | 'openai' | 'other';

/** USD per 1M tokens. Same shape as `model-prices.ts` consumes. */
export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogEntry extends TokenPrice {
  /** Native provider model id — what we pass to the SDK. */
  id: string;
  /** The dated snapshot id when the catalog names one (`claude-sonnet-5-20260630`). */
  canonicalId: string | null;
  /** OpenRouter's own id, kept for provenance when debugging a bad pick. */
  openRouterId: string;
  provider: CatalogProvider;
  displayName: string;
  contextLength: number;
  /** Release time, unix seconds. The only ordering signal we trust. */
  created: number;
}

/**
 * Tier policy: a two-sided price band per tier, newest release inside the band wins.
 *
 * Half-open intervals on input $/MTok — contiguous and non-overlapping:
 *   budget [0, 1.5)   standard [1.5, 4)   premium [4, 8)   premium-plus [8, 20)
 *
 * Both sides are load-bearing:
 * - The FLOOR stops a cheap new model from capturing a higher tier. Sonnet 5 is
 *   newer than every Opus 4.x and less than half the price; a ceiling-only band
 *   would hand it `premium` and quietly downgrade all planning work.
 * - The CEILING stops an unreviewed price jump. Fable at $10/$50 must be an
 *   opt-in tier, not something that silently doubles the cost of premium work.
 *
 * The premium floor is $4, not $3, on purpose: Sonnet 4.x prices at exactly
 * $3.00, so a $3 floor puts a mid-tier model inside the premium band. Today
 * "newest wins" happens to pick Opus 5 over it anyway, but that is luck about
 * release order, not a rule — a future Sonnet at $3 would capture premium.
 * $4 is the real gap in Anthropic's price ladder ($3 mid / $5 frontier).
 *
 * The premium-plus ceiling of $20 keeps the retired $15 Opus 4/4.1 in-band
 * (harmless — they lose on age) while excluding the $30 `-pro` variants.
 *
 * Between those rails, "newest wins" is what keeps us off a stale generation
 * without a deploy — the thing that let `standard` sit on Sonnet 4.6 for months
 * after Sonnet 5 shipped CHEAPER.
 */
export const TIER_PRICE_BANDS = {
  'premium-plus': { minInput: 8, maxInput: 20 },
  premium: { minInput: 4, maxInput: 8 },
  standard: { minInput: 1.5, maxInput: 4 },
  budget: { minInput: 0, maxInput: 1.5 },
} as const;

export type CatalogTier = keyof typeof TIER_PRICE_BANDS;

/** Below this, a model cannot hold a buildd worker's context. Drops legacy entries. */
const MIN_CONTEXT_TOKENS = 200_000;

/**
 * Non-chat models that would otherwise pass the filters. The `tools` check
 * catches most of them; this catches the rest without waiting for one to be
 * picked as a tier.
 */
const NON_CHAT = /image|audio|tts|voice|embed|moderat|rerank|ocr|whisper|sora|realtime/i;

/**
 * Floating aliases (`gpt-chat-latest`). Excluded because the point of resolving
 * a tier is to name a specific model: a `-latest` id silently changes what runs
 * underneath a task, so the same tier stops being reproducible across claims.
 * (OpenRouter's own deprecated aliases are `~`-prefixed and dropped separately.)
 */
const FLOATING_ALIAS = /-latest$/i;

interface RawModel {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: Record<string, unknown>;
  supported_parameters?: unknown;
}

/** OpenRouter quotes USD per token as a string; we work in USD per 1M tokens. */
function perMillion(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}

function providerOf(orId: string): CatalogProvider {
  if (orId.startsWith('anthropic/')) return 'anthropic';
  if (orId.startsWith('openai/')) return 'openai';
  return 'other';
}

/**
 * OpenRouter writes Anthropic versions with dots (`claude-haiku-4.5`); the
 * Anthropic API only answers to dashes (`claude-haiku-4-5`). OpenAI's dots are
 * real (`gpt-5.3-codex`), so this rewrite is Anthropic-only.
 */
function nativeId(slug: string, provider: CatalogProvider): string {
  return provider === 'anthropic' ? slug.replace(/\./g, '-') : slug;
}

export function normalizeCatalog(raw: unknown): CatalogEntry[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const out: CatalogEntry[] = [];

  for (const item of data as RawModel[]) {
    const orId = typeof item?.id === 'string' ? item.id : null;
    if (!orId) continue;

    // `~` marks a deprecated alias; `:` marks a variant served on a different
    // endpoint (`:batch`, `:free`). Neither is a model we can route a worker to.
    if (orId.startsWith('~') || orId.includes(':')) continue;

    const provider = providerOf(orId);
    const slug = orId.slice(orId.indexOf('/') + 1);
    if (NON_CHAT.test(slug) || FLOATING_ALIAS.test(slug)) continue;

    const params = item.supported_parameters;
    if (!Array.isArray(params) || !params.includes('tools')) continue;

    const modalities = item.architecture?.output_modalities;
    if (Array.isArray(modalities) && !modalities.includes('text')) continue;

    const input = perMillion(item.pricing?.prompt);
    const output = perMillion(item.pricing?.completion);
    if (input === null || output === null) continue;

    const contextLength = typeof item.context_length === 'number' ? item.context_length : 0;
    const created = typeof item.created === 'number' ? item.created : 0;

    const canonicalSlug = typeof item.canonical_slug === 'string' ? item.canonical_slug : null;
    const canonical = canonicalSlug
      ? nativeId(canonicalSlug.slice(canonicalSlug.indexOf('/') + 1), provider)
      : null;

    const id = nativeId(slug, provider);

    out.push({
      id,
      canonicalId: canonical && canonical !== id ? canonical : null,
      openRouterId: orId,
      provider,
      displayName: typeof item.name === 'string' ? item.name : id,
      contextLength,
      created,
      input,
      output,
      // Cache rates are optional in the feed. The vendor ratios (~0.1x read,
      // ~1.25x write) are the documented defaults, so derive rather than drop
      // the entry — a missing cache rate must not cost us a whole model.
      cacheRead: perMillion(item.pricing?.input_cache_read) ?? input * 0.1,
      cacheWrite: perMillion(item.pricing?.input_cache_write) ?? input * 1.25,
    });
  }

  return out;
}

/** Strip a dated snapshot suffix: `claude-sonnet-5-20260630` -> `claude-sonnet-5`. */
function stripSnapshot(id: string): string {
  return id.replace(/-\d{8}$/, '');
}

/**
 * Price a model id against the catalog, or null when the catalog does not know it.
 *
 * Null on purpose: the caller falls back to the static table. Guessing a tier is
 * how a $10/$50 model ends up billed at $3/$15 — an unknown model must be
 * reported as unknown, not quietly defaulted.
 */
export function priceFromCatalog(
  entries: readonly CatalogEntry[],
  modelId: string,
): TokenPrice | null {
  if (!modelId) return null;
  const want = modelId.toLowerCase();
  const bare = stripSnapshot(want);

  const hit =
    entries.find((e) => e.id.toLowerCase() === want) ??
    entries.find((e) => e.canonicalId?.toLowerCase() === want) ??
    entries.find((e) => e.id.toLowerCase() === bare);

  if (!hit) return null;
  return { input: hit.input, output: hit.output, cacheRead: hit.cacheRead, cacheWrite: hit.cacheWrite };
}

/**
 * Resolve a tier to a concrete model: newest release inside the tier's price band.
 * Returns null when nothing qualifies — the caller keeps its configured value
 * rather than being handed a model from the wrong tier.
 */
export function pickTierModel(
  tier: CatalogTier,
  entries: readonly CatalogEntry[],
  provider: CatalogProvider = 'anthropic',
): CatalogEntry | null {
  const band = TIER_PRICE_BANDS[tier];

  const candidates = entries.filter(
    (e) =>
      e.provider === provider &&
      e.contextLength >= MIN_CONTEXT_TOKENS &&
      e.input >= band.minInput &&
      e.input < band.maxInput,
  );
  if (candidates.length === 0) return null;

  // Newest first BY DAY, then the pricier (more capable) model, then the
  // shorter id.
  //
  // Day granularity is deliberate. In the live catalog `gpt-5.6-terra-pro` is
  // timestamped four seconds after `gpt-5.6-terra` at an identical price —
  // an indexing artifact, not a release order. Comparing raw seconds let that
  // artifact decide the tier, so `standard` resolved to the `-pro` variant: a
  // different product with different latency and limits, chosen by noise.
  // Rounding to the day makes same-day siblings tie, and the shorter id then
  // picks the base variant deterministically.
  const day = (t: number) => Math.floor(t / 86_400);
  return candidates.sort(
    (a, b) => day(b.created) - day(a.created) || b.input - a.input || a.id.length - b.id.length,
  )[0];
}

/**
 * Fetch the public catalog. No credential, by design — that is the whole point.
 * Returns [] on any failure; the caller decides whether that means "unknown".
 */
export async function fetchOpenRouterCatalog(
  signal?: AbortSignal,
): Promise<CatalogEntry[]> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.warn(`[model-catalog] OpenRouter returned HTTP ${res.status}`);
      return [];
    }
    return normalizeCatalog(await res.json());
  } catch (e) {
    console.warn('[model-catalog] catalog fetch failed:', e);
    return [];
  }
}
