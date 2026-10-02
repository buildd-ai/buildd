/**
 * Question gate: the stores half (see ./question-gate.ts for the design).
 *
 * Two reads and one write, all keyed by team or task:
 *  - the team's running `question_gate` experiment (cached 60s);
 *  - the task's arm, drawn deterministically from that row;
 *  - one content-free record per check, appended to the task's
 *    `experiment_assignments` row (created on the first check), so the
 *    generic readout already has the arm and this kind's outcomes beside it.
 *    No new table: the records live in that row's `eligibility` JSON under
 *    `questionGateChecks`, next to the config the arm was judged with.
 *
 * **Nothing here may fail a question.** Every entry point catches and logs; a
 * failed lookup reads as "no experiment", which sends the question unchanged.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { experimentAssignments, experiments } from './db/schema';
import {
  QUESTION_GATE_EXPERIMENT_KIND,
  decideQuestionGateArm,
  type QuestionGateArmDecision,
  type QuestionGateCheckRecord,
  type QuestionGateExperimentRow,
} from './question-gate';

const EXPERIMENT_TTL_MS = 60_000;
const cache = new Map<string, { at: number; row: QuestionGateExperimentRow | null }>();

export function invalidateQuestionGateExperimentCache(teamId?: string): void {
  if (teamId) cache.delete(teamId);
  else cache.clear();
}

/** WHERE clause for "the team's running question-gate experiment". */
export function runningQuestionGateScope(teamId: string) {
  return and(
    eq(experiments.teamId, teamId),
    eq(experiments.status, 'running'),
    eq(experiments.kind, QUESTION_GATE_EXPERIMENT_KIND),
  );
}

async function loadRunning(teamId: string): Promise<QuestionGateExperimentRow | null> {
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < EXPERIMENT_TTL_MS) return hit.row;
  const rows = await db
    .select({
      id: experiments.id, kind: experiments.kind, status: experiments.status,
      treatmentFraction: experiments.treatmentFraction, policyVersion: experiments.policyVersion,
      config: experiments.config, startedAt: experiments.startedAt,
    })
    .from(experiments)
    .where(runningQuestionGateScope(teamId));
  rows.sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const row = rows[0] ?? null;
  cache.set(teamId, { at: Date.now(), row });
  return row;
}

/** The task's arm under the team's running experiment, or null (gate off). Never throws. */
export async function resolveQuestionGateArm(teamId: string | null | undefined, taskId: string | null | undefined): Promise<QuestionGateArmDecision | null> {
  if (!teamId || !taskId) return null;
  try {
    const experiment = await loadRunning(teamId);
    return experiment ? decideQuestionGateArm(experiment, taskId) : null;
  } catch (e) {
    console.warn('[question-gate] experiment lookup failed; gate off:', e);
    return null;
  }
}

/** The upsert for one check: the assignment row on first sight, the record appended after. */
export function questionGateCheckUpsert(arm: QuestionGateArmDecision, taskId: string, record: QuestionGateCheckRecord) {
  return db
    .insert(experimentAssignments)
    .values({
      experimentId: arm.experimentId,
      taskId,
      unitType: 'task',
      unitId: taskId,
      arm: arm.arm,
      propensity: arm.propensity,
      policyVersion: arm.policyVersion,
      served: true,
      eligibility: {
        minConfidence: arm.minConfidence,
        maxPushbacks: arm.maxPushbacks,
        questionGateChecks: [record],
      },
    })
    .onConflictDoUpdate({
      target: [experimentAssignments.experimentId, experimentAssignments.taskId],
      set: {
        eligibility: sql`${experimentAssignments.eligibility} || jsonb_build_object('questionGateChecks', coalesce(${experimentAssignments.eligibility}->'questionGateChecks', '[]'::jsonb) || ${JSON.stringify([record])}::jsonb)`,
      },
    });
}

/** Record one check. Never throws. */
export async function recordQuestionGateCheck(arm: QuestionGateArmDecision, taskId: string, record: QuestionGateCheckRecord): Promise<void> {
  try {
    await questionGateCheckUpsert(arm, taskId, record);
  } catch (e) {
    console.error('[question-gate] failed to record check:', e);
  }
}
