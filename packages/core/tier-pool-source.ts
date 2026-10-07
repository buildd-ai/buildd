/**
 * Tier model pools — the stores half of the draw (knowledge-base: buildd/design/tier-model-pools.md).
 *
 * Called from the claim route (agent runs) and from chat model resolution
 * (chat turns). The decisions live in `./tier-pool.ts`; this file loads the
 * pool, reads prior assignments, and writes the assignment row.
 *
 * **Nothing here may fail a claim or a turn.** Every entry point catches,
 * logs ids only, and returns null, which means "serve the incumbent as
 * today". With no `tier_pools` row for a tier, every function returns null
 * after one cached lookup.
 */
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments, tierPoolArms, tierPools, workspaces } from './db/schema';
import { resolveInheritanceParent } from './experiment-lineage';
import {
  continuesChain,
  decideAgentArm,
  drawPoolArm,
  poolEligibility,
  poolTakesDraws,
  routeBackend,
  type AgentArmDecision,
  type Allocation,
  type ArmRoute,
  type PoolIneligibleReason,
  type PoolMode,
  type PoolSurface,
  type PriorPoolAssignment,
} from './tier-pool';
import { DEFAULT_MAX_BUDGET_PRESSURE } from './model-routing-experiment';
import { getCachedOpenRouterCatalog } from './model-catalog-cache';
import { chatModelVerdict } from './chat-model-eligibility';
import { DEFAULT_DIAL, decideDialArm, dialAllocation, isDial, type Dial, type DialStateRecord } from './tier-dial';

// ── Pool lookup (cached) ────────────────────────────────────────────────────

export interface LoadedArm {
  id: string;
  route: ArmRoute;
  model: string;
  role: 'incumbent' | 'challenger';
  status: 'active' | 'paused' | 'removed';
  addedAt: Date;
}

export interface LoadedPool {
  id: string;
  tier: string;
  surface: PoolSurface;
  mode: PoolMode;
  frozen: boolean;
  experimentId: string | null;
  policyVersion: number;
  allocation: Allocation;
  allocationVersion: number;
  /** `dial` mode only: the cell's dial and its learning state. */
  dial: Dial;
  dialState: DialStateRecord | null;
  /** Live (not removed) arms, incumbent first, then by when they joined. */
  arms: LoadedArm[];
}

/** Same TTL as the tier registry: a traffic change lands within a minute. */
const POOL_TTL_MS = 60_000;
const poolCache = new Map<string, { at: number; pools: LoadedPool[] }>();

/** Drop the in-process cache. Call after any pool write; tests too. */
export function invalidateTierPoolCache(teamId?: string): void {
  if (teamId) poolCache.delete(teamId);
  else poolCache.clear();
}

/** WHERE clause for a team's pools. P1 pools are team-wide (workspace_id NULL). */
export function teamPoolsScope(teamId: string) {
  return and(eq(tierPools.teamId, teamId), isNull(tierPools.workspaceId));
}

/** WHERE clause for the live arms of a set of pools. */
export function liveArmsScope(poolIds: string[]) {
  return and(inArray(tierPoolArms.poolId, poolIds), ne(tierPoolArms.status, 'removed'));
}

export function orderArms<T extends { role: string; addedAt: Date; id: string }>(arms: T[]): T[] {
  return [...arms].sort((a, b) =>
    (a.role === 'incumbent' ? 0 : 1) - (b.role === 'incumbent' ? 0 : 1)
    || a.addedAt.getTime() - b.addedAt.getTime()
    || a.id.localeCompare(b.id));
}

export async function loadTeamPools(teamId: string): Promise<LoadedPool[]> {
  const hit = poolCache.get(teamId);
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.pools;

  const poolRows = await db
    .select({
      id: tierPools.id,
      tier: tierPools.tier,
      surface: tierPools.surface,
      mode: tierPools.mode,
      frozenAt: tierPools.frozenAt,
      experimentId: tierPools.experimentId,
      allocation: tierPools.allocation,
      allocationVersion: tierPools.allocationVersion,
      dial: tierPools.dial,
      dialState: tierPools.dialState,
      policyVersion: experiments.policyVersion,
    })
    .from(tierPools)
    .leftJoin(experiments, eq(experiments.id, tierPools.experimentId))
    .where(teamPoolsScope(teamId));

  let pools: LoadedPool[] = [];
  if (poolRows.length > 0) {
    const armRows = await db
      .select({
        id: tierPoolArms.id,
        poolId: tierPoolArms.poolId,
        route: tierPoolArms.route,
        model: tierPoolArms.model,
        role: tierPoolArms.role,
        status: tierPoolArms.status,
        addedAt: tierPoolArms.addedAt,
      })
      .from(tierPoolArms)
      .where(liveArmsScope(poolRows.map(p => p.id)));
    pools = poolRows.map(p => ({
      id: p.id,
      tier: p.tier,
      surface: p.surface,
      mode: p.mode,
      frozen: p.frozenAt != null,
      experimentId: p.experimentId,
      policyVersion: p.policyVersion ?? 1,
      allocation: (p.allocation ?? {}) as Allocation,
      allocationVersion: p.allocationVersion,
      dial: isDial(p.dial) ? p.dial : DEFAULT_DIAL,
      dialState: readDialState(p.dialState),
      arms: orderArms(armRows.filter(a => a.poolId === p.id).map(a => ({ ...a, addedAt: new Date(a.addedAt) }))),
    }));
  }
  poolCache.set(teamId, { at: Date.now(), pools });
  return pools;
}

/** A stored `dial_state`, or null when it is missing or malformed. */
export function readDialState(raw: unknown): DialStateRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const st = (raw as { state?: unknown }).state;
  if (st !== 'always' && st !== 'learning' && st !== 'shifted' && st !== 'reverted') return null;
  return raw as DialStateRecord;
}

/**
 * The allocation a pool serves. A dial pool's comes from its state, not the
 * stored column, so a learning cell can never serve an alternate whatever
 * the column says.
 */
export function servingAllocation(pool: LoadedPool): Allocation {
  return pool.mode === 'dial' ? dialAllocation(pool.arms, pool.dialState, pool.dial) : pool.allocation;
}

/** The alternate a learning cell would pick: the step's candidate, else the first active alternate. */
function shadowArm(pool: LoadedPool): LoadedArm | null {
  const live = pool.arms.filter(a => a.status === 'active' && a.role === 'challenger');
  const named = pool.dialState?.candidateArmId;
  return live.find(a => a.id === named) ?? live[0] ?? null;
}

async function findPool(teamId: string, tier: string, surface: PoolSurface): Promise<LoadedPool | null> {
  const pools = await loadTeamPools(teamId);
  return pools.find(p => p.tier === tier && p.surface === surface) ?? null;
}

function activeIds(pool: LoadedPool): Set<string> {
  return new Set(pool.arms.filter(a => a.status === 'active').map(a => a.id));
}

export function isSensitiveWorkspace(ws: { dataClass?: string | null; gitConfig?: unknown } | null | undefined): boolean {
  if (!ws) return false;
  const git = ws.gitConfig as { dataClass?: string } | null | undefined;
  return ws.dataClass === 'sensitive' || git?.dataClass === 'sensitive';
}

// ── Agent runs (claim route) ────────────────────────────────────────────────

export interface AgentPoolDraw {
  poolId: string;
  experimentId: string;
  policyVersion: number;
  allocationVersion: number;
  arm: LoadedArm;
  propensity: number;
  unitType: 'mission' | 'task';
  unitId: string;
  source: 'existing' | 'inherited' | 'unit' | 'drawn';
  /** True when this task already has a row: nothing to insert. */
  alreadyRecorded: boolean;
  served: boolean;
  defaultModel: string | null;
  assignedModel: string | null;
  eligibility: Record<string, unknown>;
}

export interface AgentPoolArgs {
  teamId: string | null | undefined;
  tier: string;
  task: {
    id: string;
    missionId?: string | null;
    parentTaskId?: string | null;
    taskClass?: string | null;
    category?: string | null;
    context?: Record<string, unknown> | null;
  };
  workspace: { dataClass?: string | null; gitConfig?: unknown } | null | undefined;
  /** The registry entry came from a workspace override row. */
  workspaceOverride: boolean;
  explicitModel: string | null;
  roleModel: string | null;
  budgetPressure: number;
  /** The task is already in the model-routing experiment. */
  inModelRoutingExperiment: boolean;
}

/** WHERE clause for the prior pool assignments one claim can reuse. */
export function agentPriorsScope(experimentId: string, taskIds: string[], unitId: string) {
  return and(
    eq(experimentAssignments.experimentId, experimentId),
    or(inArray(experimentAssignments.taskId, taskIds), eq(experimentAssignments.unitId, unitId)),
  );
}

/**
 * The arm this task runs on, or null to serve the incumbent unchanged (no
 * pool, pool pinned, task ineligible, or any error).
 */
export async function drawAgentPoolArm(args: AgentPoolArgs): Promise<AgentPoolDraw | null> {
  try {
    if (!args.teamId) return null;
    const pool = await findPool(args.teamId, args.tier, 'agent');
    if (!pool || !pool.experimentId) return null;

    const ctx = args.task.context ?? {};
    const elig = poolEligibility({
      tier: args.tier,
      mode: pool.mode,
      frozen: pool.frozen,
      workspaceSensitive: isSensitiveWorkspace(args.workspace),
      workspaceOverride: args.workspaceOverride,
      explicitModel: args.explicitModel,
      roleModel: args.roleModel,
      category: args.task.category,
      reviewerFor: ctx.reviewerFor,
      budgetPressure: args.budgetPressure,
      maxBudgetPressure: DEFAULT_MAX_BUDGET_PRESSURE,
      inModelRoutingExperiment: args.inModelRoutingExperiment,
    });
    if (!elig.eligible) return null;

    const parentId = resolveInheritanceParent({
      parentTaskId: args.task.parentTaskId,
      taskClass: args.task.taskClass,
      category: args.task.category,
      reviewerFor: ctx.reviewerFor,
    });
    const unit = args.task.missionId
      ? { unitType: 'mission' as const, unitId: args.task.missionId }
      : { unitType: 'task' as const, unitId: args.task.id };

    const priors = await db
      .select({
        taskId: experimentAssignments.taskId,
        unitType: experimentAssignments.unitType,
        unitId: experimentAssignments.unitId,
        armId: experimentAssignments.armId,
        propensity: experimentAssignments.propensity,
        allocationVersion: experimentAssignments.allocationVersion,
      })
      .from(experimentAssignments)
      .where(agentPriorsScope(pool.experimentId, parentId ? [args.task.id, parentId] : [args.task.id], unit.unitId));

    const allocation = servingAllocation(pool);
    const isDialPool = pool.mode === 'dial';
    // A dial pool only lets a run stick to an arm that is serving now: after a
    // revert, a mission whose earlier task ran the alternate goes back to the
    // primary with everyone else.
    const live = isDialPool
      ? new Set([...activeIds(pool)].filter(id => (allocation[id] ?? 0) > 0))
      : activeIds(pool);
    const drawn = decideAgentArm({
      taskId: args.task.id,
      parentId,
      unitId: unit.unitId,
      priors: priors as PriorPoolAssignment[],
      activeArmIds: live,
      allocationVersion: pool.allocationVersion,
      draw: () => drawPoolArm({
        experimentId: pool.experimentId!,
        policyVersion: pool.policyVersion,
        drawKey: unit.unitId,
        allocation,
        armOrder: pool.arms.filter(a => live.has(a.id)).map(a => a.id),
      }),
    });
    if (drawn.source === 'none') return null;
    let decision: Exclude<AgentArmDecision, { source: 'none' }> = drawn;
    let dialEligibility: Record<string, unknown> = {};
    if (isDialPool) {
      const incumbentArm = pool.arms.find(a => a.role === 'incumbent' && a.status === 'active');
      if (!incumbentArm) return null;
      const shadow = shadowArm(pool);
      const pick = decideDialArm({
        record: pool.dialState, incumbentId: incumbentArm.id,
        drawnArmId: pool.dial === 1 ? null : decision.armId, shadowArmId: shadow?.id ?? null,
      });
      if (pick.armId !== decision.armId) {
        decision = { source: decision.source === 'existing' ? 'existing' : 'drawn', armId: pick.armId, propensity: allocation[pick.armId] ?? 1, allocationVersion: pool.allocationVersion };
      }
      dialEligibility = {
        dial: pool.dial,
        dialState: pool.dialState?.state ?? 'learning',
        ...(pick.shadowArmId ? { shadowArmId: pick.shadowArmId, shadowModel: shadow?.model ?? null } : {}),
      };
    }
    // A reused arm that has since been removed has no row in `pool.arms`.
    // The unit still belongs to it (intent to treat) but runs the incumbent.
    const arm = pool.arms.find(a => a.id === decision.armId) ?? null;
    const incumbent = pool.arms.find(a => a.role === 'incumbent');
    if (!incumbent) return null;

    return {
      poolId: pool.id,
      experimentId: pool.experimentId,
      policyVersion: pool.policyVersion,
      allocationVersion: decision.allocationVersion ?? pool.allocationVersion,
      arm: arm ?? { ...incumbent, id: decision.armId, role: 'challenger', status: 'removed' },
      propensity: decision.propensity,
      unitType: unit.unitType,
      unitId: unit.unitId,
      source: decision.source,
      alreadyRecorded: decision.source === 'existing',
      served: arm?.role === 'incumbent',
      defaultModel: null,
      assignedModel: null,
      eligibility: {
        source: decision.source,
        budgetPressure: args.budgetPressure,
        ...(decision.source === 'inherited' && parentId ? { inheritedFromTaskId: parentId } : {}),
        ...dialEligibility,
      },
    };
  } catch (err) {
    console.warn(`[tier-pool] agent draw failed for task ${args.task.id}; serving the incumbent:`, err);
    return null;
  }
}

/**
 * The model a challenger draw serves, or null to keep the incumbent. Only an
 * active challenger on the task's own backend, whose model the runner's
 * client can serve, overrides; anything else serves the incumbent and records
 * `served = false` (capability gaps never defer, as in model_routing).
 */
export function applyAgentPoolArm(
  draw: AgentPoolDraw,
  args: { incumbentModel: string; backend: string | null | undefined; clientCanServe: (model: string) => boolean },
): { model: string; provider: string } | null {
  draw.defaultModel = args.incumbentModel;
  draw.assignedModel = args.incumbentModel;
  if (draw.arm.role === 'incumbent') {
    draw.served = true;
    return null;
  }
  draw.served = false;
  if (draw.arm.status !== 'active') {
    draw.eligibility = { ...draw.eligibility, fallback: 'arm_inactive' };
    return null;
  }
  if (routeBackend(draw.arm.route) !== (args.backend ?? 'claude')) {
    draw.eligibility = { ...draw.eligibility, fallback: 'backend_mismatch' };
    return null;
  }
  if (!args.clientCanServe(draw.arm.model)) {
    draw.eligibility = { ...draw.eligibility, fallback: 'client_capability' };
    return null;
  }
  draw.served = true;
  draw.assignedModel = draw.arm.model;
  return { model: draw.arm.model, provider: draw.arm.route === 'runner:codex' ? 'openai-codex' : 'anthropic' };
}

/** Persist an agent assignment. Idempotent on (experiment_id, task_id). Never throws. */
export async function recordAgentPoolAssignment(
  draw: AgentPoolDraw,
  args: { taskId: string; resolvedModel: string; runnerCliVersion: string | null | undefined },
): Promise<void> {
  if (draw.alreadyRecorded) return;
  try {
    await db.insert(experimentAssignments).values({
      experimentId: draw.experimentId,
      taskId: args.taskId,
      unitType: draw.unitType,
      unitId: draw.unitId,
      arm: draw.arm.id,
      armId: draw.arm.status === 'removed' ? null : draw.arm.id,
      allocationVersion: draw.allocationVersion,
      propensity: draw.propensity,
      policyVersion: draw.policyVersion,
      defaultModel: draw.defaultModel,
      assignedModel: draw.assignedModel ?? args.resolvedModel,
      served: draw.served,
      eligibility: draw.eligibility,
      runnerCliVersion: args.runnerCliVersion ?? null,
    }).onConflictDoNothing({ target: [experimentAssignments.experimentId, experimentAssignments.taskId] });
  } catch (err) {
    console.warn(`[tier-pool] failed to record assignment for task ${args.taskId}:`, err);
  }
}

// ── Chat turns ──────────────────────────────────────────────────────────────

export interface ChatPoolDraw {
  poolId: string;
  experimentId: string;
  policyVersion: number;
  allocationVersion: number;
  arm: LoadedArm;
  propensity: number;
  conversationId: string;
  source: 'chain' | 'drawn';
  served: boolean;
  defaultModel: string | null;
  assignedModel: string | null;
}

export interface ChatPoolArgs {
  teamId: string;
  workspaceId: string | null;
  tier: string;
  conversationId: string;
  /** Salt for a fresh chain: stable per chain start, e.g. `${conversationId}#${turnIndex}`. */
  drawKey: string;
  /** The last stored assistant turn, if any. */
  previous: { id: string; tier: string | null; createdAt: Date } | null;
  workspaceOverride: boolean;
  now: Date;
}

/** WHERE clause for the assignment of one earlier turn. */
export function chatPreviousScope(experimentId: string, messageId: string) {
  return and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.messageId, messageId));
}

/**
 * The arm this chat turn runs on, or null to serve the incumbent as today.
 * A turn that continues a chain reuses the chain's arm; otherwise it draws.
 * A challenger that can't serve chat (no tool calling, or listed tools it
 * doesn't call: `chatModelVerdict`) is never served: null, so the incumbent.
 */
export async function drawChatPoolArm(args: ChatPoolArgs): Promise<ChatPoolDraw | null> {
  try {
    const pool = await findPool(args.teamId, args.tier, 'chat');
    if (!pool || !pool.experimentId || !poolTakesDraws(pool.mode, pool.frozen)) return null;

    let sensitive = false;
    if (args.workspaceId) {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, args.workspaceId),
        columns: { dataClass: true, gitConfig: true },
      });
      sensitive = isSensitiveWorkspace(ws);
    }
    const elig = poolEligibility({
      tier: args.tier, mode: pool.mode, frozen: pool.frozen,
      workspaceSensitive: sensitive, workspaceOverride: args.workspaceOverride,
    });
    if (!elig.eligible) return null;

    const live = activeIds(pool);
    let prevArmId: string | null = null;
    let prevPropensity = 1;
    if (args.previous) {
      const [row] = await db
        .select({ armId: experimentAssignments.armId, propensity: experimentAssignments.propensity })
        .from(experimentAssignments)
        .where(chatPreviousScope(pool.experimentId, args.previous.id))
        .limit(1);
      prevArmId = continuesChain({
        previous: { tier: args.previous.tier, createdAt: args.previous.createdAt, armId: row?.armId ?? null },
        tier: args.tier, now: args.now, activeArmIds: live,
      });
      prevPropensity = row?.propensity ?? 1;
    }

    let armId: string;
    let propensity: number;
    let source: ChatPoolDraw['source'];
    if (prevArmId) {
      armId = prevArmId; propensity = prevPropensity; source = 'chain';
    } else {
      const d = drawPoolArm({
        experimentId: pool.experimentId, policyVersion: pool.policyVersion, drawKey: args.drawKey,
        allocation: servingAllocation(pool), armOrder: pool.arms.filter(a => live.has(a.id)).map(a => a.id),
      });
      if (!d) return null;
      armId = d.armId; propensity = d.propensity; source = 'drawn';
    }
    const arm = pool.arms.find(a => a.id === armId);
    if (!arm) return null;
    if (arm.role === 'challenger') {
      const verdict = chatModelVerdict(arm.route, arm.model, await getCachedOpenRouterCatalog());
      if (!verdict.ok) {
        console.warn(`[tier-pool] chat arm ${arm.id} is not chat-capable (${verdict.reason}); serving the incumbent`);
        return null;
      }
    }
    return {
      poolId: pool.id, experimentId: pool.experimentId, policyVersion: pool.policyVersion,
      allocationVersion: pool.allocationVersion, arm, propensity, conversationId: args.conversationId,
      source, served: arm.role === 'incumbent', defaultModel: null, assignedModel: null,
    };
  } catch (err) {
    console.warn(`[tier-pool] chat draw failed for conversation ${args.conversationId}; serving the incumbent:`, err);
    return null;
  }
}

/** Persist a chat-turn assignment. Idempotent on (experiment_id, message_id). Never throws. */
export async function recordChatPoolAssignment(draw: ChatPoolDraw, args: { messageId: string }): Promise<void> {
  try {
    await db.insert(experimentAssignments).values({
      experimentId: draw.experimentId,
      taskId: null,
      conversationId: draw.conversationId,
      messageId: args.messageId,
      unitType: 'conversation',
      unitId: draw.conversationId,
      arm: draw.arm.id,
      armId: draw.arm.id,
      allocationVersion: draw.allocationVersion,
      propensity: draw.propensity,
      policyVersion: draw.policyVersion,
      defaultModel: draw.defaultModel,
      assignedModel: draw.assignedModel,
      served: draw.served,
      eligibility: { source: draw.source },
    }).onConflictDoNothing();
  } catch (err) {
    console.warn(`[tier-pool] failed to record assignment for message ${args.messageId}:`, err);
  }
}

export type { PoolIneligibleReason };
