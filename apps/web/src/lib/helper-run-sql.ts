import { sql, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';

/**
 * A helper run in SQL (`isHelperRun`, packages/core/mission-helpers.ts): the
 * surface audit, a criterion check, a final verification. It feeds its
 * mission's Verify and is never an Activity root (spec d25d923d R-12).
 */
export function helperRunSql(): SQL<boolean> {
  return sql<boolean>`(${tasks.title} like '[surface audit]%' or ${tasks.roleSlug} = 'visual-auditor'
    or jsonb_exists(${tasks.context}::jsonb, 'specCriterionCheck') or jsonb_exists(${tasks.context}::jsonb, 'finalVerification'))`;
}


/**
 * The task a helper run checks, in SQL (`verifyHostOf`): a criterion check's
 * subject, a spec repair's filer, an attempt's parent. Null for a helper that
 * belongs to its mission (the surface audit, final verification).
 */
export function helperHostTaskSql(): SQL<string | null> {
  return sql<string | null>`coalesce(${tasks.context}->'specCriterionCheck'->>'subjectTaskId', ${tasks.context}->'specRepair'->>'filedBy',
    case when ${tasks.taskClass} = 'attempt' then ${tasks.parentTaskId}::text end)`;
}
