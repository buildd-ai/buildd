/**
 * The assessment a Start anyway task's agent records before it edits (Living
 * Spec 36df686b R-4, AC-9): what it needs from each prerequisite, what can
 * proceed, what is unknown and its next step. `update_progress { assessment }`
 * lands here. It is saved beside the claim-time brief, read back by a resume,
 * and required before the task takes file ownership
 * (`startAnywayEditRefusal` in @buildd/core/start-anyway, read by the
 * path-claim check).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import {
  START_ANYWAY_ASSESSED_KEY,
  START_ANYWAY_BRIEF_KEY,
  parseAssessment,
  type AssessmentFields,
} from '@buildd/core/start-anyway';

export type SaveAssessmentResult =
  | { ok: true; assessment: AssessmentFields }
  | { ok: false; status: number; code: string; error: string };

export async function saveStartAnywayAssessment(i: { taskId: string; raw: unknown; workerId: string | null }): Promise<SaveAssessmentResult> {
  const parsed = parseAssessment(i.raw);
  if (!parsed.ok) return { ok: false, status: 400, code: 'invalid_assessment', error: parsed.error };
  const at = new Date();
  const record = { assessment: parsed.assessment, at: at.toISOString(), workerId: i.workerId };
  // Only a task whose claim stored a Start anyway brief, and only while it is open.
  const [updated] = await db.update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), ${`{${START_ANYWAY_ASSESSED_KEY}}`}::text[], ${JSON.stringify(record)}::jsonb)`,
      updatedAt: at,
    })
    .where(and(
      eq(tasks.id, i.taskId),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      sql`${tasks.context} ? ${START_ANYWAY_BRIEF_KEY}`,
    ))
    .returning({ id: tasks.id });
  if (!updated) {
    return {
      ok: false, status: 409, code: 'not_started_anyway',
      error: 'This task is not an open task started before its prerequisites finished, so it has no assessment to record. Report progress with message instead.',
    };
  }
  return { ok: true, assessment: parsed.assessment };
}
