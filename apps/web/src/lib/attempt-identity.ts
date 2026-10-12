/**
 * What an ATTEMPT inherits from the task it re-attempts.
 *
 * A request-changes fix, a CI retry and a conflict retry are all the same unit
 * of work run again, and they are created by three different modules. Each
 * used to copy only the mission phase, so the retry silently lost:
 *   - `backend` — a Codex task's fix ran on Claude (the column default);
 *   - `roleSlug` — the claim route's runner filter and the role persona;
 *   - `kind` / `complexity` — the inputs model routing keys off, so the retry
 *     routed to a different model tier than the attempt it continues.
 *
 *   - `delegation` — a person's cross-workspace grant
 *     (packages/core/token-delegation.ts), so a retry would hit the wall its
 *     parent was granted past.
 *
 * One read, one shape, spread into every attempt insert. The phase half is
 * the same rule as `inheritPhaseFromParent` (Rule P1-7).
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { normalizeTaskKind } from '@buildd/core/model-router';
import { inheritTaskDelegation, type TaskDelegation } from '@buildd/core/token-delegation';

type TaskRow = typeof tasks.$inferSelect;

export interface AttemptIdentity {
  /** Absent when the parent is unreadable, so the column default applies. */
  backend?: TaskRow['backend'];
  roleSlug: string | null;
  kind: TaskRow['kind'] | null;
  complexity: TaskRow['complexity'] | null;
  missionPhaseIndex: number | null;
  missionPhaseLabel: string | null;
  /** Present only when the parent carries a grant (and its id is known). */
  delegation?: TaskDelegation;
}

/** The identity columns of a parent task, as far as they are known. */
export interface AttemptParent {
  backend?: TaskRow['backend'] | null;
  roleSlug?: string | null;
  kind?: TaskRow['kind'] | null;
  complexity?: TaskRow['complexity'] | null;
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
  id?: string | null;
  delegation?: unknown;
}

/** Pure: the identity an attempt at `parent` carries. */
export function attemptIdentityFrom(parent: AttemptParent | null | undefined): AttemptIdentity {
  // The two phase columns are CHECK-paired: both set or both null.
  const phaseSet = parent?.missionPhaseIndex != null && parent?.missionPhaseLabel != null;
  const delegation = parent?.id ? inheritTaskDelegation({ id: parent.id, delegation: parent.delegation }) : null;
  return {
    ...(parent?.backend ? { backend: parent.backend } : {}),
    roleSlug: parent?.roleSlug ?? null,
    // Normalized so a stored out-of-vocabulary kind is not copied forward.
    kind: normalizeTaskKind(parent?.kind),
    complexity: parent?.complexity ?? null,
    missionPhaseIndex: phaseSet ? parent!.missionPhaseIndex! : null,
    missionPhaseLabel: phaseSet ? parent!.missionPhaseLabel! : null,
    ...(delegation ? { delegation } : {}),
  };
}

/** Read the parent task and return the identity an attempt at it inherits. */
export async function inheritAttemptIdentity(parentTaskId: string | null | undefined): Promise<AttemptIdentity> {
  if (!parentTaskId) return attemptIdentityFrom(null);
  const parent = await db.query.tasks.findFirst({
    where: eq(tasks.id, parentTaskId),
    columns: {
      backend: true,
      roleSlug: true,
      kind: true,
      complexity: true,
      missionPhaseIndex: true,
      missionPhaseLabel: true,
      id: true,
      delegation: true,
    },
  });
  return attemptIdentityFrom(parent ?? null);
}
