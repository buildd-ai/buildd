/**
 * Which credential scopes a team's policy lets a surface spend.
 *
 * Pure: no DB, client-safe. The resolver (`./resolve`) is the one caller that
 * enforces it; settings and `explain` can call it to say why a row was skipped.
 *
 * ## The policy every surface follows
 *
 * Chat (turns, inference and decision calls) and agent surfaces
 * (`agent-claude`, `agent-codex`, `cloud-egress`) follow one policy, as
 * `effectiveKeyPolicy` reads it: `teams.credentialPolicy`, else the older
 * `teams.inferenceKeyPolicy` (its default `'team'` reads as unset), else
 * `personal_first`: the person the work is for spends their own key, and the
 * team's key is the fallback. Work with no requester (schedules, webhooks)
 * always spends team scopes.
 *
 * ## Truth table (`policyAllowsScope`)
 *
 * | policy           | personal row of the requester | workspace / account / team / env | no requester              |
 * |------------------|-------------------------------|----------------------------------|---------------------------|
 * | `team`           | ignored                       | used                             | team rows                 |
 * | `personal_first` | wins                          | fallback                         | team rows                 |
 * | `personal_only`  | only source                   | forbidden                        | nothing: chat "no key"; agent claim refusal `no_personal_credential` |
 *
 * Whether a personal row is the requester's own is `./requester`'s question;
 * this module only says whether the personal scope is open at all.
 */
import {
  DEFAULT_CREDENTIAL_POLICY,
  effectiveKeyPolicy,
  isCredentialPolicy,
  toCredentialPolicy,
  type CredentialPolicy,
} from '../inference-key-policy';
import type { Surface } from './registry';

export type { CredentialPolicy } from '../inference-key-policy';
export { CREDENTIAL_POLICIES, isCredentialPolicy } from '../inference-key-policy';

/**
 * Where a resolved credential came from. `account` is a row scoped to the API
 * account making the call; `env` is a provider env var (chat, non-production).
 */
export type PolicyScope = 'personal' | 'workspace' | 'account' | 'team' | 'env';

/** The team columns the policy is read from. */
export interface TeamPolicyColumns {
  credentialPolicy?: unknown;
  inferenceKeyPolicy?: unknown;
  /** `teams.provider_assignments`, read by the resolver (`./assignments`), not by the policy. */
  providerAssignments?: unknown;
}

export function isAgentSurface(surface: Surface): boolean {
  return surface !== 'chat';
}

/** The policy every surface falls back to when the team has chosen none. */
export const CHAT_DEFAULT_POLICY: CredentialPolicy = DEFAULT_CREDENTIAL_POLICY;

export interface SurfacePolicy {
  policy: CredentialPolicy;
  /**
   * Always true from `surfacePolicy`. Kept on the shape (and as
   * `agentEnforced` below) for callers that still pass it; false reads an
   * agent surface as `team`.
   */
  enforced: boolean;
  /** Where `policy` came from, for `why`. */
  source: 'credential_policy' | 'inference_key_policy' | 'default';
}

/** The policy a surface follows for this team (see the module comment). */
export function surfacePolicy(team: TeamPolicyColumns | null | undefined, _surface: Surface): SurfacePolicy {
  const explicit = isCredentialPolicy(team?.credentialPolicy) ? team!.credentialPolicy as CredentialPolicy : null;
  if (explicit) return { policy: explicit, enforced: true, source: 'credential_policy' };
  const legacy = effectiveKeyPolicy(team);
  return legacy
    ? { policy: toCredentialPolicy(legacy), enforced: true, source: 'inference_key_policy' }
    : { policy: CHAT_DEFAULT_POLICY, enforced: true, source: 'default' };
}

export interface PolicyScopeInput {
  policy: CredentialPolicy;
  scope: PolicyScope;
  /** Is there a person the work is for? */
  hasRequester: boolean;
  surface: Surface;
  /** `SurfacePolicy.enforced`. False on an agent surface ⇒ read as `team`. */
  agentEnforced: boolean;
}

/** The policy an agent surface actually applies: `team` until the team opts in. */
export function appliedPolicy(input: Pick<PolicyScopeInput, 'policy' | 'surface' | 'agentEnforced'>): CredentialPolicy {
  return isAgentSurface(input.surface) && !input.agentEnforced ? 'team' : input.policy;
}

/** May a credential in this scope be spent under this policy? */
export function policyAllowsScope(input: PolicyScopeInput): boolean {
  const policy = appliedPolicy(input);
  if (input.scope === 'personal') return policy !== 'team' && input.hasRequester;
  return policy !== 'personal_only';
}

/** Short reason a scope is closed, for `why`. Null when it is open. */
export function policyScopeReason(input: PolicyScopeInput): string | null {
  if (policyAllowsScope(input)) return null;
  const policy = appliedPolicy(input);
  if (input.scope === 'personal') {
    if (policy === 'team') {
      return isAgentSurface(input.surface) && !input.agentEnforced
        ? 'personal credentials are not used for agent runs until the team sets a credential policy'
        : 'the team policy is team keys only';
    }
    return 'there is no requester, so no personal credential applies';
  }
  return 'the team policy is personal keys only';
}

/**
 * Under `personal_only` with no requester nothing can resolve. An agent claim
 * refuses with this code; chat says there is no key.
 */
export const NO_PERSONAL_CREDENTIAL = 'no_personal_credential' as const;

/**
 * Runner feature a claim request declares when the runner keeps a personal
 * credential to the one worker it was delivered for: never cached per team,
 * never reused for another worker. The host claim delivers a personal key only
 * to a runner that declares it (claim/personal-credential-injection.ts).
 */
export const PERSONAL_CREDENTIAL_RUNNER_FEATURE = 'personal_credentials' as const;
