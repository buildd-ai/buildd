/**
 * Experiment health — the query half. Flat selects feeding the pure
 * evaluator in ./experiment-health.ts. Each predicate is a builder so
 * __tests__/experiment-health-source.test.ts can render it to SQL.
 *
 * What counts as an enrolled unit differs by kind:
 * - model_routing: experiment_assignments rows of the current
 *   policy version (unit = mission, else task).
 * - heartbeat_triage: heartbeat_triage_looks rows carrying the experiment id
 *   (unit = mission). Its experiment_assignments rows exist only for missions
 *   that dispatched an organizer, so a treatment mission that always skipped
 *   would be missing there and the split would read as broken.
 * - tier_pool: experiment_assignments rows of the pool's CURRENT allocation
 *   version, against the pool's allocation over its live arms. A pool that
 *   takes no draws (pinned, or frozen) is not judged.
 */
import { and, eq, isNotNull, max } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments, heartbeatTriageLooks, tierPoolArms, tierPools } from './db/schema';
import {
  evaluateExperimentHealth,
  twoArmShares,
  type ExperimentHealthFinding,
  type HealthAssignment,
} from './experiment-health';
import { poolTakesDraws, type PoolMode } from './tier-pool';

/** Upper bound on rows pulled into memory for one health check. */
export const EXPERIMENT_HEALTH_ROW_LIMIT = 20_000;

export interface HealthExperimentRow {
  id: string;
  teamId?: string;
  key?: string;
  kind: string;
  status: string;
  startedAt: Date | string | null;
  treatmentFraction: number | string;
  policyVersion: number;
  config: unknown;
}

export function buildHealthAssignmentsQuery(experimentId: string, policyVersion: number | null, allocationVersion: number | null) {
  const scope = allocationVersion !== null
    ? and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.allocationVersion, allocationVersion))
    : and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.policyVersion, policyVersion ?? 1));
  return db
    .select({ arm: experimentAssignments.arm, unitId: experimentAssignments.unitId, assignedAt: experimentAssignments.assignedAt })
    .from(experimentAssignments)
    .where(scope)
    .limit(EXPERIMENT_HEALTH_ROW_LIMIT);
}

export function buildTriageLooksHealthQuery(experimentId: string, policyVersion: number) {
  return db
    .select({ arm: heartbeatTriageLooks.arm, unitId: heartbeatTriageLooks.missionId, assignedAt: heartbeatTriageLooks.createdAt })
    .from(heartbeatTriageLooks)
    .where(and(
      eq(heartbeatTriageLooks.experimentId, experimentId),
      eq(heartbeatTriageLooks.policyVersion, policyVersion),
      isNotNull(heartbeatTriageLooks.arm),
    ))
    .limit(EXPERIMENT_HEALTH_ROW_LIMIT);
}

/** Latest enrolment of any version: a fresh policy version is not "starved". */
export function buildLastAssignedQuery(experimentId: string, kind: string) {
  if (kind === 'heartbeat_triage') {
    return db
      .select({ at: max(heartbeatTriageLooks.createdAt) })
      .from(heartbeatTriageLooks)
      .where(and(eq(heartbeatTriageLooks.experimentId, experimentId), isNotNull(heartbeatTriageLooks.arm)));
  }
  return db
    .select({ at: max(experimentAssignments.assignedAt) })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experimentId));
}

export function buildPoolForExperimentQuery(experimentId: string) {
  return db
    .select({
      id: tierPools.id,
      mode: tierPools.mode,
      frozenAt: tierPools.frozenAt,
      allocation: tierPools.allocation,
      allocationVersion: tierPools.allocationVersion,
    })
    .from(tierPools)
    .where(eq(tierPools.experimentId, experimentId))
    .limit(1);
}

export function buildActiveArmsQuery(poolId: string) {
  return db
    .select({ id: tierPoolArms.id })
    .from(tierPoolArms)
    .where(and(eq(tierPoolArms.poolId, poolId), eq(tierPoolArms.status, 'active')));
}

/** Every running experiment on every team — the cron's work list. */
export function buildRunningExperimentsQuery() {
  return db
    .select({
      id: experiments.id,
      teamId: experiments.teamId,
      key: experiments.key,
      title: experiments.title,
      kind: experiments.kind,
      status: experiments.status,
      startedAt: experiments.startedAt,
      treatmentFraction: experiments.treatmentFraction,
      policyVersion: experiments.policyVersion,
      config: experiments.config,
    })
    .from(experiments)
    .where(eq(experiments.status, 'running'));
}

const toDate = (d: Date | string | null | undefined) => (d ? (d instanceof Date ? d : new Date(d)) : null);
const plain = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export async function runExperimentHealth(row: HealthExperimentRow, now: Date = new Date()): Promise<ExperimentHealthFinding[]> {
  if (row.status !== 'running') return [];
  const config = plain(row.config);

  let expectedShares: Record<string, number>;
  let raw: Array<{ arm: string | null; unitId: string; assignedAt: Date | string }>;

  if (row.kind === 'tier_pool') {
    const [pool] = await buildPoolForExperimentQuery(row.id);
    if (!pool || !poolTakesDraws(pool.mode as PoolMode, pool.frozenAt != null)) return [];
    const live = new Set((await buildActiveArmsQuery(pool.id)).map(a => a.id));
    expectedShares = Object.fromEntries(Object.entries(plain(pool.allocation)).filter(([id]) => live.has(id))) as Record<string, number>;
    raw = await buildHealthAssignmentsQuery(row.id, null, pool.allocationVersion);
  } else if (row.kind === 'heartbeat_triage') {
    expectedShares = twoArmShares(Number(row.treatmentFraction));
    raw = await buildTriageLooksHealthQuery(row.id, row.policyVersion);
  } else {
    expectedShares = twoArmShares(Number(row.treatmentFraction));
    raw = await buildHealthAssignmentsQuery(row.id, row.policyVersion, null);
  }

  const [last] = await buildLastAssignedQuery(row.id, row.kind);
  const assignments: HealthAssignment[] = raw
    .filter(r => r.arm)
    .map(r => ({ arm: r.arm as string, unitId: r.unitId, assignedAt: toDate(r.assignedAt)! }));

  return evaluateExperimentHealth({
    status: row.status,
    kind: row.kind,
    startedAt: toDate(row.startedAt),
    config,
    expectedShares,
    assignments,
    lastAssignedAt: toDate(last?.at ?? null),
  }, now);
}
