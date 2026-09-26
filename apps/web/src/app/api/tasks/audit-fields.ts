import { sql } from 'drizzle-orm';
import { artifacts, tasks, workers } from '@buildd/core/db/schema';

/**
 * Deliverable-attribution columns for the terminal-status audit list
 * (`GET /api/tasks?status=completed|failed|cancelled&limit=N`).
 */
export const terminalAuditFields = {
  updatedAt: tasks.updatedAt,
  summarySource: sql<string | null>`${tasks.result}->>'summarySource'`,
  // Audit mode reaches the entire terminal history, unbounded by the
  // 24h window every other query path stays inside — including tasks
  // completed before this field's shape was settled. A bare ::int
  // cast throws and kills the whole query the moment one historical
  // row has a non-numeric value here, so guard it instead of trusting
  // the shape.
  prNumber: sql<number | null>`(CASE WHEN ${tasks.result}->>'prNumber' ~ '^[0-9]+$' THEN (${tasks.result}->>'prNumber')::int ELSE NULL END)`,
  // Literal "tasks"."id", not ${tasks.id}: a single-table select renders its
  // select-list columns unqualified, and a bare "id" here is ambiguous against
  // w.id / a.id — which 500'd every audit list.
  hasArtifact: sql<boolean>`EXISTS (
    SELECT 1 FROM ${workers} w
    JOIN ${artifacts} a ON a.worker_id = w.id
    WHERE w.task_id = "tasks"."id"
  )`,
};
