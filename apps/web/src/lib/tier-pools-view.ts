/**
 * The tier screen's rows: one per (surface, tier), each listing its arms with
 * traffic share and stats. Pure and client-safe; the route builds it from the
 * registry, the pools and the stats, and the client only renders it.
 *
 * A tier with no pool reads as `pinned` with one arm, the registry entry, at
 * 100%: exactly what serves it today. The incumbent of each surface's row is
 * the entry that surface resolves to, so a split tier shows a different base
 * model per surface.
 */
import type { Tier, TierEntry } from '@buildd/core/model-tier-defaults';
import { TIERS } from '@buildd/core/model-tier-defaults';
import type { TokenPrice } from '@buildd/core/model-catalog';
import {
  MIN_GRADED_UNITS,
  incumbentRoute,
  tierAllowsPool,
  type ArmRoute,
  type ArmStats,
  type PoolSurface,
} from '@buildd/core/tier-pool';
import { nearestWeightForShare, suggestWeight, type WeightLevel } from '@buildd/core/tier-weights';
import { buildPickerRows, pickerKey, type PickerModelInput, type PickerRouteSpec, type PickerValue } from './model-picker';

export interface PoolArmView {
  /** Null for the synthetic incumbent of a tier with no pool yet. */
  id: string | null;
  route: ArmRoute;
  model: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused';
  share: number;
  /** `split` only. Snapped from the live share when the pool predates weights. */
  weight: WeightLevel;
  stats: ArmStats | null;
}

export interface PoolChangeView {
  kind: string;
  at: string;
  actor: string | null;
}

export interface TierPoolRowView {
  tier: Tier;
  surface: PoolSurface;
  poolId: string | null;
  mode: 'pinned' | 'split';
  /** premium-plus: pinned by rule, no challengers. */
  locked: boolean;
  allocationVersion: number | null;
  incumbentFloor: number;
  explorationCap: number;
  arms: PoolArmView[];
  lastChange: PoolChangeView | null;
  /** Graded units an arm needs before its numbers mean much. */
  minGraded: number;
}

export interface TierPoolsResponse {
  rows: TierPoolRowView[];
  isAdmin: boolean;
}

/** Tiers chat asks for (lib/chat/models.ts ChatTier); agent runs use all four. */
export const CHAT_POOL_TIERS: readonly Tier[] = ['premium', 'standard', 'budget'];

export interface PoolInput {
  pool: {
    id: string; tier: string; surface: PoolSurface; mode: string; allocation: Record<string, number>;
    allocationVersion: number; weights: Record<string, WeightLevel>; incumbentFloor: number; explorationCap: number;
  };
  arms: Array<{ id: string; route: ArmRoute; model: string; role: 'incumbent' | 'challenger'; status: string; addedAt: Date | string }>;
  lastChange: { kind: string; createdAt: Date | string; actorUserId: string | null; actorSystem: string | null } | null;
}

export function buildTierPoolRows(args: {
  /** Each surface's resolved registry entries. */
  tiers: Record<PoolSurface, Record<Tier, TierEntry>>;
  pools: readonly PoolInput[];
  stats: ReadonlyMap<string, ArmStats>;
}): TierPoolRowView[] {
  const rows: TierPoolRowView[] = [];
  for (const surface of ['agent', 'chat'] as const) {
    const tiers = surface === 'agent' ? TIERS : CHAT_POOL_TIERS;
    for (const tier of tiers) {
      const entry = args.tiers[surface]?.[tier];
      const p = args.pools.find(x => x.pool.tier === tier && x.pool.surface === surface);
      const baseRoute = incumbentRoute(surface, entry?.provider ?? 'anthropic');
      const locked = !tierAllowsPool(tier);
      if (!p) {
        rows.push({
          tier, surface, poolId: null, mode: 'pinned', locked, allocationVersion: null,
          incumbentFloor: 0.6, explorationCap: 0.3,
          arms: [{ id: null, route: baseRoute, model: entry?.model ?? '', role: 'incumbent', status: 'active', share: 1, weight: 'high', stats: null }],
          lastChange: null, minGraded: MIN_GRADED_UNITS[surface],
        });
        continue;
      }
      const pinned = p.pool.mode !== 'split';
      const live = p.arms
        .filter(a => a.status === 'active' || a.status === 'paused')
        .sort((a, b) => (a.role === 'incumbent' ? -1 : b.role === 'incumbent' ? 1 : new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime()));
      rows.push({
        tier, surface, poolId: p.pool.id, mode: pinned ? 'pinned' : 'split', locked, allocationVersion: p.pool.allocationVersion,
        incumbentFloor: p.pool.incumbentFloor, explorationCap: p.pool.explorationCap,
        arms: live.map(a => {
          const share = pinned ? (a.role === 'incumbent' ? 1 : 0) : (p.pool.allocation[a.id] ?? 0);
          return {
            id: a.id,
            // The incumbent is the registry row: show what serves today, not the
            // snapshot taken when the pool was created.
            route: a.role === 'incumbent' ? baseRoute : a.route,
            model: a.role === 'incumbent' ? (entry?.model ?? a.model) : a.model,
            role: a.role,
            status: a.status === 'paused' ? 'paused' : 'active',
            // A pinned pool serves the incumbent only, whatever the saved split.
            share,
            // A pool created before weights existed has no entry for this arm
            // yet: snap its current share to the nearest level for display.
            weight: p.pool.weights?.[a.id] ?? nearestWeightForShare(share),
            stats: args.stats.get(a.id) ?? null,
          };
        }),
        lastChange: p.lastChange
          ? { kind: p.lastChange.kind, at: new Date(p.lastChange.createdAt).toISOString(), actor: p.lastChange.actorSystem ?? (p.lastChange.actorUserId ? 'admin' : null) }
          : null,
        minGraded: MIN_GRADED_UNITS[surface],
      });
    }
  }
  return rows;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const ROUTE_LABEL: Record<ArmRoute, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'runner:claude': 'Runner · Claude',
  'runner:codex': 'Runner · Codex',
};

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Win rate, or `n/min` while an arm is still learning, or a dash with nothing graded. */
export function winLabel(stats: ArmStats | null, minGraded: number): { text: string; learning: boolean } {
  if (!stats || stats.graded === 0) return { text: '–', learning: false };
  if (stats.graded < minGraded) return { text: `${stats.graded}/${minGraded}`, learning: true };
  return { text: pct(stats.winRate ?? 0), learning: false };
}

export function costLabel(stats: ArmStats | null): string {
  if (!stats || stats.costPer1k == null) return '–';
  const c = stats.costPer1k;
  if (c >= 1000) return `$${(c / 1000).toFixed(1)}k`;
  if (c >= 10) return `$${Math.round(c)}`;
  return `$${c.toFixed(2)}`;
}

/** Runner arms spend subscription seats: their dollars are virtual. */
export function isVirtualCost(route: ArmRoute): boolean {
  return route === 'runner:claude' || route === 'runner:codex';
}

function tokenPrice(row: { inputPrice?: number; outputPrice?: number } | undefined): TokenPrice | null {
  if (!row || row.inputPrice === undefined || row.outputPrice === undefined) return null;
  return { input: row.inputPrice, output: row.outputPrice, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Cost-aware preset for a newly picked challenger (tier-weights.md §2), from
 * the same catalog prices the picker already renders — no extra fetch.
 */
export function suggestWeightFor(
  challenger: PickerValue,
  incumbent: PickerValue,
  models: readonly PickerModelInput[],
  routes: readonly PickerRouteSpec[],
  tier: Tier,
): WeightLevel {
  const rows = buildPickerRows(models, routes, tier, [incumbent, challenger]);
  const find = (v: PickerValue) => rows.find((r) => r.key === pickerKey(v));
  return suggestWeight(tokenPrice(find(challenger)), tokenPrice(find(incumbent)));
}
