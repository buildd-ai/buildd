/**
 * A fix attempt that ended by asking a person (a question, or a post_note
 * question with no default) cannot be answered by claiming it again: the next
 * worker would reach the same question. The claim holds it until the note is
 * answered, and the delivery view (`ownerQuestion` on the attempt) shows the
 * PR as waiting on the person meanwhile.
 */
import { db } from '@buildd/core/db';
import { missionNotes } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

/** The open blocking question a task's workers raised, or null. Fails open: a read error never holds a claim. */
export async function openOwnerQuestion(taskId: string): Promise<string | null> {
  try {
    const note = await db.query.missionNotes.findFirst({
      where: sqlWhere(and(
        eq(missionNotes.taskId, taskId),
        eq(missionNotes.type, 'question'),
        eq(missionNotes.status, 'open'),
        isNull(missionNotes.defaultChoice),
        or(isNull(missionNotes.disposition), eq(missionNotes.disposition, 'ask')),
      )),
      columns: { title: true, body: true },
      orderBy: sqlOrderBy([desc(missionNotes.createdAt)]),
    });
    if (!note) return null;
    return (note.body?.trim() || note.title).slice(0, 500);
  } catch (err) {
    console.warn(`[claim] owner-question read failed for task ${taskId}; not holding it:`, err instanceof Error ? err.message : err);
    return null;
  }
}
