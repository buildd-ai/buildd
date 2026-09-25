import { db } from '@buildd/core/db';
import { workspaces, teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { CriteriaGrader } from '@buildd/shared';
import { asCriteriaGrader } from './mission-criteria-grader';

export type EvaluationStrategy = 'inline' | 'worker';

const CODE_DEFAULT: EvaluationStrategy = 'inline';

/**
 * Resolve which evaluator runs LLM-graded and command criteria for a mission.
 *
 * Resolution chain (first non-null wins):
 *   1. workspaces.criteriaEvaluationStrategy  (workspace-level override)
 *   2. teams.criteriaEvaluationStrategy        (team-wide default)
 *   3. CODE_DEFAULT = 'inline'
 *
 * Mirrors the model-tier-registry pattern so one mechanism handles all
 * team/workspace-level config rather than two diverging resolution paths.
 */
export async function resolveEvaluationStrategy(
  teamId: string,
  workspaceId?: string | null,
): Promise<EvaluationStrategy> {
  if (workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { criteriaEvaluationStrategy: true, teamId: true },
    });
    if (ws?.criteriaEvaluationStrategy) {
      return ws.criteriaEvaluationStrategy as EvaluationStrategy;
    }
  }

  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { criteriaEvaluationStrategy: true },
  });
  if (team?.criteriaEvaluationStrategy) {
    return team.criteriaEvaluationStrategy as EvaluationStrategy;
  }

  return CODE_DEFAULT;
}

// ── Prose criterion grader ────────────────────────────────────────────────────

/**
 * The workspace's configured prose grader (`gitConfig.criteriaGrader`), or null.
 *
 * Lives in the existing `gitConfig` jsonb bag — where `defaultBackend` and
 * `maxBudgetUsd` already live — so it needs no column and is already writable
 * via PATCH /api/workspaces/[id] (MCP `manage_workspaces gitConfig={…}`). An
 * unrecognised value is ignored rather than trusted.
 */
export async function resolveWorkspaceCriteriaGrader(workspaceId?: string | null): Promise<CriteriaGrader | null> {
  if (!workspaceId) return null;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { gitConfig: true },
  });
  return asCriteriaGrader((ws?.gitConfig as Record<string, unknown> | null | undefined)?.criteriaGrader);
}
