import { or, isNull, inArray, notInArray, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';

/**
 * Role-slug gate for the claim route.
 *
 * Two rules, applied together:
 *
 *   1. Explicit slugs (EXPLICIT_ROLE_SLUGS, e.g. 'visual-auditor') are opt-in.
 *      A task routed to one is claimable ONLY by a runner that lists that slug
 *      in `availableSkills`. An empty/omitted list no longer matches it.
 *   2. Every other slug keeps the legacy rule: an empty list claims anything,
 *      and a non-empty list of legacy slugs restricts claims to unrouted tasks
 *      plus those slugs.
 *
 * Rule 2 considers only the legacy part of the list, so a browser runner that
 * advertises just ['visual-auditor'] still claims builder/organizer/... tasks.
 * Folding the explicit slug into the old `IS NULL OR IN (list)` clause would
 * have stranded them.
 *
 * Returns clauses to AND into the claim's WHERE. `isRoleClaimable` is the JS
 * mirror; keep the two in step.
 */
export function roleSlugGate(availableSkills: readonly string[] | undefined): SQL[] {
  const skills = availableSkills ?? [];
  const explicit = skills.filter((s) => EXPLICIT_ROLE_SLUGS.includes(s));
  const legacy = skills.filter((s) => !EXPLICIT_ROLE_SLUGS.includes(s));

  // `IS NULL` is load-bearing: `NULL NOT IN (...)` is NULL, which would drop
  // every unrouted task.
  const clauses: SQL[] = [
    or(
      isNull(tasks.roleSlug),
      notInArray(tasks.roleSlug, [...EXPLICIT_ROLE_SLUGS]),
      ...(explicit.length > 0 ? [inArray(tasks.roleSlug, explicit)] : []),
    )!,
  ];

  if (legacy.length > 0) {
    // Explicit-slug tasks pass here so rule 1 alone decides them.
    clauses.push(
      or(
        isNull(tasks.roleSlug),
        inArray(tasks.roleSlug, [...EXPLICIT_ROLE_SLUGS]),
        inArray(tasks.roleSlug, legacy),
      )!,
    );
  }

  return clauses;
}

/** JS mirror of `roleSlugGate`: could a runner advertising `availableSkills` claim a task with `roleSlug`? */
export function isRoleClaimable(
  roleSlug: string | null | undefined,
  availableSkills: readonly string[] | undefined,
): boolean {
  if (!roleSlug) return true;
  const skills = availableSkills ?? [];
  if (EXPLICIT_ROLE_SLUGS.includes(roleSlug)) return skills.includes(roleSlug);
  const legacy = skills.filter((s) => !EXPLICIT_ROLE_SLUGS.includes(s));
  return legacy.length === 0 || legacy.includes(roleSlug);
}
