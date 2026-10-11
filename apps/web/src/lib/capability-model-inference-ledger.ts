/**
 * The durable per-grant ledger behind `model.inference`
 * (`ModelInferenceLedger`, capability-model-inference.ts).
 *
 * Tables: `capability_grant_usage` (running totals per grant) and
 * `capability_grant_reservations` (one row per reserved call). No interactive
 * transactions (neon-http): every change is ONE statement.
 *
 *   reserve  INSERT … ON CONFLICT DO UPDATE … WHERE <headroom> bumps the totals
 *            and, in the same statement (a data-modifying CTE), writes the
 *            reservation row. The headroom predicate is `reserveRefusal` in
 *            SQL, evaluated against the row as locked, so N concurrent callers
 *            on one grant can never overdraw it. The source row is the grant
 *            itself, still granted, unrevoked and unexpired.
 *   settle   closes the open reservation and swaps its usd/tokens for the
 *            debit in the totals, freeing the in-flight slot. Idempotent: a
 *            reservation settles once.
 *   sweep    a reservation still open past STALE_RESERVATION_MS (the request
 *            crashed between reserve and settle) settles at its full
 *            reservation. Runs scoped to the grant before every reserve, so a
 *            crashed call can hold a concurrency slot for at most that window.
 *
 * Dollars are whole micro-dollars in the database; a provider cost rounds up.
 *
 * Spec: docs/specs/model-inference-agent-capability.md
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  reserveRefusal,
  type ModelInferenceBudget,
  type ModelInferenceLedger,
  type ModelInferenceReservation,
  type ModelInferenceSettlement,
  type ReserveRefusal,
} from './capability-model-inference';

/** Far beyond the longest call (MODEL_INFERENCE_LIMITS.maxTimeoutMs), so only a dead request is swept. */
export const STALE_RESERVATION_MS = 5 * 60_000;

const MICROS = 1_000_000;

/** A budget or reservation in micro-dollars. Budgets carry at most six decimals in practice. */
export const usdToMicros = (usd: number): number => Math.round(usd * MICROS);

/** A provider's reported cost in micro-dollars, rounded up: a debit never rounds to less. */
export const debitToMicros = (usd: number): number => Math.ceil(Math.round(usd * MICROS * 1000) / 1000);

type Row = Record<string, unknown>;
async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = await db.execute(query);
  return ((r as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * Settle every reservation left open past the stale window at its full
 * reservation (the debit equals what was reserved, so only the in-flight
 * count moves). Scoped to one grant, or all grants when none is given.
 * Returns how many were settled.
 */
export async function sweepStaleReservations(opts: { grantId?: string; olderThanMs?: number } = {}): Promise<number> {
  const ms = Math.max(0, Math.floor(opts.olderThanMs ?? STALE_RESERVATION_MS));
  const scope = opts.grantId ? sql`AND grant_id = ${opts.grantId}::uuid` : sql``;
  const out = await rows<{ k: number }>(sql`
    WITH stale AS (
      UPDATE capability_grant_reservations
      SET settled_at = now(), debit_usd_micros = usd_micros, debit_tokens = tokens, cost_source = 'reservation', outcome = 'stale'
      WHERE settled_at IS NULL AND reserved_at < now() - (${ms}::int * interval '1 millisecond') ${scope}
      RETURNING grant_id
    ), n AS (
      SELECT grant_id, count(*)::int AS k FROM stale GROUP BY grant_id
    )
    UPDATE capability_grant_usage u
    SET in_flight = GREATEST(u.in_flight - n.k, 0), updated_at = now()
    FROM n WHERE u.grant_id = n.grant_id
    RETURNING n.k`);
  return out.reduce((s, r) => s + Number(r.k), 0);
}

/** Why a reserve that wrote nothing was refused, read after the fact. */
async function classifyRefusal(r: ModelInferenceReservation, budget: ModelInferenceBudget): Promise<ReserveRefusal> {
  const [u] = await rows<{ calls: number; tokens: string | number; usd_micros: string | number; in_flight: number }>(sql`
    SELECT calls, tokens, usd_micros, in_flight FROM capability_grant_usage WHERE grant_id = ${r.grantId}::uuid`);
  const usage = {
    calls: Number(u?.calls ?? 0),
    tokens: Number(u?.tokens ?? 0),
    usd: Number(u?.usd_micros ?? 0) / MICROS,
    inFlight: Number(u?.in_flight ?? 0),
  };
  // No headroom rule explains it: the grant stopped being live under us (revoked,
  // expired), or a slot freed since. Either way nothing was reserved.
  return reserveRefusal(usage, budget, { usd: r.usd, tokens: r.tokens }) ?? 'ledger_unavailable';
}

export const modelInferenceLedger: ModelInferenceLedger = {
  async reserve(r, budget) {
    await sweepStaleReservations({ grantId: r.grantId });
    const ask = usdToMicros(r.usd);
    const tokens = Math.ceil(r.tokens);
    const maxUsd = usdToMicros(budget.maxUsd);
    const reserved = await rows<{ id: string }>(sql`
      WITH bump AS (
        INSERT INTO capability_grant_usage AS u (grant_id, calls, tokens, usd_micros, in_flight)
        SELECT g.id, 1, ${tokens}::bigint, ${ask}::bigint, 1
        FROM capability_grants g
        WHERE g.id = ${r.grantId}::uuid AND g.status = 'granted' AND g.revoked_at IS NULL AND g.expires_at > now()
          AND 1 <= ${budget.maxConcurrent}::int AND 1 <= ${budget.maxCalls}::int
          AND ${tokens}::bigint <= ${budget.maxTotalTokens}::bigint AND ${ask}::bigint <= ${maxUsd}::bigint
        ON CONFLICT (grant_id) DO UPDATE SET
          calls = u.calls + 1,
          tokens = u.tokens + EXCLUDED.tokens,
          usd_micros = u.usd_micros + EXCLUDED.usd_micros,
          in_flight = u.in_flight + 1,
          updated_at = now()
        WHERE u.in_flight + 1 <= ${budget.maxConcurrent}::int
          AND u.calls + 1 <= ${budget.maxCalls}::int
          AND u.tokens + EXCLUDED.tokens <= ${budget.maxTotalTokens}::bigint
          AND u.usd_micros + EXCLUDED.usd_micros <= ${maxUsd}::bigint
        RETURNING u.grant_id
      )
      INSERT INTO capability_grant_reservations (id, grant_id, usd_micros, tokens)
      SELECT ${r.reservationId}::uuid, grant_id, ${ask}::bigint, ${tokens}::bigint FROM bump
      RETURNING id`);
    if (reserved.length === 1) return { ok: true };
    return { ok: false, reason: await classifyRefusal(r, budget) };
  },

  async settle(s: ModelInferenceSettlement) {
    const debit = s.costSource === 'none' ? 0 : debitToMicros(s.debitUsd);
    const tokens = Math.max(0, Math.ceil(s.tokens));
    const notSent = s.outcome === 'not_sent';
    await db.execute(sql`
      WITH done AS (
        UPDATE capability_grant_reservations
        SET settled_at = now(), debit_usd_micros = ${debit}::bigint, debit_tokens = ${tokens}::bigint,
            cost_source = ${s.costSource}, outcome = ${s.outcome}
        WHERE id = ${s.reservationId}::uuid AND grant_id = ${s.grantId}::uuid AND settled_at IS NULL
        RETURNING grant_id, usd_micros, tokens
      )
      UPDATE capability_grant_usage u SET
        usd_micros = u.usd_micros - done.usd_micros + ${debit}::bigint,
        tokens = u.tokens - done.tokens + ${tokens}::bigint,
        calls = u.calls - ${notSent ? 1 : 0}::int,
        in_flight = GREATEST(u.in_flight - 1, 0),
        updated_at = now()
      FROM done WHERE u.grant_id = done.grant_id`);
  },
};
