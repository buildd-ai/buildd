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
 * owns (released to legacy, or in a workspace whose switch is off, which the
 * claim releases there and then) still drains, except the kinds in
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
import type { EffectKind } from './commands';
import type { Exec } from './kernel';
import type { DeliveryState } from './types';
import { kernelOnSql, releaseSql } from './authority';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export const EFFECT_LEASE_MS = 120_000;
export const EFFECT_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Effects whose permanent failure escalates the delivery (§10.3): the spec's
 * three, plus the ones whose state has no other exit while they are dead
 * (`verify_merge` holds LANDING; the dispatches hold CHANGES_REQUESTED and
 * AWAITING_REVIEW, and the floor never re-owes a key that exists).
 */
export const CRITICAL_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'merge_call', 'verify_merge', 'push_recovery', 'post_review', 'dispatch_fix', 'dispatch_review',
]);

/**
 * Effects that stay true whatever the delivery did since: projections,
 * notifications, post-merge work, read-only verification, cancellations.
 * Everything else (dispatch, merge, push, refresh) acts only while its
 * transition still describes the delivery.
 */
export const UNGATED_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'render_activity', 'stamp_pr_rows', 'notify', 'mission_note', 'wake_mission', 'release_attribution',
  'finalize_mission_pr', 'emit_pr_merged', 'verify_merge', 'cancel_open_attempts', 'scan_supersession',
  'project_supersession', 'post_review', 'escalate_exhaustion', 'gate_event',
]);

/**
 * Effects that act on GitHub or the PR branch on the kernel's behalf, whose
 * answer only the kernel can read (a merge answered `behind` becomes a
 * refresh, a refresh becomes a new head). Once a delivery is legacy's they
 * never run: an emergency rollback must be able to stop a merge (§14). The
 * other kinds drain: projections and notifications, and the dispatches, which
 * file legacy-shaped review and fix tasks for decisions already committed
 * (skipping a committed `dispatch_review` would strand the PR with no
 * reviewer).
 */
export const KERNEL_ONLY_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'merge_call', 'refresh_branch', 'renumber_migration', 'push_recovery',
]);

export function effectBackoffMs(attemptCount: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1), BACKOFF_CAP_MS);
}

export interface ClaimedEffect {
  id: string;
  deliveryId: string;
  transitionId: string;
  kind: EffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  delivery: { state: DeliveryState; version: number } | null;
  transition: { toState: DeliveryState; toVersion: number } | null;
  /**
   * Who decides for the delivery, read in the claiming statement: `kernel`,
   * `legacy` (released), or `switched_off` (kernel row in a workspace whose
   * kill switch is off; the runner releases it before acting).
   */
  authority?: 'kernel' | 'legacy' | 'switched_off';
}

/** §10.4: does the transition that queued this effect still describe the delivery? */
export function effectIsCurrent(e: Pick<ClaimedEffect, 'kind' | 'delivery' | 'transition'>): boolean {
  if (UNGATED_EFFECTS.has(e.kind)) return true;
  if (!e.delivery || !e.transition) return false;
  if (e.delivery.version === e.transition.toVersion) return true;
  return e.delivery.state === e.transition.toState;
}

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

/** What a runner re-checks before acting: the delivery, who decides for it, and the queuing transition. */
function effectSnapshotSql(): SQL {
  return sql`(SELECT jsonb_build_object('state', d.state, 'version', d.version) FROM workflow_deliveries d WHERE d.id = e.delivery_id) AS delivery,
  (SELECT CASE WHEN d.authority = 'legacy' THEN 'legacy' WHEN ${kernelOnSql(sql`w.git_config`)} THEN 'kernel' ELSE 'switched_off' END
     FROM workflow_deliveries d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = e.delivery_id) AS authority,
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
  const dead = attemptCount >= EFFECT_MAX_ATTEMPTS;
  return sql`-- workflow:fail_effect
UPDATE workflow_effects
SET status = ${dead ? 'dead' : 'pending'}::text,
    last_error = ${error.slice(0, 500)}::text,
    not_before = now() + make_interval(secs => ${effectBackoffMs(attemptCount)}::int / 1000.0),
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

/**
 * `park`: the handler cannot act yet and nothing is wrong (the landing lane is
 * held). The row stays pending without spending an attempt; see `parkEffectSql`.
 */
export type EffectHandler = (e: ClaimedEffect) => Promise<{ outcome?: string; park?: { delayMs: number } } | void>;
export type EffectHandlers = Partial<Record<EffectKind, EffectHandler>>;

export interface DrainSummary {
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  /** Claimed in this batch but re-claimed by another drain before their turn (batch lease ran out): not run here. */
  lost: number;
  /** Effects that went dead; `critical` ones were escalated through `onDead` (§10.3). */
  dead: DeadEffect[];
}

export interface DeadEffect { id: string; deliveryId: string; kind: EffectKind; critical: boolean; dedupeKey: string; lastError: string }

/** What runs for each effect that just went dead. Default: dead-effects.ts escalation + gate event. */
export type OnDeadEffect = (dead: DeadEffect, exec: Exec) => Promise<void>;

const defaultOnDead: OnDeadEffect = async (dead, exec) => {
  await (await import('./dead-effects')).escalateDeadEffect(dead, exec);
};

function toClaimed(r: Record<string, unknown>): ClaimedEffect {
  const d = r.delivery as { state?: string; version?: number | string } | null;
  const t = r.transition as { to_state?: string; to_version?: number | string } | null;
  return {
    id: String(r.id),
    deliveryId: String(r.delivery_id),
    transitionId: String(r.transition_id),
    kind: r.kind as EffectKind,
    dedupeKey: String(r.dedupe_key),
    payload: (r.payload as Record<string, unknown>) ?? {},
    attemptCount: Number(r.attempt_count ?? 0),
    delivery: d && d.state ? { state: d.state as DeliveryState, version: Number(d.version) } : null,
    transition: t && t.to_state ? { toState: t.to_state as DeliveryState, toVersion: Number(t.to_version) } : null,
    authority: r.authority === 'legacy' || r.authority === 'switched_off' ? r.authority : 'kernel',
  };
}

/** The claimed row with the delivery, authority and transition re-read when its lease was renewed. */
function withSnapshot(e: ClaimedEffect, renewed: Record<string, unknown>): ClaimedEffect {
  const fresh = toClaimed({ ...renewed, delivery_id: e.deliveryId, transition_id: e.transitionId, kind: e.kind, dedupe_key: e.dedupeKey, payload: e.payload });
  return { ...e, delivery: fresh.delivery, transition: fresh.transition, authority: fresh.authority };
}

/** Keeps a running handler's lease alive (fenced to its attempt), so a slow handler is not re-claimed under it. */
async function withLeaseHeartbeat<T>(exec: Exec, e: ClaimedEffect, run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    exec(renewEffectLeaseSql(e.id, e.attemptCount)).catch((err) => console.error(`[workflow] renewing lease of effect ${e.id} (${e.kind}) failed:`, err));
  }, EFFECT_LEASE_MS / 3);
  (timer as { unref?: () => void }).unref?.();
  try { return await run(); } finally { clearInterval(timer); }
}

/** Drain up to `limit` due effects once. Handlers MUST be idempotent (§10.2). */
export async function runEffects(opts: { handlers: EffectHandlers; limit?: number; exec?: Exec; deliveryId?: string | null; onDead?: OnDeadEffect }): Promise<DrainSummary> {
  const exec = opts.exec ?? dbExec;
  const onDead = opts.onDead ?? defaultOnDead;
  const rows = ((await exec(claimDueEffectsSql(opts.limit ?? 25, EFFECT_LEASE_MS, opts.deliveryId ?? null))).rows ?? []) as Array<Record<string, unknown>>;
  const summary: DrainSummary = { claimed: rows.length, done: 0, skipped: 0, failed: 0, lost: 0, dead: [] };
  const released = new Set<string>();
  for (const raw of rows) {
    const claimed = toClaimed(raw);
    // §10.3: renew this row's lease, fenced to this attempt, before touching it. Nothing back
    // means the batch lease ran out and another drain holds the row now: its attempt answers.
    const renewed = ((await exec(renewEffectLeaseSql(claimed.id, claimed.attemptCount))).rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!renewed) {
      summary.lost++;
      continue;
    }
    const e = withSnapshot(claimed, renewed);
    if (e.authority === 'switched_off' && !released.has(e.deliveryId)) {
      // §14: the first kernel touch after switch-off releases the delivery (sticky).
      const rel = (await exec(releaseSql(e.deliveryId))).rows ?? [];
      if (rel.length) console.log(`[workflow] delivery ${e.deliveryId} released to legacy (workflowKernel kill switch, effect drain)`);
      released.add(e.deliveryId);
    }
    if (e.authority !== 'kernel' && KERNEL_ONLY_EFFECTS.has(e.kind)) {
      await exec(ackEffectSql(e.id, e.attemptCount, 'skipped:legacy_owns'));
      summary.skipped++;
      continue;
    }
    if (!effectIsCurrent(e)) {
      await exec(ackEffectSql(e.id, e.attemptCount, 'skipped:superseded'));
      summary.skipped++;
      continue;
    }
    const handler = opts.handlers[e.kind];
    try {
      if (!handler) throw new Error(`no handler for ${e.kind}`);
      const res = await withLeaseHeartbeat(exec, e, () => handler(e));
      const outcome = (res && res.outcome) || 'ok';
      if (res && res.park) {
        const parked = (await exec(parkEffectSql(e.id, e.attemptCount, outcome, res.park.delayMs))).rows ?? [];
        // Counted as skipped: it did nothing this pass, and it is still owed.
        if (!parked.length) summary.lost++; else summary.skipped++;
        continue;
      }
      const acked = (await exec(ackEffectSql(e.id, e.attemptCount, outcome))).rows ?? [];
      // A handler that outlived its lease (heartbeat lost) settles nothing: the re-claiming attempt answers.
      if (!acked.length) summary.lost++;
      else if (outcome.startsWith('skipped')) summary.skipped++; else summary.done++;
    } catch (err) {
      const lastError = String((err as Error)?.message ?? err);
      const r = ((await exec(failEffectSql(e.id, lastError, e.attemptCount))).rows ?? [])[0] as { status?: string } | undefined;
      if (!r) summary.lost++;
      else if (r.status === 'dead') {
        const dead: DeadEffect = { id: e.id, deliveryId: e.deliveryId, kind: e.kind, critical: CRITICAL_EFFECTS.has(e.kind), dedupeKey: e.dedupeKey, lastError: lastError.slice(0, 500) };
        summary.dead.push(dead);
        // §10.3: a dead effect is never left for someone to notice. Escalation failing must not
        // fail the drain: the row is dead either way, and the floor (enqueue-missing) still sees it.
        try { await onDead(dead, exec); } catch (escErr) { console.error(`[workflow] escalating dead effect ${e.id} (${e.kind}) failed:`, escErr); }
      } else summary.failed++;
    }
  }
  return summary;
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
