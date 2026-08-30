import { db } from '@buildd/core/db';
import { workspaces, teams } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

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
