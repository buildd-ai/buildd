/**
 * Heartbeat-triage experiment: the stores half, called from the schedules
 * cron (apps/web/src/app/api/cron/schedules/route.ts) around each triage look.
 *
 * **Nothing here may fail a cycle.** Every entry point catches and logs; a
 * lookup failure reads as "no experiment", which is shadow, which dispatches
 * the organizer exactly as it runs without triage.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments, heartbeatTriageLooks } from './db/schema';
import {
  HEARTBEAT_TRIAGE_EXPERIMENT_KIND,
  decideHeartbeatTriageArm,
  type HeartbeatTriageArmDecision,
  type HeartbeatTriageExperimentRow,
} from './heartbeat-triage-experiment';

const EXPERIMENT_TTL_MS = 60_000;
const cache = new Map<string, { at: number; row: HeartbeatTriageExperimentRow | null }>();

export function invalidateHeartbeatTriageExperimentCache(teamId?: string): void {
  if (teamId) cache.delete(teamId);
  else cache.clear();
}

/** WHERE clause for "the team's running heartbeat-triage experiment". */
export function runningHeartbeatTriageScope(teamId: string) {
  return and(
    eq(experiments.teamId, teamId),
    eq(experiments.status, 'running'),
    eq(experiments.kind, HEARTBEAT_TRIAGE_EXPERIMENT_KIND),
  );
}

async function loadRunning(teamId: string): Promise<HeartbeatTriageExperimentRow | null> {
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < EXPERIMENT_TTL_MS) return hit.row;
  const rows = await db
    .select({
      id: experiments.id, kind: experiments.kind, status: experiments.status,
      treatmentFraction: experiments.treatmentFraction, policyVersion: experiments.policyVersion,
      config: experiments.config, startedAt: experiments.startedAt,
    })
    .from(experiments)
    .where(runningHeartbeatTriageScope(teamId));
  rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const row = rows[0] ?? null;
  cache.set(teamId, { at: Date.now(), row });
  return row;
}

/** The mission's arm under the team's running experiment, or null (shadow). Never throws. */
export async function resolveHeartbeatTriageArm(teamId: string, missionId: string): Promise<HeartbeatTriageArmDecision | null> {
  try {
    const experiment = await loadRunning(teamId);
    return experiment ? decideHeartbeatTriageArm(experiment, missionId) : null;
  } catch (e) {
    console.warn('[heartbeat-triage-experiment] lookup failed; shadow:', e);
    return null;
  }
}

export interface TriageLookInput {
  missionId: string;
  scheduleId: string | null;
  /** The organizer task this cycle dispatched; null when the look skipped it. */
  taskId: string | null;
  arm: HeartbeatTriageArmDecision | null;
  promptVersion: string;
  model: string | null;
  pick: 'wait' | 'act' | null;
  confidence: number | null;
  skipped: boolean;
  reason: string | null;
}

/**
 * Record one look. A dispatched cycle in an experiment also records the
 * mission's assignment (once per experiment and mission; the arm is
 * deterministic, so a lost race writes the same arm twice at worst). Never throws.
 */
export async function recordHeartbeatTriageLook(input: TriageLookInput): Promise<void> {
  try {
    await db.insert(heartbeatTriageLooks).values({
      missionId: input.missionId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      experimentId: input.arm?.experimentId ?? null,
      policyVersion: input.arm?.policyVersion ?? null,
      arm: input.arm?.arm ?? null,
      promptVersion: input.promptVersion,
      model: input.model,
      pick: input.pick,
      confidence: input.confidence,
      skipped: input.skipped,
      reason: input.reason,
    });
    // An assignment row needs a task (experiment_assignments_task_or_message):
    // the first dispatched organizer task carries the mission's.
    if (input.arm && input.taskId) {
      const existing = await db
        .select({ id: experimentAssignments.id })
        .from(experimentAssignments)
        .where(heartbeatTriageAssignmentScope(input.arm.experimentId, input.missionId))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(experimentAssignments).values({
          experimentId: input.arm.experimentId,
          taskId: input.taskId,
          unitType: 'mission',
          unitId: input.missionId,
          arm: input.arm.arm,
          propensity: input.arm.propensity,
          policyVersion: input.arm.policyVersion,
          served: true,
          eligibility: { waitMinConfidence: input.arm.waitMinConfidence },
        }).onConflictDoNothing();
      }
    }
  } catch (e) {
    console.error('[heartbeat-triage-experiment] failed to record look:', e);
  }
}

/** WHERE clause for "this mission's assignment in this experiment". */
export function heartbeatTriageAssignmentScope(experimentId: string, missionId: string) {
  return and(
    eq(experimentAssignments.experimentId, experimentId),
    eq(experimentAssignments.unitType, 'mission'),
    eq(experimentAssignments.unitId, missionId),
  );
}
