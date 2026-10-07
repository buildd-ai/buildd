/**
 * Tier model pools — the admin writes and the per-arm stats read
 * (knowledge-base: buildd/design/tier-model-pools.md §6, §9).
 *
 * Every traffic change is one SQL statement that updates the pool with a
 * compare-and-set on `allocation_version` AND appends its `tier_pool_changes`
 * row, so a change cannot land without its audit row and two admins editing
 * at once cannot both win. No `db.transaction()` (neon-http).
 *
 * P1 is manual only: an admin adds or removes arms, types shares, and pins or
 * unpins. Nothing here runs on a schedule or moves traffic on its own.
 */
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db } from './db/client';
import { experiments, tierPoolArms, tierPoolChanges, tierPools } from './db/schema';
import { INFRA_EXIT_CAUSES } from './experiment-readout';
import {
  MAX_POOL_ARMS,
  MIN_GRADED_UNITS,
  TIER_POOL_EXPERIMENT_KIND,
  agentUnitSeverity,
  chatTurnSeverity,
  summarizeArm,
  type Allocation,
  type ArmRoute,
  type ArmStats,
  type ArmUnit,
  type PoolMode,
  type PoolSurface,
} from './tier-pool';
import { backfillWeights, sharesFromWeights, type WeightLevel, type Weights } from './tier-weights';

export interface PoolRow {
  id: string;
  tier: string;
  surface: PoolSurface;
  mode: PoolMode;
  experimentId: string | null;
  allocation: Allocation;
  allocationVersion: number;
  weights: Weights;
  incumbentFloor: number;
  explorationCap: number;
  frozenAt: Date | null;
  /** `dial` mode: the cell's dial and its stored state (`./tier-dial.ts`). */
  dial: number;
  dialState: Record<string, unknown> | null;
}

export interface ArmRow {
  id: string;
  poolId: string;
  route: ArmRoute;
  model: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused' | 'removed';
  addedAt: Date;
}

export interface ChangeRow {
  id: string;
  poolId: string;
  kind: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorUserId: string | null;
  actorSystem: string | null;
  createdAt: Date;
  /** Dial changes carry `{ reason, ... }` here (tier-dial-source.ts `writeDialState`). */
  evidence?: Record<string, unknown> | null;
}

const poolColumns = {
  id: tierPools.id,
  tier: tierPools.tier,
  surface: tierPools.surface,
  mode: tierPools.mode,
  experimentId: tierPools.experimentId,
  allocation: tierPools.allocation,
  allocationVersion: tierPools.allocationVersion,
  weights: tierPools.weights,
  incumbentFloor: tierPools.incumbentFloor,
  explorationCap: tierPools.explorationCap,
  frozenAt: tierPools.frozenAt,
  dial: tierPools.dial,
  dialState: tierPools.dialState,
};

/** WHERE clause for one team pool. */
export function teamPoolScope(teamId: string, tier: string, surface: PoolSurface) {
  return and(eq(tierPools.teamId, teamId), isNull(tierPools.workspaceId), eq(tierPools.tier, tier as never), eq(tierPools.surface, surface));
}

/** WHERE clause for a pool the team owns (every write checks this). */
export function ownedPoolScope(teamId: string, poolId: string) {
  return and(eq(tierPools.id, poolId), eq(tierPools.teamId, teamId));
}

export async function loadPool(teamId: string, poolId: string): Promise<{ pool: PoolRow; arms: ArmRow[] } | null> {
  const [pool] = await db.select(poolColumns).from(tierPools).where(ownedPoolScope(teamId, poolId)).limit(1);
  if (!pool) return null;
  const arms = await db.select().from(tierPoolArms)
    .where(and(eq(tierPoolArms.poolId, poolId), ne(tierPoolArms.status, 'removed')));
  return { pool: pool as PoolRow, arms: arms as ArmRow[] };
}

/** The team pool for (tier, surface), with its live arms, or null when none exists yet. */
export async function findTeamPool(teamId: string, tier: string, surface: PoolSurface): Promise<{ pool: PoolRow; arms: ArmRow[] } | null> {
  const [pool] = await db.select(poolColumns).from(tierPools).where(teamPoolScope(teamId, tier, surface)).limit(1);
  if (!pool) return null;
  const arms = await db.select().from(tierPoolArms)
    .where(and(eq(tierPoolArms.poolId, pool.id), ne(tierPoolArms.status, 'removed')));
  return { pool: pool as PoolRow, arms: arms as ArmRow[] };
}

export async function listTeamPools(teamId: string): Promise<Array<{ pool: PoolRow; arms: ArmRow[]; lastChange: ChangeRow | null }>> {
  const pools = await db.select(poolColumns).from(tierPools)
    .where(and(eq(tierPools.teamId, teamId), isNull(tierPools.workspaceId)));
  if (pools.length === 0) return [];
  const ids = pools.map(p => p.id);
  const [arms, changes] = await Promise.all([
    db.select().from(tierPoolArms).where(and(inArray(tierPoolArms.poolId, ids), ne(tierPoolArms.status, 'removed'))),
    db.select().from(tierPoolChanges).where(inArray(tierPoolChanges.poolId, ids)).orderBy(desc(tierPoolChanges.createdAt)).limit(200),
  ]);
  return pools.map(p => ({
    pool: p as PoolRow,
    arms: (arms as ArmRow[]).filter(a => a.poolId === p.id),
    lastChange: ((changes as ChangeRow[]).find(c => c.poolId === p.id)) ?? null,
  }));
}

export async function listPoolChanges(teamId: string, poolId: string, limit = 20): Promise<ChangeRow[]> {
  const owned = await db.select({ id: tierPools.id }).from(tierPools).where(ownedPoolScope(teamId, poolId)).limit(1);
  if (owned.length === 0) return [];
  return (await db.select().from(tierPoolChanges)
    .where(eq(tierPoolChanges.poolId, poolId))
    .orderBy(desc(tierPoolChanges.createdAt))
    .limit(limit)) as ChangeRow[];
}

/**
 * The team pool for (tier, surface), created on first use with its
 * `experiments` row and its incumbent arm. Race-safe without a transaction:
 * every insert is ON CONFLICT DO NOTHING against a unique key, then re-read.
 */
export async function ensurePool(args: {
  teamId: string;
  tier: string;
  surface: PoolSurface;
  incumbent: { route: ArmRoute; model: string };
  actorUserId: string | null;
}): Promise<{ pool: PoolRow; arms: ArmRow[] }> {
  const key = `tier-pool:${args.surface}:${args.tier}`;
  await db.insert(experiments).values({
    teamId: args.teamId,
    key,
    title: `${args.tier} tier pool (${args.surface === 'agent' ? 'agent runs' : 'chat'})`,
    kind: TIER_POOL_EXPERIMENT_KIND,
    status: 'running',
    treatmentFraction: 0,
    config: { tier: args.tier, surface: args.surface },
    visibility: 'admins',
    createdBy: args.actorUserId,
    startedAt: new Date(),
  }).onConflictDoNothing();
  const [exp] = await db.select({ id: experiments.id }).from(experiments)
    .where(and(eq(experiments.teamId, args.teamId), eq(experiments.key, key))).limit(1);

  await db.insert(tierPools).values({
    teamId: args.teamId,
    workspaceId: null,
    tier: args.tier as never,
    surface: args.surface,
    mode: 'split',
    experimentId: exp?.id ?? null,
    allocation: {},
  }).onConflictDoNothing();
  const [pool] = await db.select(poolColumns).from(tierPools).where(teamPoolScope(args.teamId, args.tier, args.surface)).limit(1);
  if (!pool) throw new Error('tier pool could not be created');

  let arms = (await db.select().from(tierPoolArms)
    .where(and(eq(tierPoolArms.poolId, pool.id), ne(tierPoolArms.status, 'removed')))) as ArmRow[];
  if (!arms.some(a => a.role === 'incumbent')) {
    await db.insert(tierPoolArms).values({
      poolId: pool.id, route: args.incumbent.route, model: args.incumbent.model,
      role: 'incumbent', status: 'active', source: 'registry', addedBy: args.actorUserId,
    }).onConflictDoNothing();
    arms = (await db.select().from(tierPoolArms)
      .where(and(eq(tierPoolArms.poolId, pool.id), ne(tierPoolArms.status, 'removed')))) as ArmRow[];
  }
  const incumbent = arms.find(a => a.role === 'incumbent');
  let current = pool as PoolRow;
  if (incumbent && Object.keys(current.allocation ?? {}).length === 0) {
    // First allocation: everything on the incumbent, weight `high` (the
    // default an admin's own weight starts equal to). Audited like any other.
    const weights: Weights = { [incumbent.id]: 'high' };
    const v = await writeAllocation({
      teamId: args.teamId, poolId: pool.id, expectedVersion: current.allocationVersion,
      allocation: { [incumbent.id]: 1 }, weights, kind: 'allocation', actorUserId: args.actorUserId,
      evidence: { reason: 'pool_created' },
    });
    if (v !== null) current = { ...current, allocation: { [incumbent.id]: 1 }, weights, allocationVersion: v };
  }
  return { pool: current, arms };
}

/**
 * Compare-and-set the allocation (and optionally the mode), appending the
 * change row in the same statement. Returns the new version, or null when the
 * pool moved on (another admin wrote first) or is not this team's.
 */
export async function writeAllocation(args: {
  teamId: string;
  poolId: string;
  expectedVersion: number;
  allocation: Allocation;
  /** Split only. Omit to leave the stored weights untouched (a mode-only or arm-removal write). */
  weights?: Weights;
  mode?: PoolMode;
  kind: 'allocation' | 'mode' | 'arm_removed' | 'arm_added';
  actorUserId: string | null;
  /** e.g. `system:explore`, `system:harm-cut` — a system-initiated change (knowledge-base: buildd/design/tier-weights.md §5). */
  actorSystem?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<number | null> {
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT allocation, weights, mode, allocation_version FROM tier_pools
      WHERE id = ${args.poolId} AND team_id = ${args.teamId}
    ), u AS (
      UPDATE tier_pools
      SET allocation = ${JSON.stringify(args.allocation)}::jsonb,
          weights = COALESCE(${args.weights ? JSON.stringify(args.weights) : null}::jsonb, weights),
          allocation_version = allocation_version + 1,
          mode = COALESCE(${args.mode ?? null}::text, mode),
          updated_at = now()
      WHERE id = ${args.poolId} AND team_id = ${args.teamId} AND allocation_version = ${args.expectedVersion}
      RETURNING allocation, weights, mode, allocation_version
    ), log AS (
      INSERT INTO tier_pool_changes (pool_id, kind, before, after, evidence, actor_user_id, actor_system)
      SELECT ${args.poolId}::uuid, ${args.kind}::text,
        jsonb_build_object('allocation', prev.allocation, 'weights', prev.weights, 'mode', prev.mode, 'version', prev.allocation_version),
        jsonb_build_object('allocation', u.allocation, 'weights', u.weights, 'mode', u.mode, 'version', u.allocation_version),
        ${args.evidence ? JSON.stringify(args.evidence) : null}::jsonb,
        ${args.actorUserId}::uuid,
        ${args.actorSystem ?? null}::text
      FROM u, prev
    )
    SELECT allocation_version FROM u
  `);
  const row = (result.rows as Array<{ allocation_version: number }>)[0];
  return row ? Number(row.allocation_version) : null;
}

export type AddArmResult =
  | { ok: true; armId: string }
  | { ok: false; reason: 'full' | 'duplicate' };

/**
 * Add a challenger at the given weight, folded into the pool's weights so it
 * starts carrying traffic instead of needing a second edit
 * (knowledge-base: buildd/design/tier-weights.md §2). The four-arm cap is a conditional insert,
 * not a transaction; logging the arm add and applying the resulting
 * allocation happen in the same `writeAllocation` call right after — this
 * function is two statements, not one, the same non-transactional shape
 * `ensurePool` already uses (neon-http admits no `db.transaction()`).
 */
export async function addChallenger(args: {
  teamId: string;
  poolId: string;
  route: ArmRoute;
  model: string;
  weight: WeightLevel;
  actorUserId: string | null;
  evidence?: Record<string, unknown>;
}): Promise<AddArmResult> {
  const result = await db.execute(sql`
    INSERT INTO tier_pool_arms (pool_id, route, model, role, status, source, added_by)
    SELECT ${args.poolId}::uuid, ${args.route}::text, ${args.model}::text, 'challenger', 'active', 'admin', ${args.actorUserId}::uuid
    WHERE (SELECT count(*) FROM tier_pool_arms WHERE pool_id = ${args.poolId} AND status <> 'removed') < ${MAX_POOL_ARMS}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const row = (result.rows as Array<{ id: string }>)[0];
  if (!row) {
    const live = await db.select({ id: tierPoolArms.id, route: tierPoolArms.route, model: tierPoolArms.model })
      .from(tierPoolArms).where(and(eq(tierPoolArms.poolId, args.poolId), ne(tierPoolArms.status, 'removed')));
    return { ok: false, reason: live.some(a => a.route === args.route && a.model === args.model) ? 'duplicate' : 'full' };
  }
  const armId = row.id;

  const [poolRow] = await db.select({
    allocationVersion: tierPools.allocationVersion, weights: tierPools.weights, allocation: tierPools.allocation,
  }).from(tierPools).where(eq(tierPools.id, args.poolId));
  if (poolRow) {
    const arms = (await db.select({ id: tierPoolArms.id, role: tierPoolArms.role, addedAt: tierPoolArms.addedAt })
      .from(tierPoolArms).where(and(eq(tierPoolArms.poolId, args.poolId), ne(tierPoolArms.status, 'removed')))) as
      Array<{ id: string; role: 'incumbent' | 'challenger'; addedAt: Date }>;
    const armOrder = arms
      .slice()
      .sort((a, b) => (a.role === 'incumbent' ? -1 : b.role === 'incumbent' ? 1 : a.addedAt.getTime() - b.addedAt.getTime()))
      .map(a => a.id);
    const allocation = (poolRow.allocation ?? {}) as Allocation;
    const backfilled = backfillWeights(
      (poolRow.weights ?? {}) as Weights,
      arms.map(a => ({ id: a.id, share: allocation[a.id] ?? (a.role === 'incumbent' ? 1 : 0) })),
    );
    const newWeights: Weights = { ...backfilled, [armId]: args.weight };
    const check = sharesFromWeights(newWeights, armOrder);
    if (check.ok) {
      await writeAllocation({
        teamId: args.teamId, poolId: args.poolId, expectedVersion: poolRow.allocationVersion,
        allocation: check.allocation, weights: newWeights, kind: 'arm_added', actorUserId: args.actorUserId,
        evidence: { armId, route: args.route, model: args.model, weight: args.weight, ...args.evidence },
      });
    }
  }
  return { ok: true, armId };
}

/**
 * Remove a challenger and hand its share to the incumbent, in one statement.
 * The pool's version compare-and-set runs first and the arm flips only if it
 * succeeded (`EXISTS (SELECT 1 FROM u)`): the pool row lock orders concurrent
 * admin writes, so a stale remove changes nothing rather than leaving a
 * removed arm that still holds a share and has no audit row.
 */
export async function removeChallenger(args: {
  teamId: string;
  poolId: string;
  armId: string;
  expectedVersion: number;
  allocation: Allocation;
  actorUserId: string | null;
}): Promise<number | null> {
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT allocation, mode, allocation_version FROM tier_pools WHERE id = ${args.poolId} AND team_id = ${args.teamId}
    ), u AS (
      UPDATE tier_pools
      SET allocation = ${JSON.stringify(args.allocation)}::jsonb,
          weights = weights - ${args.armId}::text,
          allocation_version = allocation_version + 1, updated_at = now()
      WHERE id = ${args.poolId} AND team_id = ${args.teamId} AND allocation_version = ${args.expectedVersion}
        AND EXISTS (
          SELECT 1 FROM tier_pool_arms
          WHERE id = ${args.armId} AND pool_id = ${args.poolId} AND role = 'challenger' AND status <> 'removed'
        )
      RETURNING allocation, mode, allocation_version
    ), a AS (
      UPDATE tier_pool_arms SET status = 'removed', removed_at = now()
      WHERE id = ${args.armId} AND pool_id = ${args.poolId} AND role = 'challenger' AND status <> 'removed'
        AND EXISTS (SELECT 1 FROM u)
      RETURNING id, route, model
    ), log AS (
      INSERT INTO tier_pool_changes (pool_id, kind, before, after, actor_user_id)
      SELECT ${args.poolId}::uuid, 'arm_removed',
        jsonb_build_object('allocation', prev.allocation, 'version', prev.allocation_version, 'armId', a.id, 'route', a.route, 'model', a.model),
        jsonb_build_object('allocation', u.allocation, 'version', u.allocation_version),
        ${args.actorUserId}::uuid
      FROM a, u, prev
    )
    SELECT allocation_version FROM u
  `);
  const row = (result.rows as Array<{ allocation_version: number }>)[0];
  return row ? Number(row.allocation_version) : null;
}

// ── Stats ───────────────────────────────────────────────────────────────────

/** Default look-back for the tier screen's numbers. */
export const STATS_WINDOW_DAYS = 30;

interface AgentStatRow { arm_id: string; outcome: string | null; exit_cause: string | null; total_cost_usd: string | null; duration_ms: number | null }
interface ChatStatRow { arm_id: string; usage: { costUsd?: number | null; latencyMs?: number } | null; signal: string | null; reason: string | null }

const AGENT_UNITS_SELECT = sql`
  SELECT a.arm_id, o.outcome, o.exit_cause, o.total_cost_usd, o.duration_ms
  FROM experiment_assignments a`;
const AGENT_OUTCOME_JOIN = sql`
  LEFT JOIN LATERAL (
    SELECT outcome, exit_cause, total_cost_usd, duration_ms FROM task_outcomes
    WHERE task_id = a.task_id ORDER BY created_at DESC LIMIT 1
  ) o ON true`;
const CHAT_UNITS_SELECT = sql`
  SELECT a.arm_id, m.usage, f.signal, f.reason
  FROM experiment_assignments a`;
const CHAT_OUTCOME_JOIN = sql`
  JOIN conversation_messages m ON m.id = a.message_id
  LEFT JOIN user_feedback f ON f.entity_type = 'conversation_message' AND f.entity_id = a.message_id::text`;

/**
 * One surface's graded units, for the pools `poolJoin` selects and the
 * assignments `where` keeps. Agent units come from the task's latest outcome;
 * chat units from the turn's usage and thumbs. A chat assignment has no task,
 * so the two can never share a query.
 */
function surfaceUnitsQuery(surface: PoolSurface, poolJoin: SQL, where: SQL) {
  return surface === 'agent'
    ? sql`${AGENT_UNITS_SELECT} ${poolJoin} ${AGENT_OUTCOME_JOIN}
      WHERE a.arm_id IS NOT NULL AND a.task_id IS NOT NULL AND ${where}`
    : sql`${CHAT_UNITS_SELECT} ${poolJoin} ${CHAT_OUTCOME_JOIN}
      WHERE a.arm_id IS NOT NULL AND a.message_id IS NOT NULL AND ${where}`;
}

function pushUnits(surface: PoolSurface, rows: unknown[], into: Map<string, ArmUnit[]>): void {
  const push = (armId: string, u: ArmUnit) => { const l = into.get(armId) ?? []; l.push(u); into.set(armId, l); };
  if (surface === 'agent') {
    for (const r of rows as AgentStatRow[]) {
      const cost = r.total_cost_usd != null ? Number(r.total_cost_usd) : null;
      push(r.arm_id, {
        severity: agentUnitSeverity(r.outcome ? { outcome: r.outcome, exitCause: r.exit_cause } : null, INFRA_EXIT_CAUSES),
        costUsd: cost != null && Number.isFinite(cost) ? cost : null,
        latencyMs: r.duration_ms ?? null,
      });
    }
    return;
  }
  for (const r of rows as ChatStatRow[]) {
    push(r.arm_id, {
      severity: chatTurnSeverity(r.signal, r.reason),
      costUsd: typeof r.usage?.costUsd === 'number' ? r.usage.costUsd : null,
      latencyMs: typeof r.usage?.latencyMs === 'number' ? r.usage.latencyMs : null,
    });
  }
}

/**
 * Per-arm stats for every pool of a team, from outcome data that already
 * exists: `task_outcomes` for agent runs (latest outcome per task), and
 * `conversation_messages.usage` plus thumbs in `user_feedback` for chat.
 * Reads labels and numbers only.
 */
export async function loadArmStats(teamId: string, now = new Date()): Promise<Map<string, ArmStats>> {
  const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000).toISOString();
  const window = sql`a.assigned_at >= ${since}::timestamptz`;
  const poolJoin = (surface: PoolSurface) =>
    sql`JOIN tier_pools p ON p.experiment_id = a.experiment_id AND p.team_id = ${teamId} AND p.surface = ${surface}`;
  const [agent, chat] = await Promise.all([
    db.execute(surfaceUnitsQuery('agent', poolJoin('agent'), window)),
    db.execute(surfaceUnitsQuery('chat', poolJoin('chat'), window)),
  ]);
  const units = new Map<string, ArmUnit[]>();
  pushUnits('agent', agent.rows, units);
  pushUnits('chat', chat.rows, units);
  const out = new Map<string, ArmStats>();
  for (const [armId, list] of units) out.set(armId, summarizeArm(list));
  return out;
}

// ── Readout ─────────────────────────────────────────────────────────────────

export interface TierPoolReadoutArm extends ArmStats {
  armId: string;
  route: string;
  model: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused' | 'removed';
}

export interface TierPoolReadout {
  kind: typeof TIER_POOL_EXPERIMENT_KIND;
  surface: PoolSurface | null;
  /** Graded units each live arm needs before its numbers mean much (design §5e). */
  minGradedPerArm: number | null;
  /**
   * `no_pool`: no pool points at this experiment. `insufficient_n`: a live arm
   * is under `minGradedPerArm`. `ready`: every live arm has reached it. Never a
   * significance verdict: pools compare up to four arms on graded severity,
   * not two arms on clean completion.
   */
  verdict: 'no_pool' | 'insufficient_n' | 'ready';
  totals: { units: number; graded: number };
  arms: TierPoolReadoutArm[];
}

interface ReadoutArmRow { id: string; route: string; model: string; role: 'incumbent' | 'challenger'; status: 'active' | 'paused' | 'removed'; surface: PoolSurface }

/**
 * The readout for a tier-pool experiment, from its own assignment rows under
 * one policy version: chat turns graded by thumbs, agent tasks by their latest
 * outcome. The two-arm task readout joins on tasks, which a chat assignment
 * does not have, so it would report every chat pool as all zeros.
 */
export async function runTierPoolReadout(experiment: { id: string; policyVersion: number }): Promise<TierPoolReadout> {
  const armsRes = await db.execute(sql`
    SELECT a.id, a.route, a.model, a.role, a.status, p.surface
    FROM tier_pool_arms a
    JOIN tier_pools p ON p.id = a.pool_id
    WHERE p.experiment_id = ${experiment.id}
    ORDER BY (a.role = 'incumbent') DESC, a.added_at, a.id
  `);
  const arms = armsRes.rows as unknown as ReadoutArmRow[];
  if (arms.length === 0) {
    return { kind: TIER_POOL_EXPERIMENT_KIND, surface: null, minGradedPerArm: null, verdict: 'no_pool', totals: { units: 0, graded: 0 }, arms: [] };
  }
  const surface = arms[0].surface;
  const res = await db.execute(surfaceUnitsQuery(
    surface,
    sql`JOIN tier_pools p ON p.experiment_id = a.experiment_id`,
    sql`p.experiment_id = ${experiment.id} AND a.policy_version = ${experiment.policyVersion}`,
  ));
  const units = new Map<string, ArmUnit[]>();
  pushUnits(surface, res.rows, units);
  const minGradedPerArm = MIN_GRADED_UNITS[surface];
  const out = arms.map(a => ({
    armId: a.id, route: a.route, model: a.model, role: a.role, status: a.status,
    ...summarizeArm(units.get(a.id) ?? []),
  }));
  const live = out.filter(a => a.status !== 'removed');
  return {
    kind: TIER_POOL_EXPERIMENT_KIND,
    surface,
    minGradedPerArm,
    verdict: live.length > 0 && live.every(a => a.graded >= minGradedPerArm) ? 'ready' : 'insufficient_n',
    totals: { units: out.reduce((s, a) => s + a.units, 0), graded: out.reduce((s, a) => s + a.graded, 0) },
    arms: out,
  };
}
