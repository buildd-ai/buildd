import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { TaskEvidence, TaskMismatch } from '@buildd/shared';
import { collectLineage } from '@/lib/attempt-lineage';
import { evidenceHint } from '@/lib/task-evidence';

export interface PrAttempt {
  taskId: string;
  title: string;
  status: string;
  prNumber: number | null;
  evidence: { errorClass: string; keyLines: string[] } | null;
  mismatch: TaskMismatch[];
}

const COLUMNS = { id: true, title: true, status: true, taskClass: true, parentTaskId: true, result: true, createdAt: true } as const;
const WORKER_WITH = { columns: { prNumber: true }, limit: 1 } as const;

interface Row {
  id: string;
  title: string;
  status: string;
  taskClass: string | null;
  parentTaskId: string | null;
  result: unknown;
  createdAt: Date | null;
  workers?: Array<{ prNumber: number | null }>;
}

/**
 * The fix attempts (`after CI #N` / `after review #N`) in the chain the task
 * behind a PR belongs to, oldest first, each with its errorClass and first key
 * lines. The chain's root is not an attempt and is left out; a PR opened on a
 * new branch after a failed resume is in the chain and shows its own number.
 */
export async function loadPrAttempts(taskId: string | null | undefined): Promise<PrAttempt[]> {
  if (!taskId) return [];
  const rows = await collectLineage<Row>(taskId, {
    fetchTask: async (id) =>
      ((await db.query.tasks.findFirst({
        where: eq(tasks.id, id),
        columns: COLUMNS,
        with: { workers: WORKER_WITH },
      })) as unknown as Row | undefined) ?? null,
    fetchChildren: async (parentIds) =>
      (await db.query.tasks.findMany({
        where: inArray(tasks.parentTaskId, parentIds),
        columns: COLUMNS,
        with: { workers: WORKER_WITH },
      })) as unknown as Row[],
  });
  return rows
    .filter(t => t.taskClass === 'attempt')
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map(t => {
      const result = (t.result ?? null) as { evidence?: TaskEvidence; mismatch?: TaskMismatch[] } | null;
      return {
        taskId: t.id,
        title: t.title,
        status: t.status,
        prNumber: t.workers?.[0]?.prNumber ?? null,
        evidence: evidenceHint(result?.evidence),
        mismatch: Array.isArray(result?.mismatch) ? result.mismatch : [],
      };
    });
}
