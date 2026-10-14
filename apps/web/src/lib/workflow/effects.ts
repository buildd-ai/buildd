/**
 * Effect runner for the workflow outbox (docs/specs/workflow-state-kernel.md
 * §10). Rows are inserted by the statement that applied their transition
 * (kernel.ts); this drains them at least once, mirroring task_dispatch_outbox:
 * claim due rows with FOR UPDATE SKIP LOCKED, lease them, run the handler,
 * ack; failures back off 15s doubling to 30m and go `dead` at 8 attempts.
 *
 * Read-your-write (§7.5, §10.4): before a gated handler runs, the effect's
 * transition must still describe the delivery (same version, or the same
 * state); otherwise the effect is done as `skipped:superseded`.
 *
 * The kill switch (§14): an effect claimed for a delivery the kernel no longer
 * owns (released to legacy, or in a workspace whose switch is off — read from
 * `Policy` by the drain, not by the claim — which the drain releases there and
 * then) still drains, except the kinds in
 * `KERNEL_ONLY_EFFECTS`: those act on GitHub for the kernel's own landing and
 * repair loop (the merge, a branch refresh, a renumber push, push recovery)
 * and are done as `skipped:legacy_owns`. Whatever a draining handler then
 * reports back is refused by `applyCommand` (`legacy_owns`), so no drained
 * effect starts a new kernel decision.
 *
 * Handlers live in handlers.ts; seam.ts drains a delivery's effects at the end
 * of the request that applied its transition, and the pr-reconcile cron drains
 * whatever is still due.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { drainEffects, effectRetry, EFFECT_LEASE_MS, type DeadEffect, type DrainSummary, type EffectHandlers } from '@buildd/workflow-kernel/effects';
import type { EffectKind } from './commands';
import type { Policy } from '@buildd/workflow-kernel/ports';
import type { Exec } from './kernel';

// The outbox rules (lease, backoff, dead-lettering, §10.4 gating, the §14
// kernel-only kinds) and the drain loop are the package's; this file keeps
// the Postgres statements the drain runs through `postgresStore`.
export {
  CRITICAL_EFFECTS, EFFECT_LEASE_MS, EFFECT_MAX_ATTEMPTS, KERNEL_ONLY_EFFECTS, UNGATED_EFFECTS, effectBackoffMs, effectIsCurrent,
  type DeadEffect, type DrainSummary, type EffectHandler, type EffectHandlers,
} from '@buildd/workflow-kernel/effects';
export type { ClaimedEffect } from '@buildd/workflow-kernel/ports';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export function claimDueEffectsSql(limit: number, leaseMs = EFFECT_LEASE_MS, deliveryId?: string | null): SQL {
  return sql`-- workflow:claim_effects
WITH due AS (
  SELECT id FROM workflow_effects
  WHERE ((status = 'pending' AND not_before <= now())
     OR (status = 'delivering' AND lease_until < now()))
    ${deliveryId ? sql`AND delivery_id = ${deliveryId}::uuid` : sql``}
  ORDER BY not_before, id
  LIMIT ${limit}::int
  FOR UPDATE SKIP LOCKED
),
claimed AS (
UPDATE workflow_effects e
SET status = 'delivering', attempt_count = e.attempt_count + 1,
    lease_until = now() + make_interval(secs => ${leaseMs}::int / 1000.0), updated_at = now()
FROM due
WHERE e.id = due.id
RETURNING e.id, e.delivery_id, e.transition_id, e.kind, e.dedupe_key, e.payload, e.attempt_count, e.not_before,
  ${effectSnapshotSql()}
)
-- RETURNING order is unspecified: run the batch in the order it was claimed.
SELECT * FROM claimed ORDER BY not_before, id`;
}

/**
 * What a runner re-checks before acting: the delivery (with its workspace), the
 * authority its own row records, and the queuing transition. The kill switch is
 * not read here: the drain asks `Policy` for the delivery's workspace (§14).
 */
function effectSnapshotSql(): SQL {
  return sql`(SELECT jsonb_build_object('state', d.state, 'version', d.version, 'workspace_id', d.workspace_id) FROM workflow_deliveries d WHERE d.id = e.delivery_id) AS delivery,
  (SELECT d.authority FROM workflow_deliveries d WHERE d.id = e.delivery_id) AS authority,
  (SELECT jsonb_build_object('to_state', tr.to_state, 'to_version', tr.to_version) FROM workflow_transitions tr WHERE tr.id = e.transition_id) AS transition`;
}

/**
 * §10.3: a batch is claimed under one lease, but each row is renewed for
 * itself just before its handler runs, and only while this drain's attempt
 * still holds it (`attempt_count` is the fence). No row back means another
 * drain re-claimed it after the batch lease ran out: skip it. The returned
 * snapshot is read now, not at claim time, so §10.4 re-checks the delivery
 * as it is when the handler starts.
 */
export function renewEffectLeaseSql(id: string, attemptCount: number, leaseMs = EFFECT_LEASE_MS): SQL {
  return sql`-- workflow:renew_effect
UPDATE workflow_effects e
SET lease_until = now() + make_interval(secs => ${leaseMs}::int / 1000.0), updated_at = now()
WHERE e.id = ${id}::uuid AND e.status = 'delivering' AND e.attempt_count = ${attemptCount}::int
RETURNING e.id, e.attempt_count,
  ${effectSnapshotSql()}`;
}

/** Settles only the attempt that ran: a stale drain's ack cannot settle a re-claimed attempt. */
export function ackEffectSql(id: string, attemptCount: number, outcome: string): SQL {
  return sql`-- workflow:ack_effect
UPDATE workflow_effects SET status = 'done', outcome = ${outcome.slice(0, 200)}::text, lease_until = NULL, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering' AND attempt_count = ${attemptCount}::int
RETURNING id`;
}

export function failEffectSql(id: string, error: string, attemptCount: number): SQL {
  const { dead, retryInMs } = effectRetry(attemptCount);
  return sql`-- workflow:fail_effect
UPDATE workflow_effects
SET status = ${dead ? 'dead' : 'pending'}::text,
    last_error = ${error.slice(0, 500)}::text,
    not_before = now() + make_interval(secs => ${retryInMs}::int / 1000.0),
    lease_until = NULL, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering' AND attempt_count = ${attemptCount}::int
RETURNING id, status`;
}

/**
 * Puts a claimed row back to `pending`, due after `delayMs`, and hands its
 * claim back (`attempt_count - 1`): a wait is not a failure, so it neither
 * backs off nor counts toward `dead`. Fenced to the attempt that ran, like ack.
 */
export function parkEffectSql(id: string, attemptCount: number, outcome: string, delayMs: number): SQL {
  return sql`-- workflow:park_effect
UPDATE workflow_effects
SET status = 'pending', attempt_count = GREATEST(attempt_count - 1, 0), outcome = ${outcome.slice(0, 200)}::text,
    not_before = now() + make_interval(secs => ${delayMs}::int / 1000.0),
    lease_until = NULL, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering' AND attempt_count = ${attemptCount}::int
RETURNING id`;
}

/** What runs for each effect that just went dead. Default: dead-effects.ts escalation + gate event. */
export type OnDeadEffect = (dead: DeadEffect, exec: Exec) => Promise<void>;

const defaultOnDead: OnDeadEffect = async (dead, exec) => {
  await (await import('./dead-effects')).escalateDeadEffect(dead, exec);
};

/** Drain up to `limit` due effects once (the package's `drainEffects` on the Postgres store). Handlers MUST be idempotent (§10.2). */
export async function runEffects(opts: { handlers: EffectHandlers; limit?: number; exec?: Exec; deliveryId?: string | null; onDead?: OnDeadEffect; policy?: Policy }): Promise<DrainSummary> {
  const exec = opts.exec ?? dbExec;
  const onDead = opts.onDead ?? defaultOnDead;
  // Loaded on use: the adapter imports every statement module, this one included.
  const { postgresStore } = await import('./postgres-store');
  const policy = opts.policy ?? (await import('./kernel-policy')).builddPolicy(exec);
  return drainEffects(postgresStore(exec), {
    handlers: opts.handlers,
    policy,
    limit: opts.limit ?? 25,
    deliveryId: opts.deliveryId ?? null,
    leaseMs: EFFECT_LEASE_MS,
    onDead: (dead) => onDead(dead, exec),
  });
}

/**
 * A follow-up of an effect that is still running its course (the next
 * `push_recovery` try): recorded against the same transition, idempotent on
 * its own dedupe key. Not a decision: the transition that owes it already
 * committed.
 */
export function insertFollowupEffectSql(e: {
  deliveryId: string; transitionId: string; kind: EffectKind; dedupeKey: string; payload: Record<string, unknown>; delayMs?: number;
}): SQL {
  return sql`-- workflow:followup_effect
INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, not_before)
VALUES (${e.deliveryId}::uuid, ${e.transitionId}::uuid, ${e.kind}::text, ${e.dedupeKey}::text, ${JSON.stringify(e.payload)}::jsonb,
  now() + make_interval(secs => ${e.delayMs ?? 0}::bigint / 1000.0))
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING id`;
}
