import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';
import { specCriteria, type RequirementRef } from '@buildd/spec-contract/requirements';
import { readPinnedSpecRevision } from './pin';

/**
 * A mission's outcome-spec selection, read without the mission module: the
 * spec page's delivery section (core) and the mission evaluator both use it.
 */

/** The `living_spec` goal criteria in a mission's goalCriteria. */
export const livingSpecCriteriaOf = (goalCriteria: unknown): LivingSpecGoalCriterion[] =>
  (Array.isArray(goalCriteria) ? (goalCriteria as GoalCriterion[]) : []).filter((c): c is LivingSpecGoalCriterion => c?.type === 'living_spec');

/** In-scope criteria of a selected revision: the narrowed set, else every R-n/AC-n. */
export async function selectedScope(c: LivingSpecGoalCriterion): Promise<{ ok: true; criteria: RequirementRef[]; title: string } | { ok: false; reason: string }> {
  const read = await readPinnedSpecRevision({ specId: c.specId, specRevisionId: c.specRevisionId, contentHash: c.contentHash });
  if (!read.ok) return { ok: false, reason: read.reason };
  const all = specCriteria(read.body);
  const narrowed = c.criteria && c.criteria.length > 0 ? new Set(c.criteria) : null;
  return { ok: true, criteria: narrowed ? all.filter((r) => narrowed.has(r.id)) : all, title: read.title };
}
