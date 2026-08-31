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
import { taskOutcomes } from './db/schema';
import { sql } from 'drizzle-orm';
import { reportOps } from './report-ops';
import { BASELINE, type Tier } from './model-router';

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
    // Use db.execute() with a raw SQL template to bypass Drizzle's query
    // builder entirely. The tasks table has workers relations (workers: many,
    // creatorWorker: one) and Drizzle 0.30.x has an intermittent bug where
    // even a plain db.select().from(tasks) can emit a reference to the
    // workers table without including it in the FROM clause, producing
    // "missing FROM-clause entry for table workers" errors. A raw sql template
    // literal contains no Drizzle table/column objects, so the bug cannot fire.
    const { rows } = await db.execute<{
      id: string;
      kind: string | null;
      complexity: string | null;
      classified_by: string | null;
      predicted_model: string | null;
    }>(sql`SELECT id, kind, complexity, classified_by, predicted_model FROM tasks WHERE id = ${input.taskId} LIMIT 1`);
    const task = rows[0];
    if (!task) return false;

    // Skip tasks that never went through the router (legacy/untagged).
    if (!task.predicted_model) return false;

    const downshifted = detectDownshift(task.kind, task.complexity, task.predicted_model);

    await db.insert(taskOutcomes).values({
      taskId: input.taskId,
      accountId: input.accountId ?? null,
      kind: task.kind ?? null,
      complexity: task.complexity ?? null,
      classifiedBy: task.classified_by ?? null,
      predictedModel: task.predicted_model ?? null,
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
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[routing-analytics] recordTaskOutcome failed:', msg);
    void reportOps({ source: 'routing-analytics', message: 'recordTaskOutcome failed', detail: msg });
    return false;
  }
}

/**
 * Was the predicted model below the matrix baseline for this kind/complexity?
 *
 * The baseline table is imported from model-router.ts — the router owns it. A
 * local copy drifted (it claimed coordination = opus/opus/opus while the router
 * says sonnet/sonnet/opus) and silently mis-flagged baseline coordination tasks.
 */
const BASELINE_ORDER = ['haiku', 'sonnet', 'opus'] as const;

/**
 * Normalise whatever the claim route stored in tasks.predicted_model onto the
 * router's tier order. The claim route writes the RESOLVED model id from the
 * tier registry (a full dated model id), and only falls back to a bare
 * alias when the task has no team, so both shapes must map.
 *
 * Returns null for anything with no tier equivalent (e.g. a Codex/GPT model id)
 * — those are not comparable to an Anthropic tier baseline and never counted.
 */
export function normalizeToTier(model: string): Tier | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  // Bare router aliases.
  if ((BASELINE_ORDER as readonly string[]).includes(id)) return id as Tier;
  // Tier vocabulary used by roles/task.tier.
  if (id === 'premium') return 'opus';
  if (id === 'standard') return 'sonnet';
  if (id === 'budget') return 'haiku';
  // Full Anthropic model ids.
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return null;
}

function detectDownshift(
  kind: string | null,
  complexity: string | null,
  predicted: string,
): boolean {
  if (!kind || !complexity) return false;
  const baseline = (BASELINE as Record<string, Record<string, Tier> | undefined>)[kind]?.[complexity];
  if (!baseline) return false;
  const predictedTier = normalizeToTier(predicted);
  if (!predictedTier) return false;
  return BASELINE_ORDER.indexOf(predictedTier) < BASELINE_ORDER.indexOf(baseline);
}
