/**
 * Which spec scopes a new spec may take (Living Specs D-45).
 *
 * The `mission` scope is retired: a mission is work, not intent, so it selects
 * an existing spec as its outcome and never has one written for it (D-41).
 * Existing mission-scope specs stay readable and fileable; only new ones,
 * including copies, are refused. The column keeps the value, so no migration.
 */
import { SPEC_SCOPES, type SpecScope } from '@buildd/core/db/schema';

export const RETIRED_SPEC_SCOPES: readonly SpecScope[] = ['mission'];

/** The scopes `create_draft` accepts. */
export const CREATABLE_SPEC_SCOPES: readonly SpecScope[] = SPEC_SCOPES.filter((s) => !RETIRED_SPEC_SCOPES.includes(s));

/** Why a new spec may not take `scope`, or null when it may. */
export function specScopeRefusal(scope: unknown): string | null {
  if (RETIRED_SPEC_SCOPES.includes(scope as SpecScope)) {
    return 'scope mission is retired: a mission selects an existing spec as its outcome (manage_missions outcomeSpec) ' +
      'and never has one written for it. Write new intent as a revision of the feature or area spec that owns it, ' +
      `or as a new spec with one of: ${CREATABLE_SPEC_SCOPES.join(', ')}`;
  }
  if (!CREATABLE_SPEC_SCOPES.includes(scope as SpecScope)) return `scope must be one of: ${CREATABLE_SPEC_SCOPES.join(', ')}`;
  return null;
}
