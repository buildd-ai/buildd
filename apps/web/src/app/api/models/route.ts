/**
 * GET /api/models — the model list behind the ModelPicker's "Pin exact model".
 *
 * This route used to be `process.env.ANTHROPIC_API_KEY` or nothing: no key meant
 * an empty list, which made the picker say *"No models available — check your
 * Anthropic API key in Settings"* — naming a Settings field that does not exist,
 * on a deployment where that env var is never set. It also silently disabled the
 * stale-pin warning, because an empty catalog makes every pin look valid.
 *
 * Now there are three sources and the response says which it got:
 * - The team's tier registry, always. These are the models this team actually
 *   routes to, across every provider, and it needs no credential at all.
 * - The PUBLIC OpenRouter catalog, always. No key, both vendors, and it carries
 *   pricing — so the tier audit below finally runs on every deployment instead
 *   of only where an Anthropic credential happens to be stored.
 * - The live Anthropic catalog, when the team has a stored credential
 *   (`resolveAnthropicAuth`). Still worth fetching: it is authoritative for
 *   dated snapshot ids and for models OpenRouter does not resell.
 *
 * `catalogComplete` tells the client whether absence from the list means anything.
 * Only a complete catalog can justify a "your pinned model is gone" warning.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { resolveAnthropicAuth } from '@/lib/claude-credential';
import { resolveAllTiers, TIERS, type Tier } from '@buildd/core/model-tier-registry';
import { auditTierModels } from '@buildd/core/model-tier-liveness';
import { fetchOpenRouterCatalog, type CatalogEntry } from '@buildd/core/model-catalog';
import { setCatalogPrices } from '@buildd/core/model-prices';

interface AnthropicModel {
  id: string;
  display_name?: string;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  provider: string;
  /** Set when this model is what a tier currently resolves to. */
  tier?: Tier;
}

interface CachedCatalog {
  models: ModelEntry[];
  fetchedAt: number;
}

// 24-hour cache of the live catalog, per team — a team-wide cache would leak one
// team's reachable models into another team's picker.
const catalogCache = new Map<string, CachedCatalog>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

const TIER_ORDER: readonly Tier[] = TIERS;

/** Exposed for tests only — resets the in-memory caches. */
export function _resetCache() {
  catalogCache.clear();
  publicCatalog = null;
}

/**
 * The team's configured tier models. Zero credentials, zero network — this is why
 * the route can no longer fail closed.
 */
async function registryModels(teamId: string): Promise<ModelEntry[]> {
  try {
    const tiers = await resolveAllTiers(teamId);
    return TIER_ORDER.map(tier => {
      const entry = tiers[tier];
      return {
        id: entry.model,
        displayName: `${entry.model} (${tier})`,
        provider: entry.provider,
        tier,
      };
    });
  } catch (e) {
    console.error('[api/models] tier registry read failed:', e);
    return [];
  }
}

/**
 * The live Anthropic catalog, or null when it could not be read.
 *
 * null and [] are different answers and must not be collapsed: null means "we do
 * not know the full catalog" (no credential, API error), while a real empty array
 * would mean the account genuinely has no models. Only the former should suppress
 * the stale-pin warning.
 */
async function liveCatalog(teamId: string): Promise<ModelEntry[] | null> {
  const auth = await resolveAnthropicAuth({ teamId });
  if (!auth) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: auth.headers,
    });
    if (!res.ok) {
      console.warn(`[api/models] catalog fetch failed (${auth.purpose}): HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { data?: AnthropicModel[] };
    return (data.data ?? [])
      .filter(
        (m) =>
          m.id.startsWith('claude-') &&
          !m.id.includes('claude-2') &&
          !m.id.includes('claude-3')
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((m) => ({
        id: m.id,
        displayName: m.display_name ?? m.id,
        provider: 'anthropic',
      }));
  } catch (e) {
    console.warn('[api/models] catalog fetch threw:', e);
    return null;
  }
}

/**
 * The public OpenRouter catalog. No credential, both vendors, carries pricing.
 *
 * Cached team-independently — it is the same public list for everyone, so unlike
 * the credentialed Anthropic catalog there is nothing to leak between teams.
 *
 * Side effect on purpose: publishing prices into `model-prices` is what makes
 * cost math correct for GPT models and for any model released after the static
 * table was last touched.
 */
let publicCatalog: { entries: CatalogEntry[]; fetchedAt: number } | null = null;

async function getPublicCatalog(): Promise<CatalogEntry[]> {
  if (publicCatalog && Date.now() - publicCatalog.fetchedAt < CACHE_TTL) {
    return publicCatalog.entries;
  }
  const entries = await fetchOpenRouterCatalog();
  if (entries.length > 0) {
    publicCatalog = { entries, fetchedAt: Date.now() };
    setCatalogPrices(entries);
  }
  return entries;
}

async function getCachedCatalog(teamId: string): Promise<ModelEntry[] | null> {
  const hit = catalogCache.get(teamId);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL) return hit.models;

  const models = await liveCatalog(teamId);
  // Only a successful read is cached; a missing credential or a transient API
  // error must not pin an empty catalog in place for 24 hours.
  if (models && models.length > 0) {
    catalogCache.set(teamId, { models, fetchedAt: Date.now() });
  }
  return models;
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const teamId = await resolveActiveTeamId(user.id, req.cookies.get('buildd-team')?.value);
  if (!teamId) {
    return NextResponse.json({ models: [], catalogComplete: false });
  }

  const [tierEntries, catalog, publicEntries] = await Promise.all([
    registryModels(teamId),
    getCachedCatalog(teamId),
    getPublicCatalog(),
  ]);

  const publicModels: ModelEntry[] = publicEntries.map(e => ({
    id: e.id,
    displayName: e.displayName,
    provider: e.provider,
  }));

  // Tier entries first — they are the models this team actually uses, and one of
  // them is almost always the right answer. The catalogs fill in the exact
  // releases behind them, deduplicated by id so a tier model that also appears in
  // a catalog keeps its tier label. Credentialed Anthropic entries come before
  // public ones: they carry the dated snapshot ids you cannot pin otherwise.
  const seen = new Set(tierEntries.map(m => m.id));
  const models: ModelEntry[] = [...tierEntries];
  for (const m of [...(catalog ?? []), ...publicModels]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }

  // Audit the team's TIER CONFIG. `detectStalePin` on the client covers a
  // different case (a model the *user* pinned that no longer exists); nothing
  // checked the tiers themselves, so `standard` sat a generation behind a
  // cheaper model with no signal anywhere. Only a complete catalog can justify
  // either verdict — an empty list would condemn every model at once.
  //
  // The audit list is the credentialed catalog when we have one, else the public
  // one. That "else" is the point: the audit previously did nothing at all
  // without an Anthropic credential, which is every deployment that runs on
  // OAuth. Anthropic ids from OpenRouter are normalized to native form
  // (`claude-haiku-4-5`, not `4.5`), so `auditTierModels` can match them.
  const auditList = catalog ?? publicModels.filter(m => m.provider === 'anthropic');
  const tierAudit = auditTierModels(
    Object.fromEntries(
      tierEntries.map(m => [m.tier ?? m.id, { provider: m.provider, model: m.id }]),
    ),
    auditList,
  );
  for (const { tier, model } of tierAudit.unknown) {
    console.warn(`[api/models] tier "${tier}" is pinned to ${model}, which the models API does not return — retired, renamed, or a typo`);
  }
  for (const { tier, model, newer } of tierAudit.superseded) {
    console.warn(`[api/models] tier "${tier}" is on ${model}; ${newer} is newer in the same family — check price and capability before switching`);
  }

  return NextResponse.json({
    models,
    // A public-catalog-only answer is still incomplete for pin validation:
    // OpenRouter does not resell every model (no dated snapshots, and nothing
    // that is not on their platform), so absence from it does not prove a pin
    // is dead. Only the credentialed catalog can justify that warning.
    catalogComplete: catalog !== null,
    catalogSources: {
      registry: tierEntries.length > 0,
      anthropic: catalog !== null,
      openRouter: publicEntries.length > 0,
    },
    tierAudit,
  });
}
