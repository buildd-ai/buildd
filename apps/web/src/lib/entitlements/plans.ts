/**
 * The ONE place managed-runner plan values live. Everything else reads a
 * resolved `ManagedRunnerEntitlement` (packages/shared/src/entitlements.ts)
 * and never a plan name or a number.
 *
 * Hosted config, not mechanism: prices, product ids, offers and who is on
 * which plan belong to hosted billing, which writes `teams.managedRunnerPlan`
 * and may replace the catalog values with `BUILDD_MANAGED_PLAN_CATALOG`
 * (JSON, same shape as below). With neither set — a self-hosted install —
 * every team resolves to unlimited.
 *
 * Values follow knowledge-base: research/competitive/hosted-runner-pricing-2026-10-05.md.
 */
import {
  UNLIMITED_MANAGED_RUNNER_ENTITLEMENT,
  type ManagedRunnerEntitlement,
} from '@buildd/shared';

export type ManagedRunnerPlanId = 'individual' | 'team' | 'enterprise';

export const MANAGED_RUNNER_PLANS: Record<ManagedRunnerPlanId, ManagedRunnerEntitlement> = {
  individual: { concurrency: 3, monthlyRunnerHours: 50, overage: 'block', scope: 'individual' },
  team: { concurrency: 10, monthlyRunnerHours: 300, overage: 'block', scope: 'team' },
  // Custom: the team row's overrides carry the numbers.
  enterprise: { concurrency: null, monthlyRunnerHours: null, overage: 'allow', scope: 'custom' },
};

/** `teams.managedRunnerPlan`: a plan id plus optional per-team overrides. */
export interface TeamManagedRunnerPlan {
  plan: string;
  concurrency?: number | null;
  monthlyRunnerHours?: number | null;
  overage?: 'block' | 'allow';
}

function isPlanId(v: unknown): v is ManagedRunnerPlanId {
  return v === 'individual' || v === 'team' || v === 'enterprise';
}

const limitOrNull = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

function catalog(env: Record<string, string | undefined>): Record<ManagedRunnerPlanId, ManagedRunnerEntitlement> {
  const raw = env.BUILDD_MANAGED_PLAN_CATALOG;
  if (!raw) return MANAGED_RUNNER_PLANS;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ManagedRunnerEntitlement>>;
    const out = { ...MANAGED_RUNNER_PLANS };
    for (const id of Object.keys(out) as ManagedRunnerPlanId[]) {
      const o = parsed?.[id];
      if (!o || typeof o !== 'object') continue;
      out[id] = applyOverrides(out[id], o);
    }
    return out;
  } catch {
    console.error('[entitlements] BUILDD_MANAGED_PLAN_CATALOG is not valid JSON; using the built-in catalog');
    return MANAGED_RUNNER_PLANS;
  }
}

function applyOverrides(base: ManagedRunnerEntitlement, o: Partial<TeamManagedRunnerPlan | ManagedRunnerEntitlement>): ManagedRunnerEntitlement {
  const concurrency = limitOrNull(o.concurrency);
  const hours = limitOrNull(o.monthlyRunnerHours);
  return {
    ...base,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(hours !== undefined ? { monthlyRunnerHours: hours } : {}),
    ...(o.overage === 'block' || o.overage === 'allow' ? { overage: o.overage } : {}),
  };
}

/**
 * The team's managed-runner entitlement. Order: the team's own assignment,
 * else the deployment default plan, else unlimited. An unknown plan id is
 * treated as unassigned rather than as a block: a typo in billing config must
 * not stop anyone's work.
 */
export function resolveManagedRunnerEntitlement(
  teamPlan: TeamManagedRunnerPlan | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ManagedRunnerEntitlement {
  const plans = catalog(env);
  if (teamPlan && isPlanId(teamPlan.plan)) return applyOverrides(plans[teamPlan.plan], teamPlan);
  const fallback = env.BUILDD_DEFAULT_MANAGED_PLAN;
  if (isPlanId(fallback)) return plans[fallback];
  return UNLIMITED_MANAGED_RUNNER_ENTITLEMENT;
}
