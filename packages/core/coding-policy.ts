// Effective Coding provider policy: which backends a coding task may run on, and
// which payment sources may pay for the run.
//
// This is a RESTRICTION, never a redirect. `maskBackend` (backend-policy.ts) is
// the older reversible toggle: a disabled backend is rewritten to an enabled
// one. That is wrong for a deliberate deny — "team is Claude only" must not turn
// into "Codex work runs on Claude, billed to a different pool", and "no metered
// provider" must not turn into "the stored API key pays". Here a denied task is
// refused with a structured error and stays queued.
//
// Layers narrow, never widen: team, workspace, and the requester's own
// preference (only when the task has an identifiable requester — automation with
// no requester gets the team and workspace layers only). Each layer may set:
//   allowedBackends  null/absent = no restriction; [] = nothing allowed (deny all)
//   allowedSources   null/absent = no restriction; [] = nothing allowed
//
// Payment sources are about WHO PAYS FOR THE MODEL CALLS, not the provider:
//   runner_native  the runner operator's own login on the runner's machine
//                  (`claude login`, a local Codex login). Buildd neither stores
//                  nor hands out this credential.
//   metered        a pay-per-token route: a stored or personal API key, the team
//                  agent endpoint, OpenRouter/LiteLLM, cloud egress.
// Model-tier spending class (premium+) is a separate axis (model-tier-ceilings).
//
// No policy at all ⇒ `restricted: false` and every decision is `allow`, so
// existing teams are unchanged until a layer is explicitly saved.

import { DISPATCHABLE_BACKENDS, backendLabel, type AgentBackend } from './backend-policy';

export type PaymentSource = 'runner_native' | 'metered';
export const PAYMENT_SOURCES: readonly PaymentSource[] = ['runner_native', 'metered'];

export interface CodingPolicyLayer {
  allowedBackends?: AgentBackend[] | null;
  allowedSources?: PaymentSource[] | null;
}

/** `teams.coding_policy`: the team layer plus per-workspace layers. */
export interface TeamCodingPolicy {
  team?: CodingPolicyLayer;
  workspaces?: Record<string, CodingPolicyLayer>;
  /** Some member has saved a personal layer; only then does a claim look the requester up. */
  membersRestricted?: boolean;
}

export type CodingPolicyLayerName = 'team' | 'workspace' | 'member';

export interface EffectiveCodingPolicy {
  /** False when no layer restricts anything: every decision allows. */
  restricted: boolean;
  allowedBackends: AgentBackend[];
  allowedSources: PaymentSource[];
  /** Layers that actually narrowed backends / sources — for "why was this denied". */
  narrowedBy: { backends: CodingPolicyLayerName[]; sources: CodingPolicyLayerName[] };
  /** The requester layer was not applied because the task had no identifiable requester. */
  requesterUnknown: boolean;
}

function parseList<T extends string>(value: unknown, valid: readonly T[]): T[] | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  if (!Array.isArray(value)) return [];            // malformed: fail closed, not open
  return [...new Set(value.filter((v): v is T => (valid as readonly string[]).includes(v as string)))];
}

/** Defensive read of a stored jsonb layer. A malformed list denies; it never allows. */
export function parseCodingPolicyLayer(raw: unknown): CodingPolicyLayer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const allowedBackends = parseList<AgentBackend>(r.allowedBackends, DISPATCHABLE_BACKENDS);
  const allowedSources = parseList<PaymentSource>(r.allowedSources, PAYMENT_SOURCES);
  if (allowedBackends == null && allowedSources == null) return null;
  return {
    ...(allowedBackends != null ? { allowedBackends } : {}),
    ...(allowedSources != null ? { allowedSources } : {}),
  };
}

export function resolveCodingPolicy(inputs: {
  team?: CodingPolicyLayer | null;
  workspace?: CodingPolicyLayer | null;
  /** The requester's own layer. Pass null/undefined when there is no identifiable requester. */
  member?: CodingPolicyLayer | null;
  requesterKnown?: boolean;
}): EffectiveCodingPolicy {
  const layers: Array<[CodingPolicyLayerName, CodingPolicyLayer | null | undefined]> = [
    ['team', inputs.team],
    ['workspace', inputs.workspace],
    // Personal limits never apply to automation with no identifiable requester.
    ['member', inputs.requesterKnown === false ? null : inputs.member],
  ];
  let backends: AgentBackend[] = [...DISPATCHABLE_BACKENDS];
  let sources: PaymentSource[] = [...PAYMENT_SOURCES];
  const narrowedBy: EffectiveCodingPolicy['narrowedBy'] = { backends: [], sources: [] };
  let restricted = false;
  for (const [name, layer] of layers) {
    if (!layer) continue;
    if (layer.allowedBackends != null) {
      restricted = true;
      const next = backends.filter((b) => layer.allowedBackends!.includes(b));
      if (next.length !== backends.length) narrowedBy.backends.push(name);
      backends = next;
    }
    if (layer.allowedSources != null) {
      restricted = true;
      const next = sources.filter((s) => layer.allowedSources!.includes(s));
      if (next.length !== sources.length) narrowedBy.sources.push(name);
      sources = next;
    }
  }
  return {
    restricted,
    allowedBackends: backends,
    allowedSources: sources,
    narrowedBy,
    requesterUnknown: inputs.requesterKnown === false,
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────

export type CodingPolicyErrorCode = 'provider_not_allowed' | 'payment_source_not_allowed' | 'no_model_credential';

export interface CodingPolicyDenial {
  code: CodingPolicyErrorCode;
  message: string;
  /** What an admin or member can change. */
  remedy: string;
  backend: AgentBackend;
  source?: PaymentSource;
  narrowedBy: CodingPolicyLayerName[];
}

export type CodingPolicyDecision = { ok: true } | { ok: false; denied: CodingPolicyDenial };

const SOURCE_LABEL: Record<PaymentSource, string> = {
  runner_native: "the runner's own login",
  metered: 'a metered API route',
};

/** May a task run on `backend` at all? Used for the stored backend and every failover target. */
export function checkBackendAllowed(policy: EffectiveCodingPolicy, backend: AgentBackend): CodingPolicyDecision {
  if (policy.allowedBackends.includes(backend)) return { ok: true };
  return {
    ok: false,
    denied: {
      code: 'provider_not_allowed',
      message: `${backendLabel(backend)} is not an allowed Coding provider here.`,
      remedy: `Ask a team admin to allow ${backendLabel(backend)} under Settings → Models, or pick an allowed provider.`,
      backend,
      narrowedBy: policy.narrowedBy.backends,
    },
  };
}

/** May this run be paid for by `source`? */
export function checkSourceAllowed(
  policy: EffectiveCodingPolicy,
  backend: AgentBackend,
  source: PaymentSource,
): CodingPolicyDecision {
  if (policy.allowedSources.includes(source)) return { ok: true };
  return {
    ok: false,
    denied: {
      code: 'payment_source_not_allowed',
      message: `This run would be paid for by ${SOURCE_LABEL[source]}, which the Coding policy does not allow.`,
      remedy: source === 'metered'
        ? 'Run it on a runner with its own login, or ask a team admin to allow a metered provider.'
        : 'Ask a team admin to allow runner-managed logins, or configure a metered provider.',
      backend,
      source,
      narrowedBy: policy.narrowedBy.sources,
    },
  };
}

/**
 * Pick the payment source for a run, or refuse. `meteredConfigured` is whether a
 * metered route exists at all; being configured is not consent to fall back to
 * it, so it is only chosen when the policy allows metered AND nothing else can
 * run the task.
 *
 *  - self-host runner able to use its own login → runner_native, if allowed
 *    (a stored team key is NOT used just because it exists);
 *  - otherwise metered, if allowed and configured;
 *  - otherwise a structured refusal, never a silent downgrade or a bill.
 */
export function chooseSource(
  policy: EffectiveCodingPolicy,
  backend: AgentBackend,
  facts: { meteredConfigured: boolean; runnerNativeCapable: boolean; preferMetered?: boolean },
): { ok: true; source: PaymentSource } | { ok: false; denied: CodingPolicyDenial } {
  const nativeOk = facts.runnerNativeCapable && policy.allowedSources.includes('runner_native');
  const meteredOk = facts.meteredConfigured && policy.allowedSources.includes('metered');
  // An explicit paid route is used within policy; otherwise native auth first
  // so a stored key is never billed unasked.
  if (facts.preferMetered && meteredOk) return { ok: true, source: 'metered' };
  if (nativeOk) return { ok: true, source: 'runner_native' };
  if (meteredOk) return { ok: true, source: 'metered' };
  // Nothing usable: say whether policy or setup is the reason.
  if (facts.meteredConfigured && !policy.allowedSources.includes('metered')) {
    return checkSourceAllowed(policy, backend, 'metered') as { ok: false; denied: CodingPolicyDenial };
  }
  if (facts.runnerNativeCapable && !policy.allowedSources.includes('runner_native')) {
    return checkSourceAllowed(policy, backend, 'runner_native') as { ok: false; denied: CodingPolicyDenial };
  }
  return {
    ok: false,
    denied: {
      code: 'no_model_credential',
      message: `No model credential is available for ${backendLabel(backend)} on this runner.`,
      remedy: facts.runnerNativeCapable
        ? 'Allow runner-managed logins or configure a metered provider under Settings → Models.'
        : 'Configure a supported provider under Settings → Models so a hosted runner can run it.',
      backend,
      narrowedBy: [],
    },
  };
}

/** What the Models page and `/api/providers` show: the effective result, not the layers. */
export function describeEffectiveCodingPolicy(policy: EffectiveCodingPolicy) {
  return {
    restricted: policy.restricted,
    allowedBackends: policy.allowedBackends,
    allowedSources: policy.allowedSources,
    narrowedBy: policy.narrowedBy,
  };
}

/**
 * Strict validation for an admin write of `teams.coding_policy`. Unlike
 * `parseCodingPolicyLayer` (a defensive read that fails closed), a write with an
 * unknown backend/source or a non-array list is rejected so a typo cannot save a
 * policy that silently denies everything. `null` clears the policy.
 * Returns the normalized value, or an error string.
 */
export function normalizeTeamCodingPolicy(input: unknown, workspaceIds?: ReadonlySet<string>): { value: TeamCodingPolicy | null } | { error: string } {
  if (input === null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'codingPolicy must be an object or null' };
  const strictLayer = (raw: unknown, where: string): CodingPolicyLayer | { error: string } => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} must be an object` };
    const r = raw as Record<string, unknown>;
    const out: CodingPolicyLayer = {};
    for (const [key, valid] of [['allowedBackends', DISPATCHABLE_BACKENDS], ['allowedSources', PAYMENT_SOURCES]] as const) {
      const v = r[key];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v) || !v.every((x) => (valid as readonly unknown[]).includes(x))) {
        return { error: `${where}.${key} must be an array of ${valid.join(' | ')}` };
      }
      (out as Record<string, unknown>)[key] = [...new Set(v)];
    }
    return out;
  };
  const i = input as Record<string, unknown>;
  const value: TeamCodingPolicy = {};
  if (i.team != null) {
    const t = strictLayer(i.team, 'team');
    if ('error' in t) return t;
    value.team = t;
  }
  if (i.workspaces != null) {
    if (typeof i.workspaces !== 'object' || Array.isArray(i.workspaces)) return { error: 'workspaces must be an object' };
    value.workspaces = {};
    for (const [id, raw] of Object.entries(i.workspaces as Record<string, unknown>)) {
      if (workspaceIds && !workspaceIds.has(id)) return { error: `workspace ${id} is not in this team` };
      const l = strictLayer(raw, `workspaces.${id}`);
      if ('error' in l) return l;
      value.workspaces[id] = l;
    }
  }
  if (i.membersRestricted === true) value.membersRestricted = true;
  return { value };
}
