/**
 * Dependency waits in the gate ledger (spec: Overlap scheduling, AC-10;
 * Health › Queue, R-5).
 *
 * The dependency gate is part of the claim's candidate WHERE, so a task it
 * holds never reaches the claim loop and was never recorded: nothing said how
 * long a task had waited on its dependency. On every broad claim poll, the
 * tasks in the caller's reach that ONLY the dependency gate kept out of the
 * candidate query (every other gate of the same WHERE passes) get a
 * `claim_loop_deferral` / `deps_blocked` row, coalesced like every other
 * deferral (`recordOrCoalesceDeferral`): one row per wait with a
 * `consecutiveDeferrals` counter and a `firstDeferredAt` that survives every
 * poll, so the wait is measurable.
 *
 * Bounded (`DEPS_BLOCKED_SCAN_LIMIT` per poll, claim order) and written after
 * the response: it never slows or changes a claim. A dependency wait is the
 * dependency's own slowness, so the stranded sweep and the mission header's
 * "claim loop keeps refusing" warning leave these rows out.
 */
import { and, asc, desc, inArray, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type { RecordGateEventInput } from '@buildd/core/gate-events';
import type { ClaimGateName } from '@/lib/claim-candidate-where';
import { claimOrderBy } from '@/lib/claim-order';

/** The ledger reason a dependency wait is recorded under (the explicit-claim exclusion code, too). */
export const DEPS_BLOCKED_REASON = 'deps_blocked';

/** At most this many dependency waits are recorded per poll. */
export const DEPS_BLOCKED_SCAN_LIMIT = 25;

/**
 * The WHERE for "only the dependency gate refuses it": in reach, pending, the
 * dependency gate failing (NULL counts as failing, as in the WHERE) and every
 * other gate of the same candidate WHERE passing. Null when the claim applied
 * no dependency gate (a force claim), so there is nothing to record.
 */
export function depsBlockedWhere(workspaceIds: string[], gates: Partial<Record<ClaimGateName, SQL>>): SQL | null {
  const deps = gates.deps;
  if (!deps || workspaceIds.length === 0) return null;
  const others = (Object.entries(gates) as Array<[ClaimGateName, SQL | undefined]>)
    .filter(([name, g]) => name !== 'deps' && !!g)
    .map(([, g]) => g!);
  return and(
    inArray(tasks.workspaceId, workspaceIds),
    sql`${tasks.status} = 'pending'`,
    not(sql`COALESCE((${deps}), false)`),
    ...others,
  )!;
}

/** The ledger row for one dependency wait. */
export function depsBlockedEvent(row: { id: string; workspaceId: string; missionId: string | null }): RecordGateEventInput {
  return {
    gate: GATE_SLUGS.CLAIM_LOOP_DEFERRAL,
    surface: 'POST /api/workers/claim',
    outcome: 'deferred',
    reason: DEPS_BLOCKED_REASON,
    workspaceId: row.workspaceId,
    missionId: row.missionId,
    taskId: row.id,
    callerOrigin: 'worker',
    detail: { gate: 'deps' },
  };
}

/**
 * Record this poll's dependency waits. Best-effort: a failed read records
 * nothing. `fire` is the coalescing writer (`fireDeferralEvent`).
 */
export async function recordDepsBlocked(input: {
  workspaceIds: string[];
  gates: Partial<Record<ClaimGateName, SQL>>;
  fire: (event: RecordGateEventInput) => void;
}): Promise<number> {
  try {
    const where = depsBlockedWhere(input.workspaceIds, input.gates);
    if (!where) return 0;
    const rows = await db
      .select({ id: tasks.id, workspaceId: tasks.workspaceId, missionId: tasks.missionId })
      .from(tasks)
      .where(where)
      .orderBy(...claimOrderBy(tasks, { desc, asc }))
      .limit(DEPS_BLOCKED_SCAN_LIMIT);
    for (const r of rows) input.fire(depsBlockedEvent(r));
    return rows.length;
  } catch (err) {
    console.warn('[claim] dependency-wait ledger read failed:', (err as Error)?.message ?? err);
    return 0;
  }
}
