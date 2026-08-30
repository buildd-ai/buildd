/**
 * GET /api/models — the model list behind the ModelPicker's "Pin exact model".
 *
 * This route used to be `process.env.ANTHROPIC_API_KEY` or nothing: no key meant
 * an empty list, which made the picker say *"No models available — check your
 * Anthropic API key in Settings"* — naming a Settings field that does not exist,
 * on a deployment where that env var is never set. It also silently disabled the
 * stale-pin warning, because an empty catalog makes every pin look valid.
 *
 * Now there are two sources and the response says which it got:
 * - The team's tier registry, always. These are the models this team actually
 *   routes to, across every provider, and it needs no credential at all.
 * - The live Anthropic catalog, when the team has a stored credential
 *   (`resolveAnthropicAuth`). This is what makes pinning a specific dated release
 *   possible, and it is additive — never a precondition for the route working.
 *
 * `catalogComplete` tells the client whether absence from the list means anything.
 * Only a complete catalog can justify a "your pinned model is gone" warning.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import { resolveActiveTeamId } from '@/lib/team-access';
import { resolveAnthropicAuth } from '@/lib/claude-credential';
import { resolveAllTiers, type Tier } from '@buildd/core/model-tier-registry';

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

const TIER_ORDER: Tier[] = ['premium', 'standard', 'budget'];

/** Exposed for tests only — resets the in-memory cache. */
export function _resetCache() {
  catalogCache.clear();
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

  const [tierEntries, catalog] = await Promise.all([
    registryModels(teamId),
    getCachedCatalog(teamId),
  ]);

  // Tier entries first — they are the models this team actually uses, and one of
  // them is almost always the right answer. The live catalog fills in the exact
  // releases behind them, deduplicated by id so a tier model that also appears in
  // the catalog keeps its tier label.
  const seen = new Set(tierEntries.map(m => m.id));
  const models = [
    ...tierEntries,
    ...(catalog ?? []).filter(m => !seen.has(m.id)),
  ];

  return NextResponse.json({ models, catalogComplete: catalog !== null });
}
