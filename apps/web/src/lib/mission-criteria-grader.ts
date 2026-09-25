import type { CriteriaGrader } from '@buildd/shared';

/**
 * Which grader a prose (`description`) criterion uses. Pure — no DB, no
 * credentials — so the evaluator and its tests share one rule.
 *
 * Resolution: the criterion's own `grader` > the workspace's
 * `gitConfig.criteriaGrader` > `auto`. `auto` is settled later by the evaluator
 * from whether the inference client finds a key for the team (see
 * `mission-criteria-eval.ts`); this module never looks at credentials.
 */

export type { CriteriaGrader };

const GRADERS: readonly string[] = ['auto', 'api', 'runner'];

/** A recognised grader value, or null. Unknown values are ignored, never trusted. */
export function asCriteriaGrader(value: unknown): CriteriaGrader | null {
  return typeof value === 'string' && GRADERS.includes(value) ? (value as CriteriaGrader) : null;
}

export function pickCriteriaGrader(
  criterion: { grader?: unknown } | null | undefined,
  workspaceGrader: CriteriaGrader | null,
): CriteriaGrader {
  return asCriteriaGrader(criterion?.grader) ?? workspaceGrader ?? 'auto';
}
