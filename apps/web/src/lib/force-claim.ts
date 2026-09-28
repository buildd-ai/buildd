/**
 * The audit a force claim (claim_task force: true) leaves on the task:
 * `context.forceClaim = { at, accountId, userId, bypassed[] }`.
 *
 * It describes ONE claim, so it must not survive the claim: the claim route
 * rewrites it on every claim, and every requeue writer drops it, so a later
 * ordinary claim or a runner never inherits a stale "forced by" record.
 * Dependency-free so any writer can import it.
 */
export const FORCE_CLAIM_CONTEXT_KEY = 'forceClaim' as const;

export interface ForceClaimAudit {
  at: string;
  accountId: string;
  /** The session user when the token carries one (OAuth sub); null for a bld_ key. */
  userId: string | null;
  /** Gates that would have excluded or deferred the task, lifted by this claim. */
  bypassed: string[];
}

/** A copy of `context` without the force-claim audit. */
export function withoutForceClaim<T extends Record<string, unknown>>(
  context: T | null | undefined,
): Record<string, unknown> {
  if (!context) return {};
  if (!(FORCE_CLAIM_CONTEXT_KEY in context)) return { ...context };
  const { [FORCE_CLAIM_CONTEXT_KEY]: _dropped, ...rest } = context;
  return rest;
}
