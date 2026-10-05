/**
 * Validation for every shape that crosses the policy boundary: requests,
 * decisions, outcome reports and policy documents. Pure; no I/O.
 *
 * Requests and reports are strict (an unknown field is refused, not ignored),
 * which is what keeps the public contract small: a caller cannot start sending
 * `intent` or `workload` and have it quietly become part of the API.
 *
 * Decisions from a remote policy are rebuilt field by field, so nothing the
 * service adds reaches the app, and one carrying anything credential-shaped is
 * refused outright: a policy answer never brokers a provider secret.
 */

import {
  CODING_ONLY_SIGNALS, DECISION_SOURCES, EXPERIMENT_MODES, KIT_PROVIDERS, KIT_TIERS, OUTCOME_SIGNALS,
  POLICY_EFFORTS, POLICY_SURFACES, TRUSTWORTHY_SIGNALS,
  type DecisionExperiment, type ModelPolicy, type OutcomeReport, type PolicyDecision,
  type PolicyObservation, type PolicyRequest, type PolicyRoute, type PolicyScope, type PolicySurface,
} from './types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const includes = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly unknown[]).includes(v);

const APP_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ARM_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const MAX_MODEL_LEN = 200;
const MAX_OBSERVATIONS = 50;

/** Field names that mean "a credential", anywhere in a decision. */
export const CREDENTIAL_KEY_PATTERN = /(api[_-]?key|secret|token|password|passwd|authori[sz]ation|credential|bearer|private[_-]?key)/i;
/** Values shaped like a provider key (Anthropic, OpenAI, OpenRouter, AWS). */
export const PROVIDER_KEY_PATTERN = /^(sk-|sk_|AKIA[0-9A-Z]{12})/;

/** The first credential-shaped key or value in `v`, as a path; null when clean. */
export function findCredentialLike(v: unknown, path = '$'): string | null {
  if (typeof v === 'string') return PROVIDER_KEY_PATTERN.test(v) ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findCredentialLike(v[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isObject(v)) {
    for (const [k, inner] of Object.entries(v)) {
      if (CREDENTIAL_KEY_PATTERN.test(k)) return `${path}.${k}`;
      const hit = findCredentialLike(inner, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function strictKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k)).sort();
  if (extra.length === 0) return null;
  return `${what}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`;
}

// ── Surfaces ────────────────────────────────────────────────────────────────

/**
 * buildd's surface vocabulary → the protocol's. `agent` (buildd's runner
 * claims) is `coding`; `inference` (one-shot calls) resolves `chat`, as it
 * does in buildd's own registry.
 */
export function toPolicySurface(surface: 'agent' | 'chat' | 'inference' | PolicySurface): PolicySurface {
  if (surface === 'agent' || surface === 'coding') return 'coding';
  if (surface === 'chat' || surface === 'inference') return 'chat';
  throw new TypeError(`toPolicySurface: unknown surface ${String(surface)}`);
}

/** The protocol's surface → buildd's tier-registry surface. */
export function toBuilddSurface(surface: PolicySurface): 'agent' | 'chat' {
  return surface === 'coding' ? 'agent' : 'chat';
}

// ── Requests ────────────────────────────────────────────────────────────────

const REQUEST_KEYS = ['surface', 'tier', 'app', 'workspaceId'] as const;

export function parsePolicyRequest(body: unknown): Parsed<PolicyRequest> {
  if (!isObject(body)) return { ok: false, error: 'request: expected a JSON object' };
  const extra = strictKeys(body, REQUEST_KEYS, 'request');
  if (extra) {
    return { ok: false, error: `${extra}. The caller declares surface and tier only; the policy infers the rest` };
  }
  if (body.surface === 'agent') return { ok: false, error: "request: surface 'agent' is 'coding' in this protocol" };
  if (!includes(POLICY_SURFACES, body.surface)) return { ok: false, error: `request: surface must be one of ${POLICY_SURFACES.join(', ')}` };
  if (!includes(KIT_TIERS, body.tier)) return { ok: false, error: `request: tier must be one of ${KIT_TIERS.join(', ')}` };
  const out: PolicyRequest = { surface: body.surface, tier: body.tier };
  if (body.app !== undefined) {
    if (typeof body.app !== 'string' || !APP_RE.test(body.app)) return { ok: false, error: 'request: app must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,63}' };
    out.app = body.app;
  }
  if (body.workspaceId !== undefined) {
    if (typeof body.workspaceId !== 'string' || !ID_RE.test(body.workspaceId)) return { ok: false, error: 'request: workspaceId must be a short id string' };
    out.workspaceId = body.workspaceId;
  }
  return { ok: true, value: out };
}

// ── Routes and documents ────────────────────────────────────────────────────

export function parseRoute(v: unknown, where: string): Parsed<PolicyRoute> {
  if (!isObject(v)) return { ok: false, error: `${where}: expected { provider, model, effort? }` };
  const extra = strictKeys(v, ['provider', 'model', 'effort'], where);
  if (extra) return { ok: false, error: extra };
  if (!includes(KIT_PROVIDERS, v.provider)) return { ok: false, error: `${where}.provider must be one of ${KIT_PROVIDERS.join(', ')}` };
  if (typeof v.model !== 'string' || !v.model || v.model.length > MAX_MODEL_LEN) return { ok: false, error: `${where}.model must be a non-empty string` };
  if (PROVIDER_KEY_PATTERN.test(v.model)) return { ok: false, error: `${where}.model looks like a provider key` };
  const route: PolicyRoute = { provider: v.provider, model: v.model };
  if (v.effort !== undefined) {
    if (!includes(POLICY_EFFORTS, v.effort)) return { ok: false, error: `${where}.effort must be one of ${POLICY_EFFORTS.join(', ')}` };
    route.effort = v.effort;
  }
  return { ok: true, value: route };
}

function checkScope(v: unknown, where: string, required: boolean, errors: string[]): void {
  if (v === undefined && !required) return;
  if (!isObject(v)) { errors.push(`${where}: expected { app?, workspaceId? }`); return; }
  const extra = strictKeys(v, ['app', 'workspaceId'], where);
  if (extra) errors.push(extra);
  const s = v as PolicyScope;
  if (s.app === undefined && s.workspaceId === undefined) errors.push(`${where}: name an app, a workspaceId, or both`);
  if (s.app !== undefined && (typeof s.app !== 'string' || !APP_RE.test(s.app))) errors.push(`${where}.app is invalid`);
  if (s.workspaceId !== undefined && (typeof s.workspaceId !== 'string' || !ID_RE.test(s.workspaceId))) errors.push(`${where}.workspaceId is invalid`);
}

function checkTierMap(v: unknown, where: string, errors: string[]): void {
  if (!isObject(v)) { errors.push(`${where}: expected a map of tier → route`); return; }
  for (const [tier, route] of Object.entries(v)) {
    if (!includes(KIT_TIERS, tier)) { errors.push(`${where}: unknown tier ${tier}`); continue; }
    const r = parseRoute(route, `${where}.${tier}`);
    if (!r.ok) errors.push(r.error);
  }
}

/**
 * Check a policy document. Everything wrong is reported at once, so an
 * operator fixes a document in one pass. A policy that fails validation is
 * never served; callers fall back to the bundled policy instead.
 */
export function validateModelPolicy(doc: unknown): { ok: true; policy: ModelPolicy } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(doc)) return { ok: false, errors: ['policy: expected a JSON object'] };
  const extra = strictKeys(doc, ['version', 'tiers', 'surfaces', 'overrides', 'experiments'], 'policy');
  if (extra) errors.push(extra);
  if (typeof doc.version !== 'string' || !doc.version || doc.version.length > 64) errors.push('policy.version must be a non-empty string (≤64)');
  checkTierMap(doc.tiers, 'policy.tiers', errors);

  if (doc.surfaces !== undefined) {
    if (!isObject(doc.surfaces)) errors.push('policy.surfaces: expected { chat?, coding? }');
    else {
      for (const [surface, map] of Object.entries(doc.surfaces)) {
        if (!includes(POLICY_SURFACES, surface)) {
          errors.push(surface === 'agent'
            ? "policy.surfaces: 'agent' is 'coding' in this protocol"
            : `policy.surfaces: unknown surface ${surface}`);
          continue;
        }
        checkTierMap(map, `policy.surfaces.${surface}`, errors);
      }
    }
  }

  if (doc.overrides !== undefined) {
    if (!Array.isArray(doc.overrides)) errors.push('policy.overrides: expected an array');
    else doc.overrides.forEach((o, i) => {
      const where = `policy.overrides[${i}]`;
      if (!isObject(o)) { errors.push(`${where}: expected an object`); return; }
      const x = strictKeys(o, ['match', 'surface', 'tier', 'route'], where);
      if (x) errors.push(x);
      checkScope(o.match, `${where}.match`, true, errors);
      if (o.surface !== undefined && !includes(POLICY_SURFACES, o.surface)) errors.push(`${where}.surface must be one of ${POLICY_SURFACES.join(', ')}`);
      if (!includes(KIT_TIERS, o.tier)) errors.push(`${where}.tier must be one of ${KIT_TIERS.join(', ')}`);
      const r = parseRoute(o.route, `${where}.route`);
      if (!r.ok) errors.push(r.error);
    });
  }

  if (doc.experiments !== undefined) {
    if (!Array.isArray(doc.experiments)) errors.push('policy.experiments: expected an array');
    else {
      const keys = new Set<string>();
      doc.experiments.forEach((e, i) => checkExperiment(e, `policy.experiments[${i}]`, keys, errors));
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, policy: doc as unknown as ModelPolicy };
}

function checkExperiment(e: unknown, where: string, keys: Set<string>, errors: string[]): void {
  if (!isObject(e)) { errors.push(`${where}: expected an object`); return; }
  const x = strictKeys(e, ['key', 'mode', 'tier', 'surface', 'match', 'arms', 'signal'], where);
  if (x) errors.push(x);
  if (typeof e.key !== 'string' || !ID_RE.test(e.key)) errors.push(`${where}.key must be a short id string`);
  else if (keys.has(e.key)) errors.push(`${where}.key ${e.key} is used twice`);
  else keys.add(e.key);
  if (!includes(EXPERIMENT_MODES, e.mode)) { errors.push(`${where}.mode must be one of ${EXPERIMENT_MODES.join(', ')}`); return; }
  if (!includes(KIT_TIERS, e.tier)) errors.push(`${where}.tier must be one of ${KIT_TIERS.join(', ')}`);
  if (e.surface !== undefined && !includes(POLICY_SURFACES, e.surface)) errors.push(`${where}.surface must be one of ${POLICY_SURFACES.join(', ')}`);
  checkScope(e.match, `${where}.match`, false, errors);

  if (!Array.isArray(e.arms)) { errors.push(`${where}.arms: expected an array`); return; }
  const single = e.mode === 'pinned' || e.mode === 'shadow';
  if (single && e.arms.length !== 1) errors.push(`${where}: a ${e.mode} experiment has exactly one arm`);
  if (!single && e.arms.length < 2) errors.push(`${where}: a ${e.mode} experiment needs at least two arms`);
  const names = new Set<string>();
  e.arms.forEach((a, j) => {
    const aw = `${where}.arms[${j}]`;
    if (!isObject(a)) { errors.push(`${aw}: expected { name, route, weight? }`); return; }
    const ax = strictKeys(a, ['name', 'route', 'weight'], aw);
    if (ax) errors.push(ax);
    if (typeof a.name !== 'string' || !ARM_RE.test(a.name)) errors.push(`${aw}.name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,31}`);
    else if (a.name === 'control' && e.mode === 'shadow') errors.push(`${aw}.name 'control' is reserved for the applied route of a shadow experiment`);
    else if (names.has(a.name)) errors.push(`${aw}.name ${a.name} is used twice`);
    else names.add(a.name);
    const r = parseRoute(a.route, `${aw}.route`);
    if (!r.ok) errors.push(r.error);
    if (a.weight !== undefined && (typeof a.weight !== 'number' || !Number.isFinite(a.weight) || a.weight <= 0)) {
      errors.push(`${aw}.weight must be a positive number`);
    }
  });

  if (e.mode === 'adaptive') {
    // No trustworthy signal → no automatic traffic movement. Split or shadow instead.
    if (!includes(POLICY_SURFACES, e.surface)) {
      errors.push(`${where}: an adaptive experiment must name its surface; the signal it follows is surface-specific`);
    } else if (e.signal === undefined) {
      errors.push(`${where}: an adaptive experiment needs a signal; with none, use split or shadow`);
    } else if (!includes(TRUSTWORTHY_SIGNALS[e.surface], e.signal)) {
      const ok = TRUSTWORTHY_SIGNALS[e.surface];
      errors.push(`${where}: ${String(e.signal)} is not a trustworthy ${e.surface} signal` +
        (ok.length ? ` (one of ${ok.join(', ')})` : `; ${e.surface} has none yet, so use split or shadow`));
    }
  } else if (e.signal !== undefined) {
    errors.push(`${where}.signal only applies to an adaptive experiment`);
  }
}

// ── Decisions (what a remote policy answers) ────────────────────────────────

/**
 * Accept a remote decision. Unknown fields are dropped (the service may grow),
 * but any credential-shaped key or value refuses the whole answer.
 */
export function parsePolicyDecision(body: unknown): Parsed<PolicyDecision> {
  if (!isObject(body)) return { ok: false, error: 'decision: expected a JSON object' };
  const leak = findCredentialLike(body);
  if (leak) return { ok: false, error: `decision: carries a credential-shaped field at ${leak}; a policy never returns provider secrets` };
  const route = parseRoute({ provider: body.provider, model: body.model, ...(body.effort != null ? { effort: body.effort } : {}) }, 'decision');
  if (!route.ok) return route;
  if (typeof body.policyVersion !== 'string' || !body.policyVersion) return { ok: false, error: 'decision.policyVersion must be a string' };
  if (body.planId !== null && typeof body.planId !== 'string') return { ok: false, error: 'decision.planId must be a string or null' };
  if (!includes(POLICY_SURFACES, body.surface)) return { ok: false, error: 'decision.surface is invalid' };
  if (!includes(KIT_TIERS, body.tier)) return { ok: false, error: 'decision.tier is invalid' };
  if (!includes(DECISION_SOURCES, body.source)) return { ok: false, error: 'decision.source is invalid' };
  const out: PolicyDecision = {
    provider: route.value.provider,
    model: route.value.model,
    effort: route.value.effort ?? null,
    policyVersion: body.policyVersion,
    planId: body.planId,
    surface: body.surface,
    tier: body.tier,
    source: body.source,
  };
  if (isObject(body.experiment)) {
    const ex = body.experiment;
    if (typeof ex.key === 'string' && includes(EXPERIMENT_MODES, ex.mode) && typeof ex.arm === 'string') {
      const experiment: DecisionExperiment = { key: ex.key, mode: ex.mode, arm: ex.arm };
      if (isObject(ex.shadow) && typeof ex.shadow.arm === 'string') {
        const sr = parseRoute({ provider: ex.shadow.provider, model: ex.shadow.model, ...(ex.shadow.effort != null ? { effort: ex.shadow.effort } : {}) }, 'decision.experiment.shadow');
        if (sr.ok) experiment.shadow = { arm: ex.shadow.arm, ...sr.value };
      }
      out.experiment = experiment;
    }
  }
  return { ok: true, value: out };
}

// ── Outcome reports ─────────────────────────────────────────────────────────

const OBSERVATION_FIELDS: Record<PolicyObservation['type'], readonly string[]> = {
  tests: ['passed'], goal_criteria: ['passed'], review_verdict: ['verdict'], merged: ['merged'],
  rework: ['required'], explicit_feedback: ['value'], regenerated: [], user_correction: [],
  evaluator: ['source', 'verdict'], latency: ['ms'], duration: ['ms'], cost: ['usd'],
};

function parseObservation(v: unknown, where: string): Parsed<PolicyObservation> {
  if (!isObject(v)) return { ok: false, error: `${where}: expected an object` };
  if (!includes(OUTCOME_SIGNALS, v.type)) {
    return { ok: false, error: `${where}.type must be one of ${OUTCOME_SIGNALS.join(', ')} (there is no generic score)` };
  }
  const extra = strictKeys(v, ['type', ...OBSERVATION_FIELDS[v.type]], where);
  if (extra) return { ok: false, error: extra };
  const bool = (k: string) => typeof v[k] === 'boolean';
  const nonNeg = (k: string) => typeof v[k] === 'number' && Number.isFinite(v[k]) && (v[k] as number) >= 0;
  const valid = (() => {
    switch (v.type) {
      case 'tests': case 'goal_criteria': return bool('passed');
      case 'merged': return bool('merged');
      case 'rework': return bool('required');
      case 'review_verdict': return includes(['approve', 'request_changes', 'escalate'] as const, v.verdict);
      case 'explicit_feedback': return includes(['up', 'down'] as const, v.value);
      case 'evaluator': return includes(['app', 'human'] as const, v.source) && includes(['pass', 'fail'] as const, v.verdict);
      case 'latency': case 'duration': return nonNeg('ms');
      case 'cost': return nonNeg('usd');
      default: return true;
    }
  })();
  if (!valid) return { ok: false, error: `${where}: invalid ${v.type} observation` };
  return { ok: true, value: v as unknown as PolicyObservation };
}

export function parseOutcomeReport(body: unknown): Parsed<OutcomeReport> {
  if (!isObject(body)) return { ok: false, error: 'outcome: expected a JSON object' };
  const extra = strictKeys(body, ['planId', 'surface', 'observations'], 'outcome');
  if (extra) return { ok: false, error: extra };
  if (typeof body.planId !== 'string' || !ID_RE.test(body.planId)) return { ok: false, error: 'outcome.planId must be the planId of a decision' };
  if (!includes(POLICY_SURFACES, body.surface)) return { ok: false, error: `outcome.surface must be one of ${POLICY_SURFACES.join(', ')}` };
  if (!Array.isArray(body.observations) || body.observations.length === 0 || body.observations.length > MAX_OBSERVATIONS) {
    return { ok: false, error: `outcome.observations: 1 to ${MAX_OBSERVATIONS} typed observations` };
  }
  const observations: PolicyObservation[] = [];
  for (let i = 0; i < body.observations.length; i++) {
    const o = parseObservation(body.observations[i], `outcome.observations[${i}]`);
    if (!o.ok) return o;
    if (body.surface === 'chat' && includes(CODING_ONLY_SIGNALS, o.value.type)) {
      return { ok: false, error: `outcome.observations[${i}]: ${o.value.type} is a coding observation` };
    }
    observations.push(o.value);
  }
  return { ok: true, value: { planId: body.planId, surface: body.surface, observations } };
}
