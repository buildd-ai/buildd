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
 * One read, one shape, spread into every attempt insert. The phase half is
 * the same rule as `inheritPhaseFromParent` (Rule P1-7).
 */

import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

type TaskRow = typeof tasks.$inferSelect;

export interface AttemptIdentity {
  /** Absent when the parent is unreadable, so the column default applies. */
  backend?: TaskRow['backend'];
  roleSlug: string | null;
  kind: TaskRow['kind'] | null;
  complexity: TaskRow['complexity'] | null;
  missionPhaseIndex: number | null;
  missionPhaseLabel: string | null;
}

/** The identity columns of a parent task, as far as they are known. */
export interface AttemptParent {
  backend?: TaskRow['backend'] | null;
  roleSlug?: string | null;
  kind?: TaskRow['kind'] | null;
  complexity?: TaskRow['complexity'] | null;
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
}

/** Pure: the identity an attempt at `parent` carries. */
export function attemptIdentityFrom(parent: AttemptParent | null | undefined): AttemptIdentity {
  // The two phase columns are CHECK-paired: both set or both null.
  const phaseSet = parent?.missionPhaseIndex != null && parent?.missionPhaseLabel != null;
  return {
    ...(parent?.backend ? { backend: parent.backend } : {}),
    roleSlug: parent?.roleSlug ?? null,
    kind: parent?.kind ?? null,
    complexity: parent?.complexity ?? null,
    missionPhaseIndex: phaseSet ? parent!.missionPhaseIndex! : null,
    missionPhaseLabel: phaseSet ? parent!.missionPhaseLabel! : null,
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
    },
  });
  return attemptIdentityFrom(parent ?? null);
}
