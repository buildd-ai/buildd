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
 * DARK: no handler is registered by any route or cron yet.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import type { EffectKind } from './commands';
import type { Exec } from './kernel';
import type { DeliveryState } from './types';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export const EFFECT_LEASE_MS = 120_000;
export const EFFECT_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** Effects whose permanent failure escalates the delivery (§10.3). */
export const CRITICAL_EFFECTS: ReadonlySet<EffectKind> = new Set(['merge_call', 'push_recovery', 'post_review']);

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
}

/** §10.4: does the transition that queued this effect still describe the delivery? */
export function effectIsCurrent(e: Pick<ClaimedEffect, 'kind' | 'delivery' | 'transition'>): boolean {
  if (UNGATED_EFFECTS.has(e.kind)) return true;
  if (!e.delivery || !e.transition) return false;
  if (e.delivery.version === e.transition.toVersion) return true;
  return e.delivery.state === e.transition.toState;
}

export function claimDueEffectsSql(limit: number, leaseMs = EFFECT_LEASE_MS): SQL {
  return sql`-- workflow:claim_effects
WITH due AS (
  SELECT id FROM workflow_effects
  WHERE (status = 'pending' AND not_before <= now())
     OR (status = 'delivering' AND lease_until < now())
  ORDER BY not_before
  LIMIT ${limit}::int
  FOR UPDATE SKIP LOCKED
)
UPDATE workflow_effects e
SET status = 'delivering', attempt_count = e.attempt_count + 1,
    lease_until = now() + make_interval(secs => ${leaseMs}::int / 1000.0), updated_at = now()
FROM due
WHERE e.id = due.id
RETURNING e.id, e.delivery_id, e.transition_id, e.kind, e.dedupe_key, e.payload, e.attempt_count,
  (SELECT jsonb_build_object('state', d.state, 'version', d.version) FROM workflow_deliveries d WHERE d.id = e.delivery_id) AS delivery,
  (SELECT jsonb_build_object('to_state', tr.to_state, 'to_version', tr.to_version) FROM workflow_transitions tr WHERE tr.id = e.transition_id) AS transition`;
}

export function ackEffectSql(id: string, outcome: string): SQL {
  return sql`-- workflow:ack_effect
UPDATE workflow_effects SET status = 'done', outcome = ${outcome.slice(0, 200)}::text, lease_until = NULL, updated_at = now()
WHERE id = ${id}::uuid AND status = 'delivering'
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
WHERE id = ${id}::uuid AND status = 'delivering'
RETURNING id, status`;
}

export type EffectHandler = (e: ClaimedEffect) => Promise<{ outcome?: string } | void>;
export type EffectHandlers = Partial<Record<EffectKind, EffectHandler>>;

export interface DrainSummary {
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  /** Effects that went dead; `critical` ones are the caller's to escalate (§10.3). */
  dead: Array<{ id: string; deliveryId: string; kind: EffectKind; critical: boolean }>;
}

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
  };
}

/** Drain up to `limit` due effects once. Handlers MUST be idempotent (§10.2). */
export async function runEffects(opts: { handlers: EffectHandlers; limit?: number; exec?: Exec }): Promise<DrainSummary> {
  const exec = opts.exec ?? dbExec;
  const rows = ((await exec(claimDueEffectsSql(opts.limit ?? 25))).rows ?? []) as Array<Record<string, unknown>>;
  const summary: DrainSummary = { claimed: rows.length, done: 0, skipped: 0, failed: 0, dead: [] };
  for (const raw of rows) {
    const e = toClaimed(raw);
    if (!effectIsCurrent(e)) {
      await exec(ackEffectSql(e.id, 'skipped:superseded'));
      summary.skipped++;
      continue;
    }
    const handler = opts.handlers[e.kind];
    try {
      if (!handler) throw new Error(`no handler for ${e.kind}`);
      const res = await handler(e);
      const outcome = (res && res.outcome) || 'ok';
      await exec(ackEffectSql(e.id, outcome));
      if (outcome.startsWith('skipped')) summary.skipped++; else summary.done++;
    } catch (err) {
      const r = ((await exec(failEffectSql(e.id, String((err as Error)?.message ?? err), e.attemptCount))).rows ?? [])[0] as { status?: string } | undefined;
      if (r?.status === 'dead') summary.dead.push({ id: e.id, deliveryId: e.deliveryId, kind: e.kind, critical: CRITICAL_EFFECTS.has(e.kind) });
      else summary.failed++;
    }
  }
  return summary;
}
