/**
 * The assessment a Start anyway task's agent records before it edits
 * (Living Spec 36df686b R-4, AC-9): what it needs from each prerequisite,
 * what can proceed, what is unknown and its next step. Saved on the task's
 * `context.startAnyway` lifecycle (@buildd/core/start-anyway), shown on the
 * task, carried into a resumed attempt, and required before the task takes
 * file ownership (`startAnywayEditRefusal` in @buildd/core/start-anyway, read
 * by the path-claim check).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { OPEN_TASK_STATUSES } from '@buildd/shared';
import {
  START_ANYWAY_CONTEXT_KEY,
  parseAssessment,
  readStartAnyway,
  recordAssessment,
  type Assessment,
} from '@buildd/core/start-anyway';

export type SaveAssessmentResult =
  | { ok: true; assessment: Assessment }
  | { ok: false; status: number; code: string; error: string };

export async function saveStartAnywayAssessment(i: { taskId: string; raw: unknown; workerId: string | null }): Promise<SaveAssessmentResult> {
  const parsed = parseAssessment(i.raw);
  if (!parsed.ok) return { ok: false, status: 400, code: 'invalid_assessment', error: parsed.error };
  const [row] = await db.select({ context: tasks.context, status: tasks.status }).from(tasks).where(eq(tasks.id, i.taskId)).limit(1);
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'Task not found' };
  const record = readStartAnyway(row.context as Record<string, unknown> | null);
  if (!record) {
    return { ok: false, status: 409, code: 'not_started_anyway', error: 'This task was not started anyway past a prerequisite, so it has no assessment to record. Report progress with message instead.' };
  }
  const next = recordAssessment(record, parsed.assessment, new Date(), i.workerId);
  // Compare-and-set on the lifecycle: a park or a new request in between wins.
  const [updated] = await db.update(tasks)
    .set({
      context: sql`jsonb_set(COALESCE(${tasks.context}, '{}'::jsonb), ${`{${START_ANYWAY_CONTEXT_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(tasks.id, i.taskId),
      inArray(tasks.status, [...OPEN_TASK_STATUSES]),
      sql`${tasks.context}->${START_ANYWAY_CONTEXT_KEY}->>'intentId' = ${record.intentId}`,
    ))
    .returning({ id: tasks.id });
  if (!updated) return { ok: false, status: 409, code: 'changed', error: 'The task finished or its start changed while the assessment was being saved; read the task again.' };
  return { ok: true, assessment: parsed.assessment };
}
