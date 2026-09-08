import type { GoalCriterion } from '@buildd/shared';
import { criterionLabel } from './goal-criterion-label';

/**
 * Where "File the work" on the decision sheet sends the owner: the existing
 * task composer (`/app/tasks/new`), scoped to the mission and prefilled with
 * the failing criterion — not a new form. Creating a task against this
 * mission is what actually resolves the escalation server-side (see
 * POST /api/tasks), so this link is the entire client-side implementation of
 * that exit.
 */
export function buildFileWorkHref(input: {
  missionId: string;
  missionTitle: string | null;
  criterion: GoalCriterion | null;
  evidence?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('missionId', input.missionId);
  const label = input.criterion ? criterionLabel(input.criterion) : null;
  params.set('title', label ? `Fix goal criterion: ${label}` : `File missing work for ${input.missionTitle ?? 'mission'}`);
  const descriptionParts = [
    label ? `Goal criterion blocking this mission: ${label}` : null,
    input.evidence ? `Evidence: ${input.evidence}` : null,
  ].filter(Boolean);
  if (descriptionParts.length > 0) {
    params.set('description', descriptionParts.join('\n\n'));
  }
  return `/app/tasks/new?${params.toString()}`;
}
