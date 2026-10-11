// One allow/deny check for scoped commercial capabilities of FUTURE modules.
//
// Three questions stay separate (docs/specs/commercial-licensing.md):
//   - entitlement: may this deployment/team use capability X? (answered here)
//   - authorization: may this user do it? (roles/permissions; not touched here)
//   - physical capacity: are runners available? (managed-runner caps; not touched)
//
// Nothing in the current product calls this. Existing member, SSO, task,
// mission and GitHub behaviour is not gated by it, and `entitlements()` and
// `resolveManagedRunnerEntitlement()` are unchanged. A gate for a future module
// calls checkCommercialCapability at its API/MCP/worker entry and returns the
// typed denial; hiding UI alone is not a gate.
//
// Fail closed on the premium capability only: an invalid or missing license
// denies the capability, never core features or access to existing data.

import { type LicenseStatus, resolveLicenseStatus } from './verify';

/**
 * Reserved capability ids for modules that do not exist yet. Reserving a name
 * is not a claim that anything implements it.
 */
export const RESERVED_COMMERCIAL_CAPABILITIES = ['collab', 'sso', 'scim', 'audit_export'] as const;

/**
 * Claims implied by a hosted plan (Stripe-derived `teams.plan`). Reserved: a
 * future module must be added here deliberately. Free/pro imply none.
 */
export const HOSTED_PLAN_CLAIMS: Record<string, readonly string[]> = {
  free: [],
  pro: [],
  team: ['collab'],
};

export type CapabilitySource = 'stripe' | 'license' | 'default';

export type CapabilityDenialReason =
  | 'license_required'
  | 'license_expired'
  | 'license_invalid'
  | 'license_not_yet_valid'
  | 'capability_not_licensed'
  | 'not_in_plan';

export type CapabilityDecision =
  | { allowed: true; claim: string; source: CapabilitySource; inGrace?: boolean }
  | { allowed: false; claim: string; source: CapabilitySource; reason: CapabilityDenialReason; message: string };

export type CapabilityScope =
  | {
      deployment: 'hosted';
      /** The team's plan as stored (Stripe-derived). */
      plan: string | null | undefined;
      /** BILLING_ENFORCED. Off = nothing is gated, as today. */
      billingEnforced: boolean;
    }
  | {
      deployment: 'selfhost';
      /** Pre-resolved status; omit to read BUILDD_LICENSE* from env. */
      license?: LicenseStatus;
      env?: Record<string, string | undefined>;
      now?: number;
    };

const MESSAGES: Record<CapabilityDenialReason, string> = {
  license_required: 'This capability needs a license. Core features and your data are unaffected.',
  license_expired: 'The license has expired. Core features and your data are unaffected; renew to restore this capability.',
  license_invalid: 'The configured license could not be verified. Core features and your data are unaffected.',
  license_not_yet_valid: 'The configured license is not valid yet. Check the system clock or the license start date.',
  capability_not_licensed: 'The current license does not include this capability.',
  not_in_plan: 'The current plan does not include this capability.',
};

function deny(claim: string, source: CapabilitySource, reason: CapabilityDenialReason): CapabilityDecision {
  return { allowed: false, claim, source, reason, message: MESSAGES[reason] };
}

export function checkCommercialCapability(claim: string, scope: CapabilityScope): CapabilityDecision {
  if (scope.deployment === 'hosted') {
    // Preserve BILLING_ENFORCED semantics: off means nothing is limited.
    if (!scope.billingEnforced) return { allowed: true, claim, source: 'default' };
    const plan = scope.plan ?? '';
    const claims = Object.hasOwn(HOSTED_PLAN_CLAIMS, plan) ? HOSTED_PLAN_CLAIMS[plan] : [];
    return claims.includes(claim) ? { allowed: true, claim, source: 'stripe' } : deny(claim, 'stripe', 'not_in_plan');
  }

  let status: LicenseStatus;
  try {
    status = scope.license ?? resolveLicenseStatus(scope.env, { now: scope.now });
  } catch {
    status = { status: 'invalid', reason: 'malformed' };
  }

  switch (status.status) {
    case 'absent':
      return deny(claim, 'license', 'license_required');
    case 'invalid':
      return deny(claim, 'license', 'license_invalid');
    case 'not_yet_valid':
      return deny(claim, 'license', 'license_not_yet_valid');
    case 'expired':
      return deny(claim, 'license', 'license_expired');
    case 'active':
    case 'grace':
      return status.claims?.features.includes(claim)
        ? { allowed: true, claim, source: 'license', ...(status.status === 'grace' ? { inGrace: true } : {}) }
        : deny(claim, 'license', 'capability_not_licensed');
  }
}
