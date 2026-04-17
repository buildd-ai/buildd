/**
 * Routing analytics — records per-task outcomes so the calibration cron
 * can measure whether the router's model choice matched reality.
 *
 * Called from the worker completion path. The write is non-fatal: a failure
 * here must never block the worker status update.
 *
 * See plans/buildd/smart-model-routing.md (Phase 5) for the aggregation that
 * consumes these rows.
 */

import { db } from './db';
import { taskOutcomes, tasks } from './db/schema';
import { eq } from 'drizzle-orm';

export interface TaskOutcomeInput {
  taskId: string;
  accountId?: string | null;
  outcome: 'completed' | 'failed';
  actualModel?: string | null;
  totalCostUsd?: number | string | null;
  totalTurns?: number | null;
  durationMs?: number | null;
  wasRetried?: boolean;
}

/**
 * Record an outcome row for a finished task. Reads kind/complexity/
 * predictedModel/classifiedBy from the task row so callers don't have
 * to duplicate that state.
 *
 * Returns `true` if a row was written, `false` otherwise. Errors are
 * swallowed and logged — this is best-effort telemetry.
 */
export async function recordTaskOutcome(input: TaskOutcomeInput): Promise<boolean> {
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, input.taskId),
      columns: {
        id: true,
        kind: true,
        complexity: true,
        classifiedBy: true,
        predictedModel: true,
      },
    });
    if (!task) return false;

    // Skip tasks that never went through the router (legacy/untagged).
    if (!task.predictedModel) return false;

    const downshifted = detectDownshift(task.kind, task.complexity, task.predictedModel);

    await db.insert(taskOutcomes).values({
      taskId: input.taskId,
      accountId: input.accountId ?? null,
      kind: task.kind ?? null,
      complexity: task.complexity ?? null,
      classifiedBy: task.classifiedBy ?? null,
      predictedModel: task.predictedModel ?? null,
      actualModel: input.actualModel ?? null,
      downshifted,
      outcome: input.outcome,
      totalCostUsd: input.totalCostUsd != null ? String(input.totalCostUsd) : null,
      totalTurns: input.totalTurns ?? null,
      durationMs: input.durationMs ?? null,
      wasRetried: input.wasRetried ?? false,
    });
    return true;
  } catch (err) {
    console.warn('[routing-analytics] recordTaskOutcome failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Was the predicted model below the matrix baseline for this kind/complexity?
 * Mirrors the BASELINE table in model-router.ts.
 */
const BASELINE_ORDER = ['haiku', 'sonnet', 'opus'] as const;
type Tier = (typeof BASELINE_ORDER)[number];

const BASELINE: Record<string, Record<string, Tier>> = {
  coordination: { simple: 'opus', normal: 'opus', complex: 'opus' },
  engineering: { simple: 'haiku', normal: 'sonnet', complex: 'opus' },
  research: { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  writing: { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  design: { simple: 'sonnet', normal: 'opus', complex: 'opus' },
  analysis: { simple: 'haiku', normal: 'sonnet', complex: 'sonnet' },
  observation: { simple: 'haiku', normal: 'haiku', complex: 'haiku' },
};

function detectDownshift(
  kind: string | null,
  complexity: string | null,
  predicted: string,
): boolean {
  if (!kind || !complexity) return false;
  const baseline = BASELINE[kind]?.[complexity];
  if (!baseline) return false;
  // Only meaningful when predicted is an alias we can compare. Full IDs (from
  // explicit overrides) are never counted as downshifted.
  if (!BASELINE_ORDER.includes(predicted as Tier)) return false;
  return BASELINE_ORDER.indexOf(predicted as Tier) < BASELINE_ORDER.indexOf(baseline);
}
