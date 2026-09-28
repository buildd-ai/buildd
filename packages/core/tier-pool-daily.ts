/**
 * The daily plan for one tier pool (docs/design/tier-weights.md §3c, §4).
 *
 * Pure: the pool, its evidence, the catalog and the team's cached rankings
 * come in; a list of actions comes out. `./tier-pool-daily-source.ts` loads
 * the inputs and executes the actions, each through a compare-and-set write
 * with its own `tier_pool_changes` row.
 *
 * Split pools accept only the harm cut and expiry. Explore pools run the full
 * step with popularity, succession and expiry wired in as priors and caps.
 */
import { findSuccessor, findCatalogEntry, decayMultiplier } from './model-succession';
import type { CatalogEntry, CatalogTier } from './model-catalog';
import { popularityFor, type RankingsView, type ViewScores } from './openrouter-rankings';
import {
  EMPTY_EVIDENCE,
  EXPLORE_POLICY_TAG,
  exploreStep,
  popularityMean,
  splitGuardrails,
  type ArmEvidence,
  type ExploreArmInput,
  type ExploreStepResult,
} from './tier-explore';
import { MAX_POOL_ARMS, type Allocation, type ArmRoute, type PoolSurface } from './tier-pool';
import type { Weights } from './tier-weights';

/** An explore arm whose model expires within this many days is capped to 0. */
export const EXPIRY_HORIZON_DAYS = 14;

const DAY_MS = 86_400_000;

export interface DailyPoolArm {
  id: string;
  route: ArmRoute;
  model: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused' | 'removed';
  source: 'admin' | 'auto_challenger' | 'registry';
  addedAt: Date;
  /** Numbers only; `successionHold` freezes a decay multiplier. */
  stats: Record<string, unknown>;
}

export interface DailyPool {
  id: string;
  teamId: string;
  tier: CatalogTier;
  surface: PoolSurface;
  mode: 'split' | 'explore';
  policyVersion: number;
  allocation: Allocation;
  allocationVersion: number;
  /** `split` only; a harm cut or expiry also flips the arm's level to `off` (tier-weights.md §1, §4b). */
  weights: Weights;
  autoChallenger: boolean;
  /** Live arms in `armOrder`. */
  arms: DailyPoolArm[];
}

export interface SuccessionHold {
  successorArmId: string;
  multiplier: number;
}

export type DailyAction =
  | { type: 'allocate'; allocation: Allocation; actorSystem: string; evidence: Record<string, unknown>; weights?: Weights }
  | { type: 'hold'; armId: string; hold: SuccessionHold }
  | { type: 'suggest'; key: string; actorSystem: string; evidence: Record<string, unknown> }
  | { type: 'add_challenger'; route: ArmRoute; model: string; evidence: Record<string, unknown> };

export interface DailyPlan {
  actions: DailyAction[];
  step: ExploreStepResult | null;
}

function readHold(stats: Record<string, unknown>): SuccessionHold | null {
  const h = stats?.successionHold as Partial<SuccessionHold> | undefined;
  if (!h || typeof h.successorArmId !== 'string' || typeof h.multiplier !== 'number') return null;
  return { successorArmId: h.successorArmId, multiplier: h.multiplier };
}

export function planPoolDay(args: {
  pool: DailyPool;
  evidence: ReadonlyMap<string, ArmEvidence>;
  catalog: readonly CatalogEntry[];
  rankings: Partial<Record<RankingsView, ViewScores | null>>;
  now: Date;
  gradingHealthy?: boolean;
}): DailyPlan {
  const { pool, catalog, now } = args;
  const date = now.toISOString().slice(0, 10);
  const nowS = Math.floor(now.getTime() / 1000);
  const live = pool.arms.filter(a => a.status === 'active');
  const actions: DailyAction[] = [];
  const catalogId = (model: string) => findCatalogEntry(catalog, model)?.id ?? null;

  const popularity = (model: string) => {
    if (pool.mode !== 'explore') return null;
    return popularityFor({ model, surface: pool.surface, views: args.rankings, catalog, now });
  };

  // Succession (§4b).
  const succession = new Map<string, ExploreArmInput['succession']>();
  const hasAutoChallenger = live.some(a => a.source === 'auto_challenger');
  let adding = false;
  for (const a of live) {
    const s = findSuccessor({ arm: a, tier: pool.tier, catalog, now: nowS, popularity: id => popularity(id)?.pctile ?? null });
    if (!s) continue;
    const inPool = live.find(x => x.id !== a.id && x.route === a.route && catalogId(x.model) === s.id);
    const base = { signal: 'succession', armId: a.id, model: a.model, successor: s.id, route: a.route };
    if (pool.mode === 'split' || !inPool) {
      const canAdd = pool.mode === 'explore' && pool.autoChallenger && !inPool && !hasAutoChallenger && !adding
        && pool.arms.length < MAX_POOL_ARMS;
      if (canAdd) {
        adding = true;
        actions.push({ type: 'add_challenger', route: a.route, model: s.id, evidence: { ...base, policy: EXPLORE_POLICY_TAG } });
      } else {
        actions.push({
          type: 'suggest',
          key: `succession:${a.id}:${s.id}`,
          actorSystem: 'system:succession',
          evidence: { ...base, action: inPool ? 'review' : 'add' },
        });
      }
      continue;
    }
    const hold = readHold(pool.arms.find(x => x.id === a.id)?.stats ?? {});
    const held = hold?.successorArmId === inPool.id;
    const days = Math.floor((now.getTime() - inPool.addedAt.getTime()) / DAY_MS);
    succession.set(a.id, { successorArmId: inPool.id, multiplier: held ? hold!.multiplier : decayMultiplier(days), held });
  }

  // Expiry.
  const expiresAt = (model: string) => findCatalogEntry(catalog, model)?.expiresAt ?? null;

  if (pool.mode === 'split') {
    const g = splitGuardrails({
      poolId: pool.id, surface: pool.surface, date, policyVersion: pool.policyVersion, current: pool.allocation,
      arms: live.map(a => {
        const exp = expiresAt(a.model);
        return { id: a.id, role: a.role, evidence: args.evidence.get(a.id) ?? EMPTY_EVIDENCE, expired: exp != null && exp <= nowS };
      }),
    });
    if (g) {
      // A harm cut or an expiry also takes the arm's weight to `off` (§1,
      // §4b): the admin's own control must show what actually happened,
      // not the level from before the cut.
      const weights: Weights = { ...pool.weights };
      for (const armId of [...g.cut, ...g.expired]) weights[armId] = 'off';
      actions.push({ type: 'allocate', allocation: g.allocation, actorSystem: g.actorSystem, evidence: g.evidence, weights });
    }
    return { actions, step: null };
  }

  const arms: ExploreArmInput[] = live.map(a => {
    const pop = popularity(a.model);
    const exp = expiresAt(a.model);
    return {
      id: a.id,
      role: a.role,
      model: a.model,
      ageDays: Math.floor((now.getTime() - a.addedAt.getTime()) / DAY_MS),
      evidence: args.evidence.get(a.id) ?? EMPTY_EVIDENCE,
      popularity: pop ? { m: popularityMean(pop.pctile), views: pop.views, asOf: pop.asOf } : null,
      succession: succession.get(a.id) ?? null,
      expiring: exp != null && exp - nowS <= EXPIRY_HORIZON_DAYS * 86_400 ? { expiresAt: new Date(exp * 1000).toISOString() } : null,
    };
  });
  const step = exploreStep({
    poolId: pool.id, surface: pool.surface, date, policyVersion: pool.policyVersion,
    current: pool.allocation, arms, gradingHealthy: args.gradingHealthy ?? true,
  });
  if (step.write) {
    actions.push({ type: 'allocate', allocation: step.allocation, actorSystem: step.actorSystem, evidence: step.evidence as unknown as Record<string, unknown> });
  }
  for (const [armId, multiplier] of Object.entries(step.holds)) {
    const s = succession.get(armId)!;
    actions.push({ type: 'hold', armId, hold: { successorArmId: s.successorArmId, multiplier } });
  }
  for (const s of step.suggestions) {
    actions.push({ type: 'suggest', key: s.key, actorSystem: 'system:succession', evidence: { signal: s.signal, action: s.action, armId: s.armId } });
  }
  return { actions, step };
}
