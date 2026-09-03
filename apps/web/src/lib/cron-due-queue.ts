/**
 * The Redis gate in front of a cron's DB work.
 *
 * Why this exists: Neon's compute autosuspends after a few idle minutes, so a
 * cron that queries Postgres on every tick keeps it awake around the clock —
 * and the answer is almost always "nothing to do". The gate moves that question
 * to Redis (always awake, priced per request), so a job can tick every few
 * minutes for latency while only waking the database when work is actually due.
 *
 * Two tiers, and the second is not optional:
 *
 *   1. GATED tick — `?gate=due`. Reads one sorted set (see `countDue` in
 *      lib/redis.ts). Nothing due → return, Postgres untouched.
 *   2. FLOOR tick — no query param, the pre-existing schedule. Always queries,
 *      and re-seeds the set from what it finds. This is what makes Redis an
 *      accelerator rather than a load-bearing dependency: a dropped ZADD costs
 *      one floor interval of latency, not silence forever.
 *
 * Defaults are no-ops: a manifest entry with no `gate` param behaves exactly as
 * it did before, so adding a gated entry is purely additive.
 *
 * Fail open. `countDue` returns null when Redis is unconfigured or erroring
 * (lib/redis.ts disables itself on a half-configured URL/token pair), and null
 * means "run the query" — never "nothing to do".
 */

import { countDue } from './redis';

export type DueGateReason =
  /** No `gate=due` param: the unconditional floor tick. */
  | 'floor'
  /** Something is due at or before now. */
  | 'work_due'
  /** Redis says nothing is due — skip the DB entirely. */
  | 'nothing_due'
  /** Could not ask Redis; proceeding rather than assuming idle. */
  | 'redis_unavailable';

export interface DueGate {
  proceed: boolean;
  reason: DueGateReason;
  /** Members due at or before now, or null when Redis could not answer. */
  dueCount: number | null;
  /** True when this tick re-seeds the set after querying (floor ticks only). */
  reseed: boolean;
}

/** Pure gate decision, so the branch is testable without a Redis client. */
export function decideDueGate(gateParam: string | null, dueCount: number | null): DueGate {
  if (gateParam !== 'due') return { proceed: true, reason: 'floor', dueCount, reseed: true };
  if (dueCount === null) return { proceed: true, reason: 'redis_unavailable', dueCount, reseed: false };
  if (dueCount > 0) return { proceed: true, reason: 'work_due', dueCount, reseed: false };
  return { proceed: false, reason: 'nothing_due', dueCount: 0, reseed: false };
}

/**
 * One structured line per tick, so the fast path is auditable in production.
 *
 * A gate that skips for the wrong reason looks identical to a gate that
 * correctly found nothing — grep `cron_gate` and check that `nothing_due`
 * ticks alternate with `work_due` ones instead of running forever.
 */
export function logDueGate(job: string, gate: DueGate): void {
  console.log(JSON.stringify({ event: 'cron_gate', job, ...gate }));
}

/**
 * Resolve the gate for one tick and log the decision.
 *
 * `job` is the due-queue name (`buildd:due:<job>`), not the route path — a
 * route with two manifest entries shares one queue.
 */
export async function gateOnDueQueue(
  job: string,
  searchParams: URLSearchParams,
): Promise<DueGate> {
  const gateParam = searchParams.get('gate');
  // Only a gated tick pays for the Redis round-trip; the floor tick is querying
  // Postgres regardless, so asking would be pure latency.
  const dueCount = gateParam === 'due' ? await countDue(job) : null;
  const gate = decideDueGate(gateParam, dueCount);
  logDueGate(job, gate);
  return gate;
}
