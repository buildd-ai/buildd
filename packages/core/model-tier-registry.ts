/**
 * Model tier registry — resolves premium-plus/premium/standard/budget → concrete provider + model.
 *
 * The resolver is the standalone model policy (`@builddai/ai-kit/policy`, via
 * model-policy.ts); this module loads a team's registry rows as a policy
 * document and adds buildd's default layer. There is no second resolver here.
 *
 * Resolution chain (first match wins). S is the caller's surface: 'agent' for
 * claims (the policy's `coding`), 'chat' for chat turns and inference calls
 * (`chat`). A row with surface=NULL serves both surfaces.
 *   1. Workspace + surface row   ┐
 *   2. Workspace row             │ the registry as a ModelPolicy: overrides,
 *   3. Team + surface row        │ surfaces, tiers — the policy's precedence
 *   4. Team row                  ┘
 *   5. Remote policy service     (only when BUILDD_MODEL_POLICY_URL/TOKEN are
 *                                 set; skipped while it is down)
 *   6. Live catalog pick         (newest release in the tier's price band — see
 *                                 model-catalog.ts; self-heals without a deploy)
 *   7. Bundled fallback          (DEFAULT_MODEL_POLICY = TIER_DEFAULTS, last resort)
 *
 * Resolution happens at claim time so a registry update affects already-queued tasks
 * within the next 60-second cache window — no deploy needed. The catalog step
 * carries its own 24h cache (model-catalog-cache.ts), so it self-heals on the
 * same "no deploy" property without hitting OpenRouter on every claim.
 *
 * See docs/design/model-tiers.md and docs/specs/model-policy.md.
 */

import { db } from './db/client';
import { modelTierRegistry } from './db/schema';
import { eq } from 'drizzle-orm';
export type { Tier, TierProvider, TierEntry, TierSurface } from './model-tier-defaults';
export { TIER_DEFAULTS, TIERS, TIER_SURFACES } from './model-tier-defaults';
import type { Tier, TierEntry, TierProvider, TierSurface } from './model-tier-defaults';
import { TIERS, TIER_SURFACES, bundledTierEntry } from './model-tier-defaults';
import { resolveRegistryTier, resolveRemoteTier, tierEntryFromRegistry, tierEntryFromRemote, type TierPolicyMeta } from './model-policy';
import { pickTierModel } from './model-catalog';
import { getCachedOpenRouterCatalog } from './model-catalog-cache';
import { makeCatalogServabilityCheck, type UnrecognizedModelReason } from './model-capability-requirements';

/** Maps the model-router's legacy alias vocabulary to the new tier vocabulary. */
export function mapRouterAlias(alias: string): Tier {
  if (alias === 'opus')   return 'premium';
  if (alias === 'haiku')  return 'budget';
  return 'standard'; // 'sonnet' and anything else → standard
}

// In-memory cache of each team's registry rows (its policy document), keyed by
// team. Flushed on any registry write via invalidateTierCache.
const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const cache = new Map<string, { rows: RegistryRow[]; loadedAt: number }>();

type RegistryRow = typeof modelTierRegistry.$inferSelect;

/**
 * Flush the in-memory cache for a team. A team's rows are one document, so a
 * workspace write and a team write flush the same entry.
 */
export function invalidateTierCache(teamId: string, _workspaceId?: string | null): void {
  cache.delete(teamId);
}

interface RegistryRowLike {
  workspaceId: string | null;
  surface?: string | null;
}

/**
 * Pick the row that serves `surface` from one team's rows for one tier, in the
 * order workspace+surface → workspace → team+surface → team. `surface` null
 * reads the shared (NULL-surface) rows only: the view Settings edits when a
 * tier is not split.
 *
 * Answered by the policy resolver over the rows as a policy document, so the
 * admin views and the runtime agree by construction.
 */
export function pickRegistryRow<R extends RegistryRowLike>(
  rows: readonly R[],
  workspaceId: string | null | undefined,
  surface: TierSurface | null,
): R | undefined {
  // The rows are one tier's; the tier only keys the document.
  const tagged = rows.map((r) => ({ ...r, tier: 'standard' as const, __row: r }));
  return resolveRegistryTier(tagged, 'standard', workspaceId, surface)?.row.__row;
}

/**
 * Resolve a tier from the live catalog when no registry row pins it — the
 * self-healing path. Null means "learned nothing" (empty/failed catalog, or
 * nothing in-band survives the capability filter): the caller falls back to
 * TIER_DEFAULTS rather than inventing a pick.
 *
 * `runnerCliVersion`, when supplied, excludes a candidate the claiming runner
 * cannot actually serve (its CLI predates the model's version floor) — the
 * newest-wins sort in `pickTierModel` then lands on the previous in-band
 * release instead of deferring the task entirely. A release newer than every
 * model in MODEL_MIN_CLI_VERSION is excluded regardless of version, because
 * its floor is unknown (see makeCatalogServabilityCheck).
 */
/**
 * Ids already warned about as held back, so a refused model is logged once per
 * process rather than on every claim. Keyed by id + reason.
 */
const warnedUnrecognized = new Set<string>();

function warnUnrecognized(id: string, reason: UnrecognizedModelReason): void {
  const key = `${reason}:${id}`;
  if (warnedUnrecognized.has(key)) return;
  warnedUnrecognized.add(key);
  const why =
    reason === 'newer_than_floor_table'
      ? 'it was released after every model in MODEL_MIN_CLI_VERSION, so its CLI floor is unknown'
      : reason === 'no_recorded_model_in_catalog'
        ? 'no model in MODEL_MIN_CLI_VERSION is in the catalog, so nothing marks which releases are known (tiers fall back to TIER_DEFAULTS)'
        : 'the catalog gave no release time for it';
  console.warn(
    `[model-tier-registry] catalog pick refused ${id}: ${why}. ` +
      `To adopt it, add its minimum CLI version to MODEL_MIN_CLI_VERSION in packages/core/model-capability-requirements.ts.`,
  );
}

async function resolveFromCatalog(
  tier: Tier,
  runnerCliVersion?: string | null,
): Promise<TierEntry | null> {
  try {
    const entries = await getCachedOpenRouterCatalog();
    if (entries.length === 0) return null;

    const pick = pickTierModel(tier, entries, 'anthropic', {
      isServable: makeCatalogServabilityCheck(entries, runnerCliVersion, {
        onUnrecognized: warnUnrecognized,
      }),
    });
    if (!pick) return null;

    return { provider: 'anthropic', model: pick.id, source: 'catalog' };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective tier entry for a given team, optional workspace and
 * surface. Returns the entry + source annotation ('workspace' | 'team' |
 * 'policy' | 'catalog' | 'default'); `surface` is set on the entry when a
 * surface row served it, and `policy` names the policy decision behind it.
 *
 * Every caller names its surface: claims pass 'agent', chat and inference
 * calls pass 'chat'. `null` reads the shared rows only.
 *
 * The returned entry is what gets passed to the runner as { model, provider, ... }.
 * For provider='openrouter', the backend implementation is out of scope but the
 * entry is stored and retrievable — dispatch throws a clear error if dispatched.
 *
 * `runnerCliVersion` (the claiming runner's reported CLI version) only affects
 * the catalog step — an explicit registry row is an operator's deliberate
 * choice and is never second-guessed by a client capability check.
 */
export async function resolveTierEntry(
  tier: Tier,
  teamId: string | null,
  workspaceId: string | null | undefined,
  surface: TierSurface | null,
  runnerCliVersion?: string | null,
): Promise<TierEntry> {
  // 1–4: the team's registry as a policy document. No team, no registry: the
  // default layer still answers, so no caller needs a fallback of its own.
  const rows = teamId ? await loadTeamRows(teamId) : null;
  if (rows) {
    const hit = resolveRegistryTier(rows, tier, workspaceId, surface);
    if (hit) return tierEntryFromRegistry(hit);
  }

  // 5: the policy service, for a tier the registry leaves unset. Its answer is
  // the default layer; an admin's row above always wins.
  const remote = await resolveRemoteTier(tier, workspaceId, surface);
  if (remote) return tierEntryFromRemote(remote);

  // 6: no explicit registry row (or the DB was unreachable): try the live
  // catalog before the hand-maintained default. A same-band release is
  // adopted without a registry write only if it was released no later than
  // the newest model in MODEL_MIN_CLI_VERSION; anything newer needs a floor
  // row there (a code change, so a deploy) first — see resolveFromCatalog.
  // Not cached per team — the pick can depend on the claiming runner's CLI
  // version. getCachedOpenRouterCatalog() already caches the expensive part
  // (the network fetch); pickTierModel is a cheap in-memory scan.
  // The catalog refines the policy's bundled layer, so it reports as one.
  const catalogEntry = await resolveFromCatalog(tier, runnerCliVersion);
  if (catalogEntry) return { ...catalogEntry, policy: bundledMeta('buildd-catalog', surface) };

  // 7: the policy's bundled fallback.
  return { ...bundledTierEntry(tier, surface ?? 'agent'), policy: bundledMeta('bundled', surface) };
}

function bundledMeta(version: string, surface: TierSurface | null): TierPolicyMeta {
  return { version, planId: null, source: 'bundled', surface: surface === 'chat' ? 'chat' : 'coding' };
}

/** One team's registry rows, cached; null when the DB is unreachable. */
async function loadTeamRows(teamId: string): Promise<RegistryRow[] | null> {
  const now = Date.now();
  const cached = cache.get(teamId);
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.rows;
  try {
    const rows = await db.query.modelTierRegistry.findMany({
      where: eq(modelTierRegistry.teamId, teamId),
    });
    cache.set(teamId, { rows, loadedAt: now });
    return rows;
  } catch {
    // DB unavailable — fall through to the default layer.
    return null;
  }
}

/**
 * Workspaces with their own registry row per tier x surface (a NULL-surface
 * workspace row overrides both surfaces). These keep their own model whatever
 * the team cell's dial does. Empty when the DB is unreachable.
 */
export async function workspaceOverrideCounts(teamId: string): Promise<Map<string, number>> {
  const rows = (await loadTeamRows(teamId)) ?? [];
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.workspaceId) continue;
    for (const surface of r.surface ? [r.surface] : TIER_SURFACES) {
      const key = `${r.tier}:${surface}`;
      const set = seen.get(key) ?? new Set<string>();
      set.add(r.workspaceId);
      seen.set(key, set);
    }
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}

/**
 * Synchronous resolve using code-level defaults only.
 * Used in contexts where async isn't possible (e.g. runner config fallback).
 */
export function resolveTierEntrySync(tier: Tier): TierEntry {
  return bundledTierEntry(tier);
}

/**
 * Return the effective tier map for a workspace and surface (every tier
 * resolved). `surface` null reads the shared rows only.
 */
export async function resolveAllTiers(
  teamId: string,
  workspaceId: string | null | undefined,
  surface: TierSurface | null,
): Promise<Record<Tier, TierEntry>> {
  const entries = await Promise.all(
    TIERS.map((tier) => resolveTierEntry(tier, teamId, workspaceId, surface)),
  );
  return Object.fromEntries(
    TIERS.map((tier, i) => [tier, entries[i]]),
  ) as Record<Tier, TierEntry>;
}
