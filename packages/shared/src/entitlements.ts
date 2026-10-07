/**
 * Commercial entitlements: limits a hosted plan puts on Buildd-managed compute.
 *
 * An entitlement block is NOT an execution error. A task held by one stays
 * `pending`, is never failed, and starts by itself once the limit lifts (a
 * managed run finishes, the month's allowance resets, the plan grows). The
 * dashboard renders it with one component (EntitlementBlockedNotice), never as
 * error text, so a future commercial limit is a new `kind` here, not new UI.
 *
 * Three different things, kept apart on purpose:
 *  - concurrency: how many MANAGED runs may execute at once (plan lever);
 *  - runner-hours: managed compute consumed this month (the meter);
 *  - self-hosted capacity: an operator's own runners, bounded only by their
 *    own settings (`accounts.maxConcurrentWorkers`, `workspaces.maxConcurrentTasks`).
 *    No entitlement here ever applies to a self-hosted runner.
 *
 * Public and runtime-free. Plan values live in one hosted-config module
 * (apps/web/src/lib/entitlements/plans.ts); this file only knows the stable
 * keys and shapes, so a self-hosted install works with nothing configured.
 */

/** Stable entitlement keys. Billing config maps plans onto these; code reads only these. */
export const ENTITLEMENT_KEYS = {
  managedRunnerConcurrency: 'managed_runner.concurrency',
  managedRunnerHours: 'managed_runner.hours',
} as const;
export type EntitlementKey = typeof ENTITLEMENT_KEYS[keyof typeof ENTITLEMENT_KEYS];

/** What a plan grants for Buildd-managed runners. `null` = no commercial limit. */
export interface ManagedRunnerEntitlement {
  /** Managed runs that may execute at once, pooled across the team. */
  concurrency: number | null;
  /** Managed runner-hours per calendar month (UTC), pooled across the team. */
  monthlyRunnerHours: number | null;
  /** Past the monthly allowance: `block` holds new runs, `allow` bills overage. */
  overage: 'block' | 'allow';
  /** Plan family, for copy only: "individual" reads differently from "team". */
  scope: 'individual' | 'team' | 'custom' | 'unlimited';
}

/** Self-hosted default: no commercial limit of any kind. */
export const UNLIMITED_MANAGED_RUNNER_ENTITLEMENT: ManagedRunnerEntitlement = Object.freeze({
  concurrency: null,
  monthlyRunnerHours: null,
  overage: 'allow',
  scope: 'unlimited',
}) as ManagedRunnerEntitlement;

export type EntitlementBlock =
  | {
      kind: 'concurrency';
      key: typeof ENTITLEMENT_KEYS.managedRunnerConcurrency;
      active: number;
      limit: number;
      scope: ManagedRunnerEntitlement['scope'];
    }
  | {
      kind: 'usage';
      key: typeof ENTITLEMENT_KEYS.managedRunnerHours;
      unit: 'runner_hours';
      used: number;
      limit: number;
      /** When the allowance refills (ISO), start of next UTC month. */
      resetsAt: string;
      scope: ManagedRunnerEntitlement['scope'];
    };

export interface ManagedRunnerUsage {
  /** Live managed runs for the team, including any claimed earlier in this batch. */
  activeRuns: number;
  /** Managed runner-hours consumed this month. */
  runnerHoursUsed: number;
  now: Date;
}

/** First instant of the next UTC month: when a monthly allowance refills. */
export function nextMonthlyReset(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** First instant of the current UTC month: the start of the metering window. */
export function monthlyWindowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Would one more managed run exceed the entitlement? `null` = it may start.
 * Concurrency is checked first: a team at its parallel limit that also ran out
 * of hours is told about the thing that clears soonest.
 */
export function evaluateManagedRunnerEntitlement(
  ent: ManagedRunnerEntitlement,
  usage: ManagedRunnerUsage,
): EntitlementBlock | null {
  if (ent.concurrency !== null && usage.activeRuns >= ent.concurrency) {
    return {
      kind: 'concurrency',
      key: ENTITLEMENT_KEYS.managedRunnerConcurrency,
      active: usage.activeRuns,
      limit: ent.concurrency,
      scope: ent.scope,
    };
  }
  if (ent.monthlyRunnerHours !== null && ent.overage === 'block' && usage.runnerHoursUsed >= ent.monthlyRunnerHours) {
    return {
      kind: 'usage',
      key: ENTITLEMENT_KEYS.managedRunnerHours,
      unit: 'runner_hours',
      used: Math.round(usage.runnerHoursUsed * 10) / 10,
      limit: ent.monthlyRunnerHours,
      resetsAt: nextMonthlyReset(usage.now).toISOString(),
      scope: ent.scope,
    };
  }
  return null;
}

/** Narrow an untyped value (task context jsonb, a 422 body) to an EntitlementBlock. */
export function parseEntitlementBlock(value: unknown): EntitlementBlock | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const scope = (['individual', 'team', 'custom', 'unlimited'] as const).includes(v.scope as never)
    ? v.scope as ManagedRunnerEntitlement['scope']
    : 'custom';
  if (v.kind === 'concurrency' && num(v.active) && num(v.limit)) {
    return { kind: 'concurrency', key: ENTITLEMENT_KEYS.managedRunnerConcurrency, active: v.active as number, limit: v.limit as number, scope };
  }
  if (v.kind === 'usage' && num(v.used) && num(v.limit) && typeof v.resetsAt === 'string') {
    return { kind: 'usage', key: ENTITLEMENT_KEYS.managedRunnerHours, unit: 'runner_hours', used: v.used as number, limit: v.limit as number, resetsAt: v.resetsAt, scope };
  }
  return null;
}

/** Task context key a claim stamps while a task waits on an entitlement. */
export const ENTITLEMENT_BLOCK_CONTEXT_KEY = 'entitlementBlock';

/** Claim deferral key for each block kind (ClaimDiagnostics.deferrals). */
export function entitlementDeferralKey(block: EntitlementBlock): 'managed_concurrency' | 'managed_runner_hours' {
  return block.kind === 'concurrency' ? 'managed_concurrency' : 'managed_runner_hours';
}
