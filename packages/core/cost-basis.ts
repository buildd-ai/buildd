/**
 * Cost basis: how a worker's tokens and cost were charged.
 * Spec: docs/specs/real-and-virtual-cost.md.
 *
 * - `real`: charged per token to a credential the team pays for (API key, team
 *   endpoint, cloud-provider model account). The dollars approximate spend.
 * - `virtual`: drawn from a plan allowance (a subscription login). The dollars
 *   are the list-price value of that usage.
 * - `mixed`: the worker reported both over its life.
 * - `unknown`: usage arrived with no basis (an older reporter, or one that
 *   could not tell).
 *
 * The basis is reported by whoever picked the credential. It is never derived
 * from `accounts.authType`, the model or the amount.
 */
import { sql, type SQL } from 'drizzle-orm';
import { workers } from './db/schema';

export const COST_BASES = ['real', 'virtual', 'mixed', 'unknown'] as const;
export type CostBasis = (typeof COST_BASES)[number];

export function isCostBasis(v: unknown): v is CostBasis {
  return typeof v === 'string' && (COST_BASES as readonly string[]).includes(v);
}

/** Absent is not an error: an older reporter sends none and the row records `unknown`. */
export function parseCostBasis(v: unknown): { ok: true; basis: CostBasis | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, basis: null };
  return isCostBasis(v) ? { ok: true, basis: v } : { ok: false };
}

/**
 * The basis a row holds after a report. First known basis is kept, a different
 * known one makes it `mixed`, and `unknown` never overwrites a known basis, so
 * the result does not depend on report order.
 */
export function combineCostBasis(prev: CostBasis | null, next: CostBasis): CostBasis {
  if (prev === null || prev === 'unknown') return next;
  if (next === 'unknown' || next === prev) return prev;
  return 'mixed';
}

/**
 * `combineCostBasis` as a SET expression on `workers.cost_basis`, so concurrent
 * reports cannot lose a basis between a read and a write.
 */
export function costBasisWrite(next: CostBasis): SQL {
  const col = workers.costBasis;
  return sql`CASE
    WHEN ${col} IS NULL OR ${col} = ${'unknown'} THEN ${next}
    WHEN ${next} = ${'unknown'} OR ${col} = ${next} THEN ${col}
    ELSE ${'mixed'} END`;
}

/**
 * Mission `costBudgetUsd` is a guard on money: virtual (plan) usage never
 * counts. `unknown` and `mixed` count so real spend cannot slip past it
 * unlabelled. NULL rows carry cost only from before the backfill.
 */
export function countsTowardMissionBudget(basis: CostBasis | null): boolean {
  return basis !== 'virtual';
}
