/**
 * Heartbeat-triage readout: the query half. Three flat selects joined in
 * memory by `computeHeartbeatTriageReadout` (./heartbeat-triage-readout.ts),
 * each predicate a builder so its SQL can be rendered in a test.
 *
 * `policy_version` is part of the cohort filter: the draw is salted with it,
 * so rows from two versions are two experiments.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { heartbeatTriageLooks, tasks, workers } from './db/schema';
import {
  computeHeartbeatTriageReadout,
  organizerActed,
  type HeartbeatTriageReadout,
  type OrganizerOutcome,
  type TriageLookRow,
} from './heartbeat-triage-readout';

/** Upper bound on looks pulled into memory for one readout. */
export const HEARTBEAT_TRIAGE_READOUT_ROW_LIMIT = 20_000;

export function triageLookCohortScope(experimentId: string, policyVersion: number) {
  return and(
    eq(heartbeatTriageLooks.experimentId, experimentId),
    eq(heartbeatTriageLooks.policyVersion, policyVersion),
  );
}

export function buildTriageLooksQuery(experimentId: string, policyVersion: number) {
  return db
    .select({
      missionId: heartbeatTriageLooks.missionId,
      arm: heartbeatTriageLooks.arm,
      taskId: heartbeatTriageLooks.taskId,
      pick: heartbeatTriageLooks.pick,
      confidence: heartbeatTriageLooks.confidence,
      skipped: heartbeatTriageLooks.skipped,
      createdAt: heartbeatTriageLooks.createdAt,
    })
    .from(heartbeatTriageLooks)
    .where(triageLookCohortScope(experimentId, policyVersion))
    .limit(HEARTBEAT_TRIAGE_READOUT_ROW_LIMIT);
}

export function buildOrganizerTasksQuery(taskIds: string[]) {
  return db
    .select({
      id: tasks.id,
      structuredOutput: sql<unknown>`${tasks.result}->'structuredOutput'`,
      childCount: sql<number>`(select count(*)::int from ${tasks} c where c.parent_task_id = ${tasks.id})`,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));
}

export function buildOrganizerCostQuery(taskIds: string[]) {
  return db
    .select({ taskId: workers.taskId, costUsd: sql<string>`sum(${workers.costUsd})` })
    .from(workers)
    .where(inArray(workers.taskId, taskIds))
    .groupBy(workers.taskId);
}

export async function runHeartbeatTriageReadout(
  experiment: { id: string; policyVersion: number },
  opts: { minSamplePerArm: number; waitMinConfidence: number },
): Promise<HeartbeatTriageReadout> {
  const looks = (await buildTriageLooksQuery(experiment.id, experiment.policyVersion)) as TriageLookRow[];
  const taskIds = [...new Set(looks.map(l => l.taskId).filter((id): id is string => !!id))];
  const outcomes = new Map<string, OrganizerOutcome>();
  if (taskIds.length > 0) {
    const [organizers, costs] = await Promise.all([buildOrganizerTasksQuery(taskIds), buildOrganizerCostQuery(taskIds)]);
    const costBy = new Map(costs.map(c => [c.taskId, Number(c.costUsd)]));
    for (const t of organizers) {
      const c = costBy.get(t.id);
      outcomes.set(t.id, { acted: organizerActed(t), costUsd: c !== undefined && Number.isFinite(c) ? c : null });
    }
  }
  return computeHeartbeatTriageReadout(looks, outcomes, opts);
}
