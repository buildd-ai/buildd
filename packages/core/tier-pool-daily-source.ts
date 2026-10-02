/**
 * The stores half of the daily tier pool step (knowledge-base: buildd/design/tier-weights.md §3c,
 * §4, §5). Called hourly by `/api/cron/tier-pools`.
 *
 * - After 03:00 UTC, each team with an explore pool refreshes its OpenRouter
 *   rankings once (on its own key).
 * - After 06:00 UTC, each unfrozen split or explore pool is planned and its
 *   actions executed, once per UTC day. There is no per-team timezone yet, so
 *   the team's local 06:00 in the design is 06:00 UTC here.
 *
 * Once per day is a marker in `system_cache`, written after the pool's step,
 * so a second run the same day writes nothing even when new grades arrived in
 * between. Every allocation change goes through `writeAllocation` (compare-and-
 * set plus change row in one statement). No `db.transaction()` (neon-http).
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from './db/client';
import { experiments, systemCache, tierPoolArms, tierPools } from './db/schema';
import { INFRA_EXIT_CAUSES } from './experiment-readout';
import { getCachedOpenRouterCatalog } from './model-catalog-cache';
import type { CatalogEntry, CatalogTier } from './model-catalog';
import { loadTeamRankings, refreshTeamRankings, type RankingsRefresh } from './openrouter-rankings-source';
import { utcDay } from './openrouter-rankings';
import { aggregateEvidence, type ArmEvidence, type ExploreStepResult, type GradedUnit } from './tier-explore';
import { MAX_POOL_ARMS, agentUnitSeverity, chatTurnSeverity, type Allocation } from './tier-pool';
import { writeAllocation } from './tier-pool-admin';
import { planPoolDay, type DailyAction, type DailyPool, type DailyPoolArm } from './tier-pool-daily';
import { invalidateTierPoolCache, orderArms } from './tier-pool-source';
import type { Weights } from './tier-weights';

export const TIER_POOLS_JOB = 'tier-pools';
export const ALLOCATE_AFTER_UTC_HOUR = 6;
/** The incumbent's prior is its last 30 days on the pool (pools §3). */
export const INCUMBENT_PRIOR_DAYS = 30;

const DAY_MS = 86_400_000;

export function stepMarkerKey(poolId: string): string {
  return `tier-pool-step:v1:${poolId}`;
}

export async function loadDailyPools(): Promise<DailyPool[]> {
  const rows = await db.select({
    id: tierPools.id,
    teamId: tierPools.teamId,
    tier: tierPools.tier,
    surface: tierPools.surface,
    mode: tierPools.mode,
    allocation: tierPools.allocation,
    allocationVersion: tierPools.allocationVersion,
    weights: tierPools.weights,
    autoChallenger: tierPools.autoChallenger,
    policyVersion: experiments.policyVersion,
  })
    .from(tierPools)
    .innerJoin(experiments, eq(experiments.id, tierPools.experimentId))
    .where(and(
      isNull(tierPools.workspaceId),
      isNull(tierPools.frozenAt),
      isNotNull(tierPools.experimentId),
      inArray(tierPools.mode, ['split', 'explore']),
    ));
  if (rows.length === 0) return [];
  const arms = await db.select({
    id: tierPoolArms.id,
    poolId: tierPoolArms.poolId,
    route: tierPoolArms.route,
    model: tierPoolArms.model,
    role: tierPoolArms.role,
    status: tierPoolArms.status,
    source: tierPoolArms.source,
    addedAt: tierPoolArms.addedAt,
    stats: tierPoolArms.stats,
  }).from(tierPoolArms).where(and(inArray(tierPoolArms.poolId, rows.map(r => r.id)), ne(tierPoolArms.status, 'removed')));
  return rows.map(r => ({
    id: r.id,
    teamId: r.teamId,
    tier: r.tier as CatalogTier,
    surface: r.surface,
    mode: r.mode as 'split' | 'explore',
    policyVersion: r.policyVersion ?? 1,
    allocation: (r.allocation ?? {}) as Allocation,
    allocationVersion: r.allocationVersion,
    weights: (r.weights ?? {}) as Weights,
    autoChallenger: r.autoChallenger,
    arms: orderArms(arms.filter(a => a.poolId === r.id).map(a => ({
      ...a, addedAt: new Date(a.addedAt), stats: (a.stats ?? {}) as Record<string, unknown>,
    }))) as DailyPoolArm[],
  }));
}

interface AgentUnitRow { arm_id: string; unit_id: string | null; assigned_at: string | Date; outcome: string | null; exit_cause: string | null }
interface ChatUnitRow { arm_id: string; conversation_id: string | null; user_id: string | null; assigned_at: string | Date; signal: string | null; reason: string | null }

/**
 * Per-arm evidence under the pool's current policy version, in assignment
 * order: challengers since they joined (cumulative), the incumbent over its
 * last 30 days.
 */
export async function loadPoolEvidence(
  pool: Pick<DailyPool, 'id' | 'surface'> & { arms: ReadonlyArray<Pick<DailyPoolArm, 'id' | 'role' | 'addedAt'>> },
  now: Date,
): Promise<Map<string, ArmEvidence>> {
  const armIds = pool.arms.map(a => a.id);
  const out = new Map<string, ArmEvidence>();
  if (armIds.length === 0) return out;
  const idList = sql.join(armIds.map(id => sql`${id}::uuid`), sql`, `);
  const units = new Map<string, Array<GradedUnit & { at: number }>>();
  const push = (armId: string, u: GradedUnit & { at: number }) => { const l = units.get(armId) ?? []; l.push(u); units.set(armId, l); };

  if (pool.surface === 'agent') {
    const res = await db.execute(sql`
      SELECT a.arm_id, a.unit_id, a.assigned_at, o.outcome, o.exit_cause
      FROM experiment_assignments a
      JOIN tier_pools p ON p.experiment_id = a.experiment_id AND p.id = ${pool.id}
      JOIN experiments e ON e.id = a.experiment_id AND a.policy_version = e.policy_version
      LEFT JOIN LATERAL (
        SELECT outcome, exit_cause FROM task_outcomes WHERE task_id = a.task_id ORDER BY created_at DESC LIMIT 1
      ) o ON true
      WHERE a.arm_id IN (${idList}) AND a.task_id IS NOT NULL
      ORDER BY a.assigned_at
    `);
    for (const r of res.rows as unknown as AgentUnitRow[]) {
      push(r.arm_id, {
        severity: agentUnitSeverity(r.outcome ? { outcome: r.outcome, exitCause: r.exit_cause } : null, INFRA_EXIT_CAUSES),
        unitId: r.unit_id, conversationId: null, userId: null, at: new Date(r.assigned_at).getTime(),
      });
    }
  } else {
    const res = await db.execute(sql`
      SELECT a.arm_id, a.conversation_id, c.created_by_user_id AS user_id, a.assigned_at, f.signal, f.reason
      FROM experiment_assignments a
      JOIN tier_pools p ON p.experiment_id = a.experiment_id AND p.id = ${pool.id}
      JOIN experiments e ON e.id = a.experiment_id AND a.policy_version = e.policy_version
      LEFT JOIN conversations c ON c.id = a.conversation_id
      LEFT JOIN user_feedback f ON f.entity_type = 'conversation_message' AND f.entity_id = a.message_id::text
      WHERE a.arm_id IN (${idList}) AND a.message_id IS NOT NULL
      ORDER BY a.assigned_at
    `);
    for (const r of res.rows as unknown as ChatUnitRow[]) {
      push(r.arm_id, {
        severity: chatTurnSeverity(r.signal, r.reason),
        unitId: null, conversationId: r.conversation_id, userId: r.user_id, at: new Date(r.assigned_at).getTime(),
      });
    }
  }

  const incumbentSince = now.getTime() - INCUMBENT_PRIOR_DAYS * DAY_MS;
  for (const arm of pool.arms) {
    const since = arm.role === 'incumbent' ? incumbentSince : arm.addedAt.getTime();
    out.set(arm.id, aggregateEvidence((units.get(arm.id) ?? []).filter(u => u.at >= since)));
  }
  return out;
}

async function readMarker(poolId: string): Promise<string | null> {
  const [row] = await db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, stepMarkerKey(poolId))).limit(1);
  return (row?.value as { date?: string } | undefined)?.date ?? null;
}

async function writeMarker(poolId: string, date: string, now: Date): Promise<void> {
  const value = { date };
  const expiresAt = new Date(now.getTime() + 2 * DAY_MS);
  await db.insert(systemCache).values({ key: stepMarkerKey(poolId), value, updatedAt: now, expiresAt })
    .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt: now, expiresAt } });
}

/** A suggestion row, written once per key (a dismissed one stays dismissed). */
export async function writeSuggestion(poolId: string, key: string, actorSystem: string, evidence: Record<string, unknown>): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO tier_pool_changes (pool_id, kind, evidence, actor_system)
    SELECT ${poolId}::uuid, 'suggestion', ${JSON.stringify({ ...evidence, key })}::jsonb, ${actorSystem}::text
    WHERE NOT EXISTS (
      SELECT 1 FROM tier_pool_changes
      WHERE pool_id = ${poolId} AND kind IN ('suggestion', 'suggestion_dismissed') AND evidence->>'key' = ${key}
    )
    RETURNING id
  `);
  return (res.rows as unknown[]).length > 0;
}

/** The P3 auto-challenger: a successor added at 0, which the step then sets to the learning share. */
export async function addAutoChallenger(poolId: string, route: string, model: string, evidence: Record<string, unknown>): Promise<boolean> {
  const res = await db.execute(sql`
    WITH ins AS (
      INSERT INTO tier_pool_arms (pool_id, route, model, role, status, source)
      SELECT ${poolId}::uuid, ${route}::text, ${model}::text, 'challenger', 'active', 'auto_challenger'
      WHERE (SELECT count(*) FROM tier_pool_arms WHERE pool_id = ${poolId} AND status <> 'removed') < ${MAX_POOL_ARMS}
      ON CONFLICT DO NOTHING
      RETURNING id, route, model
    ), log AS (
      INSERT INTO tier_pool_changes (pool_id, kind, after, evidence, actor_system)
      SELECT ${poolId}::uuid, 'arm_added', jsonb_build_object('armId', id, 'route', route, 'model', model),
        ${JSON.stringify(evidence)}::jsonb, 'system:succession'
      FROM ins
    )
    SELECT id FROM ins
  `);
  return (res.rows as unknown[]).length > 0;
}

async function writeHold(armId: string, hold: { successorArmId: string; multiplier: number }): Promise<void> {
  await db.execute(sql`
    UPDATE tier_pool_arms SET stats = stats || jsonb_build_object('successionHold', ${JSON.stringify(hold)}::jsonb)
    WHERE id = ${armId}
  `);
}

/**
 * The numbers the step judged each arm on, as its `tier_pool_arms.stats`
 * snapshot (design tier-model-pools.md §8): evidence always, and the explore
 * posterior when the step ran one. Popularity priors are left out (§4a
 * licence), as they are from the change log. Merged with `||`, so a
 * `successionHold` already on the row survives.
 */
export function armStatsSnapshot(evidence: ArmEvidence, step: ExploreStepResult | null, armId: string, now: Date): Record<string, unknown> {
  const e = step?.evidence.arms[armId];
  return {
    graded: evidence.graded,
    successes: evidence.successes,
    failures: evidence.failures,
    earlyCritical: evidence.earlyCritical,
    spread: evidence.spread,
    ...(e ? { stage: e.stage, alpha: e.alpha, beta: e.beta, pBest: e.pBest } : {}),
    updatedAt: now.toISOString(),
  };
}

async function writeArmStats(armId: string, stats: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE tier_pool_arms SET stats = stats || ${JSON.stringify(stats)}::jsonb
    WHERE id = ${armId}
  `);
}

export interface PoolDayOutcome {
  poolId: string;
  written: boolean;
  actorSystem: string | null;
  suggestions: number;
  added: number;
  stale: boolean;
}

async function execute(pool: DailyPool, actions: DailyAction[], out: PoolDayOutcome): Promise<void> {
  for (const a of actions) {
    if (a.type === 'allocate') {
      const v = await writeAllocation({
        teamId: pool.teamId, poolId: pool.id, expectedVersion: pool.allocationVersion,
        allocation: a.allocation, weights: a.weights, kind: 'allocation', actorUserId: null, actorSystem: a.actorSystem, evidence: a.evidence,
      });
      if (v === null) out.stale = true;
      else { out.written = true; out.actorSystem = a.actorSystem; }
    } else if (a.type === 'hold') {
      await writeHold(a.armId, a.hold);
    } else if (a.type === 'suggest') {
      if (await writeSuggestion(pool.id, a.key, a.actorSystem, a.evidence)) out.suggestions += 1;
    }
  }
}

/** Plan and execute one pool's day. Re-plans once after adding an auto-challenger. */
export async function runPoolDay(pool: DailyPool, ctx: {
  catalog: readonly CatalogEntry[];
  rankings: Awaited<ReturnType<typeof loadTeamRankings>>;
  now: Date;
  reload: () => Promise<DailyPool | null>;
}): Promise<PoolDayOutcome> {
  const out: PoolDayOutcome = { poolId: pool.id, written: false, actorSystem: null, suggestions: 0, added: 0, stale: false };
  let current = pool;
  let evidence = await loadPoolEvidence(current, ctx.now);
  let plan = planPoolDay({ pool: current, evidence, catalog: ctx.catalog, rankings: ctx.rankings, now: ctx.now });
  const adds = plan.actions.filter((a): a is Extract<DailyAction, { type: 'add_challenger' }> => a.type === 'add_challenger');
  if (adds.length > 0) {
    for (const a of adds) if (await addAutoChallenger(current.id, a.route, a.model, a.evidence)) out.added += 1;
    const next = out.added > 0 ? await ctx.reload() : null;
    if (next) {
      current = next;
      evidence = await loadPoolEvidence(current, ctx.now);
      plan = planPoolDay({ pool: current, evidence, catalog: ctx.catalog, rankings: ctx.rankings, now: ctx.now });
    }
  }
  await execute(current, plan.actions.filter(a => a.type !== 'add_challenger'), out);
  // Stats describe the evidence the step read, so they are written whether or
  // not the allocation moved — a split pool with no harm cut moves nothing.
  for (const arm of current.arms) {
    const e = evidence.get(arm.id);
    if (e) await writeArmStats(arm.id, armStatsSnapshot(e, plan.step, arm.id, ctx.now));
  }
  return out;
}

export interface TierPoolsDailySummary {
  pools: number;
  stepped: number;
  written: number;
  suggestions: number;
  added: number;
  stale: number;
  errors: number;
  rankings: { teams: number; fetched: number; noKey: number; failedViews: number; unmapped: number };
  changes: Array<{ poolId: string; actorSystem: string | null }>;
}

export async function runTierPoolsDaily(args: { now: Date; fetchImpl?: typeof fetch }): Promise<TierPoolsDailySummary> {
  const now = args.now;
  const today = utcDay(now);
  const summary: TierPoolsDailySummary = {
    pools: 0, stepped: 0, written: 0, suggestions: 0, added: 0, stale: 0, errors: 0,
    rankings: { teams: 0, fetched: 0, noKey: 0, failedViews: 0, unmapped: 0 },
    changes: [],
  };
  const pools = await loadDailyPools();
  summary.pools = pools.length;
  if (pools.length === 0) return summary;
  const catalog = await getCachedOpenRouterCatalog();

  // Rankings: only teams with an explore pool, on their own key.
  const exploreTeams = [...new Set(pools.filter(p => p.mode === 'explore').map(p => p.teamId))];
  if (catalog.length > 0) {
    for (const teamId of exploreTeams) {
      try {
        const r: RankingsRefresh = await refreshTeamRankings({ teamId, catalog, now, fetchImpl: args.fetchImpl });
        if (r.status === 'not_due') continue;
        summary.rankings.teams += 1;
        if (r.status === 'no_key') summary.rankings.noKey += 1;
        if (r.written.length > 0) summary.rankings.fetched += 1;
        summary.rankings.failedViews += r.failed.length;
        summary.rankings.unmapped += r.unmapped;
      } catch (err) {
        summary.errors += 1;
        console.error('[tier-pools] rankings refresh failed:', err);
      }
    }
  }

  if (now.getUTCHours() < ALLOCATE_AFTER_UTC_HOUR) return summary;

  const rankingsByTeam = new Map<string, Awaited<ReturnType<typeof loadTeamRankings>>>();
  const touched = new Set<string>();
  for (const pool of pools) {
    try {
      if ((await readMarker(pool.id)) === today) continue;
      let rankings = {};
      if (pool.mode === 'explore') {
        rankings = rankingsByTeam.get(pool.teamId) ?? await loadTeamRankings(pool.teamId);
        rankingsByTeam.set(pool.teamId, rankings);
      }
      const out = await runPoolDay(pool, {
        catalog, rankings, now,
        reload: async () => (await loadDailyPools()).find(p => p.id === pool.id) ?? null,
      });
      // A stale write (an admin changed the pool meanwhile) retries next hour.
      if (!out.stale) await writeMarker(pool.id, today, now);
      summary.stepped += 1;
      summary.suggestions += out.suggestions;
      summary.added += out.added;
      if (out.stale) summary.stale += 1;
      if (out.written) {
        summary.written += 1;
        summary.changes.push({ poolId: pool.id, actorSystem: out.actorSystem });
      }
      if (out.written || out.added) touched.add(pool.teamId);
    } catch (err) {
      summary.errors += 1;
      console.error(`[tier-pools] step failed for pool ${pool.id}:`, err);
    }
  }
  for (const teamId of touched) invalidateTierPoolCache(teamId);
  return summary;
}
