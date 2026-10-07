/**
 * The per-cell dial — the stores half. Decisions live in `./tier-dial.ts`.
 *
 * - `loadTeamCodingRuns` reads a team's finished coding runs with the three
 *   signals buildd already keeps: the PR merged (workers.merged_at /
 *   pr_lifecycle_status), the first reviewer verdict and whether any reviewer
 *   asked for changes (reviewer tasks' `effectiveVerdict` / structured
 *   verdict), plus cost from task_outcomes.
 * - `runDialStep` evaluates every unfrozen `dial` agent pool once per call
 *   (hourly cron, gated to once per UTC day by the caller's schedule) and
 *   writes the new state. A state change is one statement: compare-and-set on
 *   `allocation_version`, the new allocation and `dial_state`, and its
 *   `tier_pool_changes` row — so traffic never moves without a recorded
 *   reason. No `db.transaction()` (neon-http).
 * - `buildModelPolicyCells` is the team read model shared with the UI and
 *   chat-learning tasks (`ModelPolicyCellsResponse` in @buildd/shared).
 *
 * Only coding (agent) cells learn here. Chat cells report their configured
 * state; the chat-learning task supplies chat evidence.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type {
  ModelPolicyCell, ModelPolicyCellRun, ModelPolicyCellSource, ModelPolicyCellsResponse, ModelPolicyDial,
} from '@buildd/shared';
import { db } from './db/client';
import { experiments, tierPoolArms, tierPools } from './db/schema';
import { INFRA_EXIT_CAUSES } from './experiment-readout';
import { resolveAllTiers, workspaceOverrideCounts } from './model-tier-registry';
import { TIERS, type Tier, type TierEntry, type TierSurface } from './model-tier-defaults';
import {
  DEFAULT_DIAL, cellState, decideDialCell, dialAllocation, evidenceFrom, gradeRun, gradedPace, isDial,
  learningProgress, shadowCandidate, type CodingRun, type DialDecision, type DialStateRecord,
} from './tier-dial';
import { invalidateTierPoolCache, orderArms, readDialState } from './tier-pool-source';
import { POOL_SURFACES, type Allocation, type PoolArmRef } from './tier-pool';

/** How far back the dial reads a team's runs. */
export const DIAL_EVIDENCE_DAYS = 90;
/** The pace (graded runs per day) is measured over this window. */
export const DIAL_PACE_DAYS = 28;
/** `whatRan` covers this window. */
export const WHAT_RAN_DAYS = 30;
const RECENT_RUNS = 5;
const DAY_MS = 86_400_000;

// ── Runs ────────────────────────────────────────────────────────────────────

interface RunRow {
  task_id: string;
  at: string | Date;
  tier: string | null;
  model: string | null;
  outcome: string | null;
  exit_cause: string | null;
  cost: string | null;
  merged: boolean | null;
  closed: boolean | null;
}
interface VerdictRow { for_task: string; at: string | Date; verdict: string | null }

/**
 * A team's finished coding runs since `since`: the latest outcome per task,
 * excluding reviewer tasks (they grade runs, they are not runs being graded).
 */
export async function loadTeamCodingRuns(teamId: string, since: Date): Promise<CodingRun[]> {
  const sinceIso = since.toISOString();
  const [runs, verdicts] = await Promise.all([
    db.execute(sql`
      SELECT t.id AS task_id, o.created_at AS at,
        COALESCE(t.context->'resolvedTier'->>'tier', t.tier) AS tier,
        COALESCE(o.actual_model, o.predicted_model) AS model,
        o.outcome, o.exit_cause, o.total_cost_usd AS cost,
        w.merged, w.closed
      FROM tasks t
      JOIN workspaces ws ON ws.id = t.workspace_id AND ws.team_id = ${teamId}
      JOIN LATERAL (
        SELECT outcome, exit_cause, total_cost_usd, actual_model, predicted_model, created_at
        FROM task_outcomes WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
      ) o ON true
      LEFT JOIN LATERAL (
        SELECT bool_or(merged_at IS NOT NULL OR pr_lifecycle_status = 'merged') AS merged,
               bool_or(pr_lifecycle_status = 'closed') AS closed
        FROM workers WHERE task_id = t.id
      ) w ON true
      WHERE o.created_at >= ${sinceIso}::timestamptz
        AND NOT (t.context ? 'reviewerFor')
        AND t.category IS DISTINCT FROM 'review'
    `),
    db.execute(sql`
      SELECT rt.context->>'reviewerFor' AS for_task, rt.created_at AS at,
        COALESCE(rt.result->>'effectiveVerdict', rt.result->'structuredOutput'->>'verdict') AS verdict
      FROM tasks rt
      JOIN workspaces ws ON ws.id = rt.workspace_id AND ws.team_id = ${teamId}
      WHERE rt.created_at >= ${sinceIso}::timestamptz
        AND rt.context ? 'reviewerFor'
        AND rt.status = 'completed'
    `),
  ]);
  const byTask = new Map<string, Array<{ at: number; verdict: string }>>();
  for (const v of verdicts.rows as unknown as VerdictRow[]) {
    if (!v.for_task || !v.verdict) continue;
    const l = byTask.get(v.for_task) ?? [];
    l.push({ at: new Date(v.at).getTime(), verdict: v.verdict });
    byTask.set(v.for_task, l);
  }
  return (runs.rows as unknown as RunRow[]).map(r => {
    const cost = r.cost != null ? Number(r.cost) : null;
    return {
      taskId: r.task_id,
      at: new Date(r.at),
      tier: r.tier,
      model: r.model,
      outcome: r.outcome,
      exitCause: r.exit_cause,
      costUsd: cost != null && Number.isFinite(cost) ? cost : null,
      merged: r.merged === true,
      prClosed: r.closed === true,
      verdicts: (byTask.get(r.task_id) ?? []).sort((a, b) => a.at - b.at).map(x => x.verdict),
    };
  });
}

/**
 * The same model under two spellings: an exact id, or one id plus a dated
 * suffix (`claude-x-4-5` vs `claude-x-4-5-20251001`).
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

// ── Daily step ──────────────────────────────────────────────────────────────

export interface DialPool {
  id: string;
  teamId: string;
  tier: string;
  dial: ModelPolicyDial;
  dialState: DialStateRecord | null;
  allocation: Allocation;
  allocationVersion: number;
  arms: Array<PoolArmRef & { model: string; addedAt: Date }>;
}

/** Inputs for one agent cell, from the team's runs. Pure. */
export function dialInputFor(pool: DialPool, runs: readonly CodingRun[], now: Date) {
  const live = pool.arms.filter(a => a.status === 'active');
  const incumbent = live.find(a => a.role === 'incumbent');
  if (!incumbent) return null;
  const prior = pool.dialState;
  const sinceMs = prior?.evidenceSince ? Date.parse(prior.evidenceSince) : now.getTime() - DIAL_EVIDENCE_DAYS * DAY_MS;
  const shiftMs = prior?.state === 'shifted' ? Date.parse(prior.since) : now.getTime();
  const after = (ms: number) => (r: CodingRun) => r.at.getTime() >= ms;
  const inTier = runs.filter(r => r.tier === pool.tier);
  const paceSince = now.getTime() - DIAL_PACE_DAYS * DAY_MS;

  return {
    dial: pool.dial,
    prior,
    now,
    primary: {
      armId: incumbent.id,
      evidence: evidenceFrom(inTier.filter(after(sinceMs)).filter(r => sameModel(r.model, incumbent.model)), INFRA_EXIT_CAUSES),
    },
    alternates: live.filter(a => a.role === 'challenger').map(a => ({
      armId: a.id,
      model: a.model,
      // The team's own runs on this model anywhere (observational).
      evidence: evidenceFrom(runs.filter(after(sinceMs)).filter(r => sameModel(r.model, a.model)), INFRA_EXIT_CAUSES),
      // This cell's runs it served since the shift (randomized, the revert evidence).
      inCell: evidenceFrom(inTier.filter(after(shiftMs)).filter(r => sameModel(r.model, a.model)), INFRA_EXIT_CAUSES),
    })),
    primaryInCellSinceShift: evidenceFrom(inTier.filter(after(shiftMs)).filter(r => sameModel(r.model, incumbent.model)), INFRA_EXIT_CAUSES),
    gradedPerDay: gradedPace(inTier.filter(after(paceSince)), INFRA_EXIT_CAUSES, DIAL_PACE_DAYS),
  };
}

export async function loadDialPools(teamId?: string): Promise<DialPool[]> {
  const rows = await db.select({
    id: tierPools.id,
    teamId: tierPools.teamId,
    tier: tierPools.tier,
    dial: tierPools.dial,
    dialState: tierPools.dialState,
    allocation: tierPools.allocation,
    allocationVersion: tierPools.allocationVersion,
  }).from(tierPools).where(and(
    isNull(tierPools.workspaceId),
    isNull(tierPools.frozenAt),
    eq(tierPools.mode, 'dial'),
    eq(tierPools.surface, 'agent'),
    ...(teamId ? [eq(tierPools.teamId, teamId)] : []),
  ));
  if (rows.length === 0) return [];
  const arms = await db.select({
    id: tierPoolArms.id, poolId: tierPoolArms.poolId, model: tierPoolArms.model,
    role: tierPoolArms.role, status: tierPoolArms.status, addedAt: tierPoolArms.addedAt,
  }).from(tierPoolArms).where(and(inArray(tierPoolArms.poolId, rows.map(r => r.id)), ne(tierPoolArms.status, 'removed')));
  return rows.map(r => ({
    id: r.id,
    teamId: r.teamId,
    tier: r.tier,
    dial: isDial(r.dial) ? r.dial : DEFAULT_DIAL,
    dialState: readDialState(r.dialState),
    allocation: (r.allocation ?? {}) as Allocation,
    allocationVersion: r.allocationVersion,
    arms: orderArms(arms.filter(a => a.poolId === r.id).map(a => ({ ...a, addedAt: new Date(a.addedAt) }))),
  }));
}

/**
 * Write a cell's new state. With `allocation`, a compare-and-set on the
 * version plus the change row, in one statement; null when the pool moved on.
 * Without, only `dial_state` (progress, candidate, evaluatedAt) — no traffic
 * moved, nothing to audit.
 */
export async function writeDialState(args: {
  teamId: string;
  poolId: string;
  expectedVersion: number;
  record: DialStateRecord;
  allocation?: Allocation;
  event?: { kind: 'promotion' | 'revert' | 'dial'; reason: string; evidence: Record<string, unknown> };
  actorUserId?: string | null;
  actorSystem?: string | null;
  dial?: ModelPolicyDial;
  /** Put the pool under the dial (an admin setting a dial on a split pool). */
  mode?: 'dial';
}): Promise<number | null> {
  const record = JSON.stringify(args.record);
  if (!args.allocation) {
    await db.execute(sql`
      UPDATE tier_pools SET dial_state = ${record}::jsonb, updated_at = now()
      WHERE id = ${args.poolId} AND team_id = ${args.teamId}
    `);
    return args.expectedVersion;
  }
  const kind = args.event?.kind ?? 'dial';
  const evidence = args.event ? { ...args.event.evidence, reason: args.event.reason } : null;
  const result = await db.execute(sql`
    WITH prev AS (
      SELECT allocation, dial, dial_state, mode, allocation_version FROM tier_pools
      WHERE id = ${args.poolId} AND team_id = ${args.teamId}
    ), u AS (
      UPDATE tier_pools
      SET allocation = ${JSON.stringify(args.allocation)}::jsonb,
          dial_state = ${record}::jsonb,
          dial = COALESCE(${args.dial ?? null}::integer, dial),
          mode = COALESCE(${args.mode ?? null}::text, mode),
          allocation_version = allocation_version + 1,
          updated_at = now()
      WHERE id = ${args.poolId} AND team_id = ${args.teamId} AND allocation_version = ${args.expectedVersion}
      RETURNING allocation, dial, dial_state, mode, allocation_version
    ), log AS (
      INSERT INTO tier_pool_changes (pool_id, kind, before, after, evidence, actor_user_id, actor_system)
      SELECT ${args.poolId}::uuid, ${kind}::text,
        jsonb_build_object('allocation', prev.allocation, 'mode', prev.mode, 'dial', prev.dial, 'dialState', prev.dial_state, 'version', prev.allocation_version),
        jsonb_build_object('allocation', u.allocation, 'mode', u.mode, 'dial', u.dial, 'dialState', u.dial_state, 'version', u.allocation_version),
        ${evidence ? JSON.stringify(evidence) : null}::jsonb,
        ${args.actorUserId ?? null}::uuid,
        ${args.actorSystem ?? null}::text
      FROM u, prev
    )
    SELECT allocation_version FROM u
  `);
  const row = (result.rows as Array<{ allocation_version: number }>)[0];
  return row ? Number(row.allocation_version) : null;
}

/** The record to store after a decision: the shadow's candidate and when it was judged. */
export function recordAfter(decision: DialDecision, now: Date): DialStateRecord {
  return {
    ...decision.record,
    ...(decision.record.state === 'learning' ? { candidateArmId: decision.progress?.candidate ?? null } : {}),
    evaluatedAt: now.toISOString(),
  };
}

function sameAllocation(a: Allocation, b: Allocation): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-6) return false;
  return true;
}

export interface DialStepSummary {
  pools: number;
  evaluated: number;
  transitions: Array<{ poolId: string; kind: string; to: string }>;
  stale: number;
  errors: number;
}

/** Evaluate every dial agent cell (optionally one team's). */
export async function runDialStep(args: { now: Date; teamId?: string }): Promise<DialStepSummary> {
  const summary: DialStepSummary = { pools: 0, evaluated: 0, transitions: [], stale: 0, errors: 0 };
  const pools = await loadDialPools(args.teamId);
  summary.pools = pools.length;
  const runsByTeam = new Map<string, CodingRun[]>();
  const touched = new Set<string>();
  for (const pool of pools) {
    try {
      let runs = runsByTeam.get(pool.teamId);
      if (!runs) {
        runs = await loadTeamCodingRuns(pool.teamId, new Date(args.now.getTime() - DIAL_EVIDENCE_DAYS * DAY_MS));
        runsByTeam.set(pool.teamId, runs);
      }
      const input = dialInputFor(pool, runs, args.now);
      if (!input) continue;
      const decision = decideDialCell(input);
      const record = recordAfter(decision, args.now);
      const allocation = dialAllocation(pool.arms, record, pool.dial);
      const moved = !!decision.event || !sameAllocation(allocation, pool.allocation);
      const v = await writeDialState({
        teamId: pool.teamId, poolId: pool.id, expectedVersion: pool.allocationVersion, record,
        ...(moved ? { allocation, event: decision.event, actorSystem: 'system:dial' } : {}),
      });
      summary.evaluated += 1;
      if (v === null) { summary.stale += 1; continue; }
      if (moved) {
        touched.add(pool.teamId);
        if (decision.event) summary.transitions.push({ poolId: pool.id, kind: decision.event.kind, to: record.state });
      }
    } catch (err) {
      summary.errors += 1;
      console.error(`[tier-dial] step failed for pool ${pool.id}:`, err);
    }
  }
  for (const t of touched) invalidateTierPoolCache(t);
  return summary;
}

// ── Read model ──────────────────────────────────────────────────────────────

function cellSource(entry: TierEntry): ModelPolicyCellSource {
  if (entry.source === 'team' || entry.source === 'workspace') return entry.source;
  if (entry.source === 'policy') return 'service';
  return 'default';
}

/** "What ran" per model for one cell's runs. Pure. */
export function whatRan(runs: readonly CodingRun[]): ModelPolicyCellRun[] {
  const byModel = new Map<string, CodingRun[]>();
  for (const r of runs) {
    if (!r.model) continue;
    // Fold dated spellings onto the first spelling seen.
    const key = [...byModel.keys()].find(k => sameModel(k, r.model)) ?? r.model;
    const l = byModel.get(key) ?? [];
    l.push(r);
    byModel.set(key, l);
  }
  const total = [...byModel.values()].reduce((s, l) => s + l.length, 0);
  return [...byModel.entries()]
    .map(([model, list]) => {
      const e = evidenceFrom(list, INFRA_EXIT_CAUSES);
      const rate = (sig: 'merged' | 'reviewOk') => (e.rates[sig].n ? e.rates[sig].k / e.rates[sig].n : null);
      return {
        model,
        share: total ? list.length / total : 0,
        runs: list.length,
        mergedRate: rate('merged'),
        reviewOkRate: rate('reviewOk'),
        costPerRunUsd: e.costPerRunUsd,
        recentRuns: [...list].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, RECENT_RUNS).map(r => {
          const g = gradeRun(r, INFRA_EXIT_CAUSES);
          return { taskId: r.taskId, at: r.at.toISOString(), merged: g.merged, reviewOk: g.reviewOk };
        }),
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

interface CellPoolRow {
  id: string;
  tier: string;
  surface: TierSurface;
  mode: string;
  dial: number;
  dialState: unknown;
  allocation: Allocation;
  allocationVersion: number;
}

/**
 * The team's read model: every tier x surface cell, with its primary,
 * alternates, dial, learning state and what ran.
 */
export async function buildModelPolicyCells(teamId: string, now = new Date()): Promise<ModelPolicyCellsResponse> {
  const [agentTiers, chatTiers, overrides, poolRows, runs, routingExps] = await Promise.all([
    resolveAllTiers(teamId, null, 'agent'),
    resolveAllTiers(teamId, null, 'chat'),
    workspaceOverrideCounts(teamId),
    db.select({
      id: tierPools.id, tier: tierPools.tier, surface: tierPools.surface, mode: tierPools.mode,
      dial: tierPools.dial, dialState: tierPools.dialState,
      allocation: tierPools.allocation, allocationVersion: tierPools.allocationVersion,
    }).from(tierPools).where(and(eq(tierPools.teamId, teamId), isNull(tierPools.workspaceId))),
    loadTeamCodingRuns(teamId, new Date(now.getTime() - DIAL_EVIDENCE_DAYS * DAY_MS)),
    db.select({ config: experiments.config }).from(experiments)
      .where(and(eq(experiments.teamId, teamId), eq(experiments.kind, 'model_routing'), eq(experiments.status, 'running'))),
  ]);
  const pools = poolRows as CellPoolRow[];
  const arms = pools.length
    ? await db.select({
      id: tierPoolArms.id, poolId: tierPoolArms.poolId, route: tierPoolArms.route, model: tierPoolArms.model,
      role: tierPoolArms.role, status: tierPoolArms.status, addedAt: tierPoolArms.addedAt,
    }).from(tierPoolArms).where(and(inArray(tierPoolArms.poolId, pools.map(p => p.id)), ne(tierPoolArms.status, 'removed')))
    : [];
  // A running model_routing experiment splits standard-tier agent runs onto its treatment tier.
  const routingTiers = new Set<string>();
  for (const e of routingExps) {
    routingTiers.add('standard');
    const t = ((e.config as { arms?: { treatment?: { tier?: string } } })?.arms?.treatment?.tier);
    if (t) routingTiers.add(t);
  }
  const whatRanSince = now.getTime() - WHAT_RAN_DAYS * DAY_MS;

  const cells: ModelPolicyCell[] = [];
  for (const surface of POOL_SURFACES) {
    const entries = surface === 'agent' ? agentTiers : chatTiers;
    for (const tier of TIERS as readonly Tier[]) {
      const entry = entries[tier];
      const pool = pools.find(p => p.tier === tier && p.surface === surface) ?? null;
      const poolArms = pool
        ? orderArms(arms.filter(a => a.poolId === pool.id).map(a => ({ ...a, addedAt: new Date(a.addedAt) })))
        : [];
      const alternates = poolArms.filter(a => a.role === 'challenger' && a.status === 'active');
      const incumbent = poolArms.find(a => a.role === 'incumbent');
      const isDialPool = pool?.mode === 'dial';
      const dial: ModelPolicyDial = pool && isDial(pool.dial) ? pool.dial : DEFAULT_DIAL;
      const record = isDialPool ? readDialState(pool!.dialState) : null;
      // A pinned, split or explore pool is not run by the dial: it reads
      // `always`, and an exact split shows as `experimentRunning`.
      const state = isDialPool ? cellState(record, dial, alternates.length) : 'always';
      const cell: ModelPolicyCell = {
        tier,
        surface,
        primary: { provider: entry.provider, model: incumbent?.model ?? entry.model },
        alternates: alternates.map(a => ({ provider: a.route, model: a.model })),
        dial,
        state,
        source: cellSource(entry),
        overrideCount: overrides.get(`${tier}:${surface}`) ?? 0,
        poolId: pool?.id ?? null,
        whatRan: surface === 'agent'
          ? whatRan(runs.filter(r => r.tier === tier && r.at.getTime() >= whatRanSince))
          : [],
      };
      const exactSplit = !!pool && (pool.mode === 'split' || pool.mode === 'explore') && alternates.some(a => (pool.allocation[a.id] ?? 0) > 0);
      if (exactSplit || (surface === 'agent' && routingTiers.has(tier))) cell.experimentRunning = true;
      if (record?.revertReason) cell.revertReason = record.revertReason;

      if (isDialPool && state === 'shifted' && record?.alternateArmId) {
        const alt = alternates.find(a => a.id === record.alternateArmId);
        const alloc = dialAllocation(poolArms, record, dial);
        cell.share = alloc[record.alternateArmId] ?? 0;
        if (alt) cell.shiftedTo = alt.model;
      }
      if (isDialPool && state === 'learning' && surface === 'agent') {
        const input = dialInputFor({
          id: pool!.id, teamId, tier, dial, dialState: record, allocation: pool!.allocation,
          allocationVersion: pool!.allocationVersion, arms: poolArms,
        }, runs, now);
        if (input) {
          // Progress as the next step will see it; nothing is written here.
          const p = learningProgress(input);
          const cand = shadowCandidate(input.alternates);
          cell.progress = {
            graded: p.graded, threshold: p.threshold, primaryGraded: p.primaryGraded,
            candidate: cand?.model ?? null, etaDays: p.etaDays,
          };
        }
      }
      cells.push(cell);
    }
  }
  return { teamId, generatedAt: now.toISOString(), windowDays: WHAT_RAN_DAYS, cells };
}
