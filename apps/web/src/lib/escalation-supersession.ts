import { missionNotes, tasks } from '@buildd/core/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

type CoreDbModule = typeof import('@buildd/core/db');
type SupersessionDb = Pick<CoreDbModule['db'], 'query' | 'update'>;

/**
 * Transfer every still-live escalation in a retry's ancestry to its successor.
 *
 * Only open notes are updated. That predicate is what makes an arbitrary retry
 * chain generation-safe: retry #2 supersedes retry #1, while the original note
 * remains historically pointed at retry #1 instead of being rewritten.
 */
export async function supersedeAncestorEscalations(
  database: SupersessionDb,
  parentTaskId: string | null | undefined,
  successorPrNumber: number,
): Promise<void> {
  if (!parentTaskId) return;

  const ancestorTaskIds: string[] = [];
  const visited = new Set<string>();
  let taskId: string | null = parentTaskId;

  while (taskId && !visited.has(taskId)) {
    visited.add(taskId);
    ancestorTaskIds.push(taskId);
    const parent: { parentTaskId: string | null } | undefined = await database.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { parentTaskId: true },
    });
    taskId = parent?.parentTaskId ?? null;
  }

  await database
    .update(missionNotes)
    .set({
      status: 'superseded',
      supersededByPrNumber: successorPrNumber,
    })
    .where(and(
      inArray(missionNotes.taskId, ancestorTaskIds),
      eq(missionNotes.type, 'reviewer_escalated'),
      eq(missionNotes.status, 'open'),
    ));
}
