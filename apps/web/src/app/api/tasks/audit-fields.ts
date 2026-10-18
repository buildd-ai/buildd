import { sql } from 'drizzle-orm';
import { artifacts, tasks, workers } from '@buildd/core/db/schema';
import { TASKS_TABLE_REF, taskPrNumberSql } from '@/lib/workflow/task-pr';

/**
 * Deliverable-attribution columns for the terminal-status audit list
 * (`GET /api/tasks?status=completed|failed|cancelled&limit=N`).
 */
export const terminalAuditFields = {
  updatedAt: tasks.updatedAt,
  roleSlug: tasks.roleSlug,
  creationSource: tasks.creationSource,
  summarySource: sql<string | null>`${tasks.result}->>'summarySource'`,
  // Audit mode reaches the entire terminal history, unbounded by the
  // 24h window every other query path stays inside — including tasks
  // completed before this field's shape was settled. A bare ::int
  // cast throws and kills the whole query the moment one historical
  // row has a non-numeric value here, so guard it instead of trusting
  // the shape.
  // The task's PR derived on read (workflow/task-pr.ts): its delivery, its attempt's worker row,
  // else the stored result, whose non-numeric values the fragment already reads as none. The
  // literal "tasks" alias for the same reason as hasArtifact below.
  prNumber: taskPrNumberSql(TASKS_TABLE_REF),
  // Literal "tasks"."id", not ${tasks.id}: a single-table select renders its
  // select-list columns unqualified, and a bare "id" here is ambiguous against
  // w.id / a.id — which 500'd every audit list.
  hasArtifact: sql<boolean>`EXISTS (
    SELECT 1 FROM ${workers} w
    JOIN ${artifacts} a ON a.worker_id = w.id
    WHERE w.task_id = "tasks"."id"
  )`,
};
