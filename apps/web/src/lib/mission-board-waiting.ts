/**
 * Why a mission's waiting tasks are not running, read from the claim gate's own
 * predicates (spec f7f67f1a P-1): which arm released each dependency edge, and
 * one `WaitingKind` per waiting task.
 *
 * The display gate (`isGateSatisfied`) judges a dependency by its status only.
 * The claim gate also releases an edge on an early release, a force start, an
 * inferred edge onto an unstarted holder or another landing base, a surface
 * audit's mission scope and the bypass flag, so a dependent the claim gate
 * would start read blocked on the strip. This module selects each arm of
 * `dependencySatisfied()` separately (`DEP_EDGE_ARM_SQL`), so the page and the
 * claim read the same SQL, and never writes anything.
 *
 * One query set per page load: the edge arms, the pending tasks' own holds,
 * and the claim loop's fresh deferrals. A read failure degrades to the status
 * arm alone (today's behaviour), never a thrown page.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { sql, type SQL } from 'drizzle-orm';
import type { WaitingKind } from '@buildd/core/waiting-reason';
import { DEP_EDGE_ARM_SQL, outsideSurfaceAuditMission } from '@/app/api/workers/claim/deps-gate';
import { taskNotHeld } from '@/app/api/workers/claim/held-gate';
import { BYPASS_DEPS_GATE_KEY, bypassFlagCondition } from '@/lib/bypass-flags';
import { DEP_EDGE_RELEASE_ARMS, type DepEdgeReleaseArm, type DepReleaseArm } from '@/lib/dep-gate-contract';
import { loadMissionClaimDeferrals } from '@/lib/mission-claim-deferrals';
import type { MissionGateFacts, ReleasedEdge } from '@/lib/mission-board';

export type { MissionGateFacts, ReleasedEdge };

export const EMPTY_GATE_FACTS: MissionGateFacts = { releasedEdges: [], waitingKinds: {} };

/** One row of `edgeFactsSql`: every arm's verdict for one (dependent, dependency) edge. */
export type EdgeFactsRow = { dependent_id: string; dependency_id: string; inferred: boolean | string | null }
  & Record<`arm_${DepEdgeReleaseArm}` | 'arm_surface_audit_scope' | 'arm_bypass', boolean | string | null>;

const truthy = (v: unknown) => v === true || v === 't' || v === 'true';

/**
 * Every dependency edge of the mission's unfinished tasks, with each claim-gate
 * arm as its own column. `FROM tasks` so the arms' `tasks.*` references bind
 * to the dependent row, exactly as in the claim query.
 */
export function edgeFactsSql(missionId: string): SQL {
  const dep = sql`dep_id::uuid`;
  const arms = DEP_EDGE_RELEASE_ARMS.map((arm) => sql`${DEP_EDGE_ARM_SQL[arm](dep)} AS ${sql.identifier(`arm_${arm}`)}`);
  return sql`SELECT ${tasks.id} AS dependent_id, dep_id AS dependency_id,
    ${sql.join(arms, sql`, `)},
    ${outsideSurfaceAuditMission(dep)} AS arm_surface_audit_scope,
    ${bypassFlagCondition(tasks.context, BYPASS_DEPS_GATE_KEY)} AS arm_bypass,
    COALESCE(${tasks.pathDeclaration}->'inferredDependsOn' ? dep_id, FALSE) AS inferred
  FROM ${tasks}, jsonb_array_elements_text(COALESCE(${tasks.dependsOn}::jsonb, '[]'::jsonb)) AS dep_id
  WHERE ${tasks.missionId} = ${missionId}
  AND ${tasks.status} NOT IN ('completed', 'cancelled')
  AND dep_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
}

/** The mission's pending tasks and the holds on the task itself. */
export function pendingHoldsSql(missionId: string): SQL {
  return sql`SELECT ${tasks.id} AS id,
    COALESCE(${tasks.startAt} > now(), FALSE) AS deferred,
    NOT ${taskNotHeld()} AS held
  FROM ${tasks}
  WHERE ${tasks.missionId} = ${missionId} AND ${tasks.status} = 'pending'`;
}

/**
 * The arm that released an edge when its status did not, or undefined when the
 * edge still holds or its status released it. Gate-level arms first: they
 * release every edge of the dependent.
 */
export function edgeReleaseArm(row: EdgeFactsRow): DepReleaseArm | undefined {
  if (truthy(row.arm_bypass)) return 'bypass';
  if (truthy(row.arm_surface_audit_scope)) return 'surface_audit_scope';
  if (truthy(row.arm_status)) return undefined;
  return DEP_EDGE_RELEASE_ARMS.find((arm) => arm !== 'status' && truthy(row[`arm_${arm}`]));
}

/** Claim-loop deferral reasons (`deferrals` keys) and the waiting kind each means. */
export const DEFERRAL_WAITING_KIND: Readonly<Record<string, WaitingKind>> = {
  path_overlap: 'pr_overlap_live',
  advisory_manifest: 'scope_undeclared_mutex',
  soft_overlap: 'soft_overlap',
  ordered_behind: 'ordered_behind',
  subject_dead: 'subject_dead',
  mission_budget: 'mission_budget',
  mission_concurrent: 'mission_concurrent',
  mission_paced: 'mission_paced',
  workspace_cap: 'workspace_cap',
  provider_unavailable: 'provider_unavailable',
  budget_paused: 'budget_paused',
};

export interface WaitingTaskFacts {
  deferred: boolean;
  held: boolean;
  /** Edges no claim-gate arm releases: declared by the filer, or inferred at creation. */
  openDeclared: number;
  openInferred: number;
  /** The claim loop's freshest deferral reason for this task, if any. */
  deferralReason: string | null;
}

export interface MissionHoldFacts {
  held: boolean;
  local: boolean;
  budgetExhausted: boolean;
}

/**
 * The one cause that explains a waiting task, in the order a person would fix
 * them: a schedule or hold first, then dependencies, then what the claim loop
 * last reported. Null when nothing here explains it; the page then says only
 * that it is waiting, never that a dependency holds it.
 */
export function waitingKindFor(task: WaitingTaskFacts, mission: MissionHoldFacts): WaitingKind | null {
  if (task.deferred) return 'start_deferred';
  if (task.held) return 'task_held';
  if (mission.held) return 'mission_held';
  if (mission.budgetExhausted) return 'mission_budget';
  if (task.openDeclared > 0) return 'dep_declared';
  if (task.openInferred > 0) return 'dep_inferred';
  if (mission.local) return 'mission_local';
  return (task.deferralReason && DEFERRAL_WAITING_KIND[task.deferralReason]) || null;
}

/** Pure: the three reads, combined into the board's facts. */
export function combineGateFacts(input: {
  edges: readonly EdgeFactsRow[];
  pending: ReadonlyArray<{ id: string; deferred: unknown; held: unknown }>;
  deferrals: ReadonlyArray<{ taskId: string; reason: string }>;
  mission: MissionHoldFacts;
}): MissionGateFacts {
  const releasedEdges: ReleasedEdge[] = [];
  const open = new Map<string, { declared: number; inferred: number }>();
  for (const row of input.edges) {
    const arm = edgeReleaseArm(row);
    if (arm) {
      releasedEdges.push({ dependentId: row.dependent_id, dependencyId: row.dependency_id, arm });
    } else if (!truthy(row.arm_status)) {
      const o = open.get(row.dependent_id) ?? { declared: 0, inferred: 0 };
      if (truthy(row.inferred)) o.inferred++;
      else o.declared++;
      open.set(row.dependent_id, o);
    }
  }
  const deferral = new Map(input.deferrals.map((d) => [d.taskId, d.reason]));
  const waitingKinds: Record<string, WaitingKind> = {};
  for (const p of input.pending) {
    const o = open.get(p.id);
    const kind = waitingKindFor({
      deferred: truthy(p.deferred),
      held: truthy(p.held),
      openDeclared: o?.declared ?? 0,
      openInferred: o?.inferred ?? 0,
      deferralReason: deferral.get(p.id) ?? null,
    }, input.mission);
    if (kind) waitingKinds[p.id] = kind;
  }
  return { releasedEdges, waitingKinds };
}

async function rows<T>(query: SQL): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as { rows?: T[] }).rows ?? []) as T[];
}

/** Load the mission's gate facts. Never throws: a failed read returns the empty facts. */
export async function loadMissionGateFacts(missionId: string, mission: MissionHoldFacts): Promise<MissionGateFacts> {
  try {
    const [edges, pending, deferrals] = await Promise.all([
      rows<EdgeFactsRow>(edgeFactsSql(missionId)),
      rows<{ id: string; deferred: unknown; held: unknown }>(pendingHoldsSql(missionId)),
      loadMissionClaimDeferrals(missionId).catch(() => []),
    ]);
    return combineGateFacts({ edges, pending, deferrals, mission });
  } catch (err) {
    console.warn(`[mission-board-waiting] mission ${missionId}: gate facts unavailable:`, (err as Error)?.message ?? err);
    return EMPTY_GATE_FACTS;
  }
}
