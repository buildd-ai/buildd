/**
 * Subject prior work injection — §7 of docs/design/task-subject-anchors.md.
 *
 * For tasks with a subject anchor, builds a bounded "Subject prior work" block
 * from other tasks anchored to the same subject. Injected into the worker's
 * context providers at claim time so the agent knows what work already exists
 * before branching or implementing.
 *
 * Gated by subjectPolicy.priorWorkInjection (default true). Best-effort: any
 * DB error returns null so the claim still succeeds without the block.
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, ne } from 'drizzle-orm';

const MAX_SIBLING_TASKS = 5;
const MAX_CHARS = 2000;

export type PriorWorkTask = {
  id: string;
  workspaceId: string;
  subjectKind?: string | null;
  subjectPrNumber?: number | null;
  subjectErrorSignature?: string | null;
  subjectMissionId?: string | null;
};

export type PriorWorkPolicy = {
  priorWorkInjection: boolean;
};

/**
 * Build a bounded "Subject prior work" context block for a claimed task.
 *
 * Returns null when:
 * - priorWorkInjection is disabled in the workspace subjectPolicy
 * - the task has no subject anchor
 * - no sibling tasks share the anchor
 * - the DB query fails (best-effort, never throws)
 */
export async function buildSubjectPriorWork(
  task: PriorWorkTask,
  policy: PriorWorkPolicy,
): Promise<string | null> {
  if (!policy.priorWorkInjection) return null;
  if (!task.subjectKind) return null;

  try {
    let siblingTasks: Array<{
      id: string;
      title: string;
      status: string;
      workers: Array<{
        branch: string;
        prNumber: number | null;
        prLifecycleStatus: string | null;
        mergedAt: Date | null;
      }>;
    }> = [];

    if (task.subjectKind === 'pull_request' && task.subjectPrNumber) {
      siblingTasks = await db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, task.workspaceId),
          eq(tasks.subjectPrNumber, task.subjectPrNumber),
          ne(tasks.id, task.id),
        ),
        columns: { id: true, title: true, status: true },
        with: {
          workers: {
            columns: { branch: true, prNumber: true, prLifecycleStatus: true, mergedAt: true },
            limit: 1,
            orderBy: (w, { desc }) => [desc(w.createdAt)],
          },
        },
        limit: MAX_SIBLING_TASKS,
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
    } else if (task.subjectKind === 'error' && task.subjectErrorSignature) {
      const rows = await db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, task.workspaceId),
          eq(tasks.subjectErrorSignature, task.subjectErrorSignature),
          ne(tasks.id, task.id),
        ),
        columns: { id: true, title: true, status: true },
        limit: MAX_SIBLING_TASKS,
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      siblingTasks = rows.map(r => ({ ...r, workers: [] }));
    } else if (task.subjectKind === 'mission' && task.subjectMissionId) {
      const rows = await db.query.tasks.findMany({
        where: and(
          eq(tasks.workspaceId, task.workspaceId),
          eq(tasks.subjectMissionId, task.subjectMissionId),
          ne(tasks.id, task.id),
        ),
        columns: { id: true, title: true, status: true },
        limit: MAX_SIBLING_TASKS,
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      siblingTasks = rows.map(r => ({ ...r, workers: [] }));
    }

    if (siblingTasks.length === 0) return null;

    const subjectLabel =
      task.subjectKind === 'pull_request'
        ? `PR #${task.subjectPrNumber}`
        : task.subjectKind === 'error'
        ? `error ${task.subjectErrorSignature}`
        : `mission ${task.subjectMissionId?.slice(0, 8)}`;

    const lines: string[] = [
      `## Subject prior work (${subjectLabel})`,
      '',
      'Other tasks anchored to this subject — verify before re-implementing or branching:',
      '',
    ];

    for (const sibling of siblingTasks) {
      lines.push(`- [${sibling.status}] ${sibling.title}`);
      const w = sibling.workers?.[0];
      if (w?.prNumber) {
        lines.push(
          `  PR #${w.prNumber}${w.prLifecycleStatus ? ` (${w.prLifecycleStatus})` : ''}`,
        );
      }
      if (w?.branch) {
        lines.push(`  Branch: ${w.branch}`);
      }
      if (w?.mergedAt) {
        lines.push(`  Merged: ${new Date(w.mergedAt).toISOString()}`);
      }
    }

    const result = lines.join('\n');
    return result.length > MAX_CHARS
      ? `${result.slice(0, MAX_CHARS)}\n[truncated]`
      : result;
  } catch (err) {
    console.warn('[claim] subject-prior-work lookup failed:', err);
    return null;
  }
}
