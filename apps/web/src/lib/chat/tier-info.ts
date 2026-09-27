/**
 * What the composer's tier switch shows for each chat tier: the model the
 * team's admin mapped it to, and the expected price per 1k tokens. A pooled
 * tier (docs/design/tier-model-pools.md) serves several models, so its price is
 * the average over them, weighted by the pool's traffic allocation when it has
 * one; `models` carries the list.
 *
 * Prices come from the same table turn metering falls back to
 * (`priceForModel`), so the estimate and the recorded cost agree when the
 * provider reports none.
 */

import { resolveTierEntry as resolveTierEntryImpl } from '@buildd/core/model-tier-registry';
import { priceForModel } from '@buildd/core/model-prices';
import { loadTeamPools } from '@buildd/core/tier-pool-source';
import { CHAT_TIER_NAMES, type ChatTierInfo, type ChatTierName } from '@buildd/shared';

type Price = (model: string) => { input: number; output: number };

/** One model a tier may serve and its share of traffic (any positive scale). */
export interface TierModel { model: string; weight: number }

/** USD per million tokens → per 1k. */
const per1k = (perM: number) => perM / 1000;

/** `anthropic/claude-x` → `claude-x`: the price table keys native ids. */
function bare(model: string): string {
  return model.includes('/') ? model.split('/').pop()! : model;
}

/** Pure. `models` empty ⇒ just the incumbent. Non-positive weights count equally. */
export function chatTierInfo(tier: ChatTierName, incumbent: string, models: readonly TierModel[], price: Price): ChatTierInfo {
  const all = models.length > 0 ? models : [{ model: incumbent, weight: 1 }];
  const weighted = all.every(m => m.weight > 0);
  const total = weighted ? all.reduce((n, m) => n + m.weight, 0) : all.length;
  const avg = (pick: (p: { input: number; output: number }) => number) =>
    all.reduce((n, m) => n + pick(price(bare(m.model))) * (weighted ? m.weight : 1), 0) / total;
  return {
    tier,
    model: incumbent,
    models: all.map(m => m.model),
    inputPer1kUsd: per1k(avg(p => p.input)),
    outputPer1kUsd: per1k(avg(p => p.output)),
  };
}

/**
 * The models a chat tier's pool serves: its active arms, weighted by the
 * allocation. Empty when the tier has no live split pool (the incumbent only).
 */
export async function chatPoolModels(teamId: string, tier: ChatTierName): Promise<TierModel[]> {
  const pools = await loadTeamPools(teamId);
  const pool = pools.find(p => p.tier === tier && p.surface === 'chat');
  if (!pool || pool.mode !== 'split' || pool.frozen) return [];
  const arms = pool.arms.filter(a => a.status === 'active');
  if (arms.length < 2) return [];
  return arms.map(a => ({ model: a.model, weight: Number(pool.allocation[a.id] ?? 0) }));
}

export interface LoadTierDeps {
  resolveTierEntry: (tier: ChatTierName, teamId: string, workspaceId?: string | null) => Promise<{ model: string }>;
  price: Price;
  poolModels?: (teamId: string, tier: ChatTierName) => Promise<readonly TierModel[]>;
}

export async function loadChatTiers(
  scope: { teamId: string; workspaceId: string | null },
  deps: LoadTierDeps = { resolveTierEntry: resolveTierEntryImpl, price: priceForModel, poolModels: chatPoolModels },
): Promise<ChatTierInfo[]> {
  const rows = await Promise.all(CHAT_TIER_NAMES.map(async (tier) => {
    try {
      const entry = await deps.resolveTierEntry(tier, scope.teamId, scope.workspaceId);
      const pool = deps.poolModels ? await deps.poolModels(scope.teamId, tier).catch(() => []) : [];
      return chatTierInfo(tier, entry.model, pool, deps.price);
    } catch {
      return null;
    }
  }));
  return rows.filter((r): r is ChatTierInfo => r !== null);
}
