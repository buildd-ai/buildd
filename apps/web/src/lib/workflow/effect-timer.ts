/**
 * The timer for the workflow outbox: an effect whose `not_before` is reached is drained within a
 * tick of it. Nothing else wakes a due row: the control plane's floor runs hourly, and the inline
 * drains run only when some other command touches the delivery. A refresh parked behind the
 * landing lane (a backstop of minutes) or backed off after a failure therefore waited for the next
 * unrelated drain, and the lane's serial refresh-after-landing turned each wait into the next PR's.
 *
 * A Redis due-queue (`buildd:due:kernel-effects`, lib/redis.ts) holds delivery ids scored by their
 * earliest due effect. `drainDelivery` publishes after each drain (what it parked, backed off or
 * woke, including the lane waiter a landing just freed); the control plane's per-minute cron
 * (apps/control-plane/wrangler.jsonc) reads it and drains exactly those deliveries. An idle minute
 * reads Redis only. A dropped ZADD costs one floor interval, never the effect: the floor still
 * drains every due row.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { clearDue, countDue, listDue, markDueEarliest } from '@/lib/redis';
import type { Exec } from './kernel';

export const EFFECT_DUE_QUEUE = 'kernel-effects';
/** The cron's period: a due effect is drained within this of its not_before. */
export const EFFECT_TICK_MS = 60_000;
const BATCH = 20;
/** The tick's whole share (the control plane's scheduled handler has minutes; a drain is seconds). */
export const EFFECT_TICK_BUDGET_MS = 45_000;

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/**
 * Queue this delivery for its earliest pending effect (or expired lease). Earliest wins, so a
 * busy delivery cannot keep pushing its own drain back. Never throws: the floor is the backstop.
 */
export async function scheduleEffectDrain(deliveryId: string, exec: Exec = dbExec, now = Date.now()): Promise<void> {
  try {
    const row = ((await exec(sql`-- workflow:next_effect_due
SELECT (EXTRACT(EPOCH FROM min(CASE WHEN status = 'pending' THEN not_before ELSE lease_until END)) * 1000)::bigint AS due_ms
FROM workflow_effects
WHERE delivery_id = ${deliveryId}::uuid AND (status = 'pending' OR (status = 'delivering' AND lease_until IS NOT NULL))`)).rows ?? [])[0] as { due_ms?: string | number | null } | undefined;
    if (row?.due_ms == null) return;
    await markDueEarliest(EFFECT_DUE_QUEUE, deliveryId, Math.max(Number(row.due_ms), now));
  } catch (err) {
    console.error(`[workflow] effect timer schedule for ${deliveryId} failed:`, err);
  }
}

export interface EffectTickDeps {
  /** Drains one delivery where the kernel is hosted (seam `drainDelivery`). */
  drain: (deliveryId: string) => Promise<unknown>;
  now?: () => number;
  clock?: () => number;
  budgetMs?: number;
}

export interface EffectTickResult { due: number; drained: number; failed: number; deferred: number }

/** The cron tick: drain every delivery whose effect is due, under a budget. Null when Redis could not answer. */
export async function runDueEffectDrains(deps: EffectTickDeps): Promise<EffectTickResult | null> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? EFFECT_TICK_BUDGET_MS;
  const now = deps.now?.() ?? Date.now();
  const out: EffectTickResult = { due: 0, drained: 0, failed: 0, deferred: 0 };
  const count = await countDue(EFFECT_DUE_QUEUE, now);
  if (count === null) return null;
  if (count === 0) return out;
  const ids = await listDue(EFFECT_DUE_QUEUE, now, BATCH);
  out.due = ids.length;
  for (const id of ids) {
    if (clock() - started >= budget) { out.deferred++; continue; }
    // Claimed first; `drainDelivery` re-publishes whatever it leaves pending.
    await clearDue(EFFECT_DUE_QUEUE, id);
    try {
      await deps.drain(id);
      out.drained++;
    } catch (err) {
      out.failed++;
      console.error(`[workflow] timed drain of delivery ${id} failed:`, err);
      await markDueEarliest(EFFECT_DUE_QUEUE, id, now + EFFECT_TICK_MS).catch(() => {});
    }
  }
  return out;
}
