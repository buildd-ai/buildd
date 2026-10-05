/**
 * `@builddai/ai-kit/policy`: standalone model policy (no peers, no framework
 * deps; Node, Bun and edge). Usable with no buildd and no service at all.
 *
 * The caller declares `surface` (`chat | coding`) and requests a `tier`; the
 * policy picks provider, model and effort. Intent is inferred behind the
 * policy boundary, never declared by the caller.
 *
 * ```ts
 * const policy = createPolicyClient({ policy: remotePolicy({ endpoint, token }), fallback: DEFAULT_MODEL_POLICY });
 * const d = await policy.resolve({ surface: 'chat', tier: 'standard', app: 'cue' });
 * // call d.provider / d.model with the app's own credentials, then optionally:
 * if (d.planId) await policy.reportOutcome({ planId: d.planId, surface: 'chat', observations: [{ type: 'explicit_feedback', value: 'up' }] });
 * ```
 */

export * from './types';
export { DEFAULT_MODEL_POLICY } from './defaults';
export {
  resolveModelPolicy, pickRoute, findExperiment, allocationPoint, pickArm, type ResolveOptions,
} from './resolve';
export {
  parsePolicyRequest, parsePolicyDecision, parseOutcomeReport, parseRoute, validateModelPolicy,
  toPolicySurface, toBuilddSurface, findCredentialLike, CREDENTIAL_KEY_PATTERN, PROVIDER_KEY_PATTERN,
  type Parsed,
} from './protocol';
export {
  createPolicyClient, remotePolicy, POLICY_RESOLVE_TIMEOUT_MS, POLICY_OUTCOME_TIMEOUT_MS, POLICY_MAX_STALE_SECONDS,
  type PolicyClient, type PolicyClientOptions, type PolicyClientEvent, type RemotePolicySource, type RemotePolicyOptions,
} from './client';
