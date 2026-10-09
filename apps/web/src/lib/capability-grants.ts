/**
 * Capability requests, team policy and task-scoped grants: the rules. Pure;
 * the db half is capability-grants-store.ts.
 *
 * A running agent asks for a semantic need (`observability:query`, optionally
 * naming a provider, an exact tool, a resource and an environment); it never
 * names a connector id or a credential. The answer reuses discovery
 * (connector-capabilities.ts: connectors, shares, workspace enablement, role
 * connectorRefs, credential health, catalog policy) and adds two things:
 *
 *   1. team policy (`capability_policies`): per provider and risk, optionally
 *      per workspace / role / environment / resource, the effect is
 *      auto_grant, ask_human or forbidden. No rule = DEFAULT_EFFECT.
 *   2. a grant (`capability_grants`): bound to one team, workspace, task,
 *      worker and role, one provider (and connector), one risk, and the exact
 *      tool / resource / environment asked for, with a TTL.
 *
 * Ceilings that no rule and no request can lift:
 *   - write and admin risk always need a person (`auto_grant` is clamped to
 *     `ask_human`), even when the role already mounts the connector;
 *   - a catalog block or a workspace disable is a hard deny a person cannot
 *     approve past; only the admin who set it can lift it;
 *   - a grant dies with its task (terminal), its worker (not live), a role
 *     change, a policy that now forbids it or no longer auto-grants it, a
 *     catalog block, or a dead credential. Every use re-checks all of these
 *     (`checkGrantUse`), so a revoke stops the next call.
 *
 * Spec: docs/specs/capability-requests.md
 */
import { isLiveWorkerStatus, isOpenTaskStatus } from '@buildd/shared';
import type { CapabilityCandidate, CapabilityResolution } from './connector-capabilities';
import { parseCapability } from './connector-capabilities';
import {
  MODEL_INFERENCE_CAPABILITY,
  MODEL_INFERENCE_OPERATIONS,
  isSaneModelInferenceBudget,
  type ModelInferenceBudget,
  type ModelInferenceGrant,
  type ModelInferenceOperation,
  type ModelInferenceProvider,
} from './capability-model-inference';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const CAPABILITY_RISKS = ['read', 'query', 'write', 'admin'] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];
const RISK_RANK: Record<CapabilityRisk, number> = { read: 0, query: 1, write: 2, admin: 3 };
export const riskAtLeast = (a: CapabilityRisk, b: CapabilityRisk) => RISK_RANK[a] >= RISK_RANK[b];
const maxRisk = (...rs: CapabilityRisk[]) => rs.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));
export const isWriteRisk = (r: CapabilityRisk) => r === 'write' || r === 'admin';

export const POLICY_EFFECTS = ['auto_grant', 'ask_human', 'forbidden'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];
const EFFECT_RANK: Record<PolicyEffect, number> = { auto_grant: 0, ask_human: 1, forbidden: 2 };

export const GRANT_STATUSES = ['pending', 'granted', 'denied', 'revoked', 'expired'] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const DEFAULT_GRANT_TTL_SECONDS = 60 * 60;
export const MIN_GRANT_TTL_SECONDS = 60;
export const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;

export const MODEL_INFERENCE_PROVIDERS: readonly ModelInferenceProvider[] = ['openrouter', 'litellm'];

/**
 * A tool's risk from its name: read verbs read, destructive or authority verbs
 * are admin, anything else is a write. Unknown names fail closed (write), so a
 * read grant never covers a tool it cannot name as a read.
 */
const READ_VERBS = /^(get|list|query|search|read|describe|fetch|find|show|view|count|explain|lookup|check|inspect|retrieve|stat|head|tail|download|export|summari[sz]e)(?=[_\-.A-Z0-9]|$)/;
const ADMIN_VERBS = /^(delete|drop|destroy|remove|purge|truncate|revoke|grant|rotate|transfer|invite|ban|disable|reset|wipe)(?=[_\-.A-Z0-9]|$)/;
export function classifyToolRisk(tool: string): CapabilityRisk {
  // Native MCP names are `mcp__<server>__<tool>`; classify the tool part.
  const name = tool.split('__').pop() ?? tool;
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  if (ADMIN_VERBS.test(lower)) return 'admin';
  if (READ_VERBS.test(lower)) return 'read';
  return 'write';
}

// ── Request parsing ──────────────────────────────────────────────────────────

export interface ModelInferenceScope {
  models: string[];
  operations: ModelInferenceOperation[];
  budget: ModelInferenceBudget;
}

export interface CapabilityRequest {
  /** `domain:verb`, or `model.inference`. */
  capability: string;
  provider: string | null;
  tool: string | null;
  resource: string | null;
  environment: string | null;
  /** The effective risk: never lower than the verb's or the tool's. */
  risk: CapabilityRisk;
  ttlSeconds: number;
  reason: string | null;
  /** model.inference only. */
  modelInference: ModelInferenceScope | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const RESOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/;
const ENV_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const ALLOWED_KEYS = new Set(['capability', 'provider', 'tool', 'resource', 'environment', 'risk', 'ttlSeconds', 'reason', 'models', 'operations', 'budget']);
/** Things an agent must never hand the broker: it names needs, not plumbing. */
const FORBIDDEN_KEYS = ['connectorId', 'credentialRef', 'apiKey', 'token', 'baseURL', 'endpoint', 'headers', 'url'];

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function optStr(v: unknown, re: RegExp, field: string): Parse<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !re.test(v.trim())) return { ok: false, error: `invalid ${field}` };
  return { ok: true, value: v.trim() };
}

export function parseCapabilityRequest(body: unknown): { ok: true; request: CapabilityRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;
  for (const k of FORBIDDEN_KEYS) {
    if (k in b) return { ok: false, error: `${k} is not accepted: ask for a capability (domain:verb) and optionally a provider; buildd picks the connector and holds the credential` };
  }
  for (const k of Object.keys(b)) if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown field ${k}` };

  const capability = typeof b.capability === 'string' ? b.capability.trim().toLowerCase() : '';
  const provider = optStr(typeof b.provider === 'string' ? b.provider.toLowerCase() : b.provider, SLUG_RE, 'provider');
  const tool = optStr(b.tool, TOOL_RE, 'tool');
  const resource = optStr(b.resource, RESOURCE_RE, 'resource');
  const environment = optStr(typeof b.environment === 'string' ? b.environment.toLowerCase() : b.environment, ENV_RE, 'environment');
  for (const p of [provider, tool, resource, environment]) if (!p.ok) return { ok: false, error: p.error };
  const val = <T,>(p: Parse<T>) => (p as { ok: true; value: T }).value;

  let declared: CapabilityRisk | null = null;
  if (b.risk !== undefined && b.risk !== null) {
    if (typeof b.risk !== 'string' || !(CAPABILITY_RISKS as readonly string[]).includes(b.risk)) return { ok: false, error: `risk must be one of ${CAPABILITY_RISKS.join(', ')}` };
    declared = b.risk as CapabilityRisk;
  }

  let ttlSeconds = DEFAULT_GRANT_TTL_SECONDS;
  if (b.ttlSeconds !== undefined && b.ttlSeconds !== null) {
    if (typeof b.ttlSeconds !== 'number' || !Number.isInteger(b.ttlSeconds) || b.ttlSeconds < MIN_GRANT_TTL_SECONDS || b.ttlSeconds > MAX_GRANT_TTL_SECONDS) {
      return { ok: false, error: `ttlSeconds must be an integer between ${MIN_GRANT_TTL_SECONDS} and ${MAX_GRANT_TTL_SECONDS}` };
    }
    ttlSeconds = b.ttlSeconds;
  }
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;

  if (capability === MODEL_INFERENCE_CAPABILITY) {
    const p = val(provider);
    if (!p || !(MODEL_INFERENCE_PROVIDERS as readonly string[]).includes(p)) return { ok: false, error: `model.inference needs provider ${MODEL_INFERENCE_PROVIDERS.join(' or ')}` };
    const models = Array.isArray(b.models) ? b.models : [];
    if (models.length < 1 || models.length > 5 || !models.every(m => typeof m === 'string' && MODEL_ID_RE.test(m))) {
      return { ok: false, error: 'model.inference needs models: 1-5 exact model ids' };
    }
    const operations = Array.isArray(b.operations) && b.operations.length > 0 ? b.operations : ['decide'];
    if (!operations.every(o => (MODEL_INFERENCE_OPERATIONS as readonly string[]).includes(o as string))) {
      return { ok: false, error: `operations must be from ${MODEL_INFERENCE_OPERATIONS.join(', ')}` };
    }
    if (!isSaneModelInferenceBudget(b.budget as ModelInferenceBudget)) return { ok: false, error: 'model.inference needs a budget inside MODEL_INFERENCE_LIMITS' };
    if (val(tool) || val(resource) || val(environment)) return { ok: false, error: 'model.inference takes models, not tool/resource/environment' };
    return {
      ok: true,
      request: {
        capability, provider: p, tool: null, resource: null, environment: null,
        risk: maxRisk('query', declared ?? 'query'), ttlSeconds, reason,
        modelInference: { models: [...new Set(models as string[])].sort(), operations: [...new Set(operations as ModelInferenceOperation[])], budget: b.budget as ModelInferenceBudget },
      },
    };
  }

  const parsed = parseCapability(capability);
  if (!parsed) return { ok: false, error: `Unknown capability "${capability}". Use domain:verb (e.g. observability:query) or model.inference.` };
  if (b.models !== undefined || b.operations !== undefined || b.budget !== undefined) return { ok: false, error: 'models/operations/budget are for model.inference only' };
  const t = val(tool);
  const risk = maxRisk(parsed.verb, declared ?? parsed.verb, t ? classifyToolRisk(t) : parsed.verb);
  return {
    ok: true,
    request: {
      capability: `${parsed.domain}:${parsed.verb}`, provider: val(provider), tool: t, resource: val(resource), environment: val(environment),
      risk, ttlSeconds, reason, modelInference: null,
    },
  };
}

// ── Team policy ──────────────────────────────────────────────────────────────

export interface PolicyRule {
  id?: string;
  provider: string;
  risk: CapabilityRisk;
  workspaceId: string | null;
  roleSlug: string | null;
  environment: string | null;
  resource: string | null;
  effect: PolicyEffect;
  maxTtlSeconds: number | null;
}

/** One rule per scope: the canonical key of its match columns. */
export function policyScopeKey(r: Pick<PolicyRule, 'provider' | 'risk' | 'workspaceId' | 'roleSlug' | 'environment' | 'resource'>): string {
  return [r.provider, r.risk, r.workspaceId ?? '*', r.roleSlug ?? '*', r.environment ?? '*', r.resource ?? '*'].join('|');
}

export function parsePolicyRule(body: unknown): { ok: true; rule: PolicyRule } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be an object' };
  const b = body as Record<string, unknown>;
  const provider = typeof b.provider === 'string' ? b.provider.trim().toLowerCase() : '';
  if (!SLUG_RE.test(provider)) return { ok: false, error: 'provider must be a catalog slug (e.g. axiom)' };
  if (typeof b.risk !== 'string' || !(CAPABILITY_RISKS as readonly string[]).includes(b.risk)) return { ok: false, error: `risk must be one of ${CAPABILITY_RISKS.join(', ')}` };
  if (typeof b.effect !== 'string' || !(POLICY_EFFECTS as readonly string[]).includes(b.effect)) return { ok: false, error: `effect must be one of ${POLICY_EFFECTS.join(', ')}` };
  const risk = b.risk as CapabilityRisk;
  const effect = b.effect as PolicyEffect;
  if (effect === 'auto_grant' && isWriteRisk(risk)) return { ok: false, error: 'write and admin access always need a person: auto_grant is only for read and query' };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ws = optStr(b.workspaceId, UUID, 'workspaceId');
  const role = optStr(b.roleSlug, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'roleSlug');
  const env = optStr(typeof b.environment === 'string' ? b.environment.toLowerCase() : b.environment, ENV_RE, 'environment');
  const res = optStr(b.resource, RESOURCE_RE, 'resource');
  for (const p of [ws, role, env, res]) if (!p.ok) return { ok: false, error: p.error };
  let maxTtlSeconds: number | null = null;
  if (b.maxTtlSeconds !== undefined && b.maxTtlSeconds !== null) {
    if (typeof b.maxTtlSeconds !== 'number' || !Number.isInteger(b.maxTtlSeconds) || b.maxTtlSeconds < MIN_GRANT_TTL_SECONDS || b.maxTtlSeconds > MAX_GRANT_TTL_SECONDS) {
      return { ok: false, error: `maxTtlSeconds must be an integer between ${MIN_GRANT_TTL_SECONDS} and ${MAX_GRANT_TTL_SECONDS}` };
    }
    maxTtlSeconds = b.maxTtlSeconds;
  }
  const v = <T,>(p: Parse<T>) => (p as { ok: true; value: T }).value;
  return { ok: true, rule: { provider, risk, workspaceId: v(ws), roleSlug: v(role), environment: v(env), resource: v(res), effect, maxTtlSeconds } };
}

export interface PolicyScope {
  provider: string;
  risk: CapabilityRisk;
  workspaceId: string;
  roleSlug: string | null;
  environment: string | null;
  resource: string | null;
}

export interface EffectivePolicy {
  effect: PolicyEffect;
  maxTtlSeconds: number;
  source: 'rule' | 'default';
  ruleId: string | null;
  /** True when a rule asked for auto_grant on write/admin and the ceiling held it to ask_human. */
  clamped: boolean;
}

/**
 * The built-in effect with no team rule: read/query auto-grant only where the
 * team already trusts agents with the connector (some role in the workspace
 * mounts it); everything else asks a person. Installing or preinstalling a
 * connector on its own never grants an agent anything.
 */
export function defaultEffect(risk: CapabilityRisk, someRoleMounts: boolean): PolicyEffect {
  if (isWriteRisk(risk)) return 'ask_human';
  return someRoleMounts ? 'auto_grant' : 'ask_human';
}

/**
 * The rule that applies: every set dimension equals the scope's; the most
 * specific wins; among equally specific rules the most restrictive wins.
 */
export function matchPolicy(rules: readonly PolicyRule[], scope: PolicyScope): PolicyRule | null {
  let best: PolicyRule | null = null;
  let bestSpec = -1;
  for (const r of rules) {
    if (r.provider !== scope.provider || r.risk !== scope.risk) continue;
    if (r.workspaceId && r.workspaceId !== scope.workspaceId) continue;
    if (r.roleSlug && r.roleSlug !== scope.roleSlug) continue;
    if (r.environment && r.environment !== scope.environment) continue;
    if (r.resource && r.resource !== scope.resource) continue;
    const spec = [r.workspaceId, r.roleSlug, r.environment, r.resource].filter(Boolean).length;
    if (spec > bestSpec || (spec === bestSpec && best && EFFECT_RANK[r.effect] > EFFECT_RANK[best.effect])) {
      best = r;
      bestSpec = spec;
    }
  }
  return best;
}

export function effectivePolicy(rules: readonly PolicyRule[], scope: PolicyScope, someRoleMounts: boolean): EffectivePolicy {
  const rule = matchPolicy(rules, scope);
  if (!rule) return { effect: defaultEffect(scope.risk, someRoleMounts), maxTtlSeconds: MAX_GRANT_TTL_SECONDS, source: 'default', ruleId: null, clamped: false };
  const clamped = rule.effect === 'auto_grant' && isWriteRisk(scope.risk);
  return {
    effect: clamped ? 'ask_human' : rule.effect,
    maxTtlSeconds: Math.min(rule.maxTtlSeconds ?? MAX_GRANT_TTL_SECONDS, MAX_GRANT_TTL_SECONDS),
    source: 'rule',
    ruleId: rule.id ?? null,
    clamped,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * What a request resolves to.
 *   existing          the role already mounts it (read/query), or a live grant covers it
 *   auto_granted      policy granted it now
 *   pending_approval  a team admin must approve (deduped: same row on a repeat)
 *   denied            a person already denied this exact request for this worker
 *   forbidden         catalog block, workspace disable or a forbidding rule
 *   need_connection   nothing installed, or installed but never connected
 *   need_reauth       the credential is revoked or past refresh
 *   unhealthy         recent auth failures
 *   unavailable       nothing serves it (with alternatives)
 */
export type ResolutionKind =
  | 'existing' | 'auto_granted' | 'pending_approval' | 'denied'
  | 'forbidden' | 'need_connection' | 'need_reauth' | 'unhealthy' | 'unavailable';

const KIND_RANK: Record<ResolutionKind, number> = {
  existing: 0, auto_granted: 1, pending_approval: 2, need_reauth: 3, unhealthy: 4, need_connection: 5, denied: 6, forbidden: 7, unavailable: 8,
};

export interface GrantTarget {
  provider: string;
  connectorId: string | null;
  connectorName: string | null;
}

export interface Alternative {
  provider: string;
  connector: string | null;
  outcome: ResolutionKind;
  nextSteps: string[];
}

export interface CandidateDecision {
  kind: Exclude<ResolutionKind, 'denied' | 'unavailable'>;
  target: GrantTarget;
  reasonCode: string;
  policy: EffectivePolicy | null;
  nextSteps: string[];
}

/** The grant row fields the rules read. */
export interface GrantRecord {
  id: string;
  teamId: string;
  workspaceId: string;
  taskId: string;
  workerId: string;
  roleSlug: string | null;
  capability: string;
  provider: string;
  connectorId: string | null;
  risk: CapabilityRisk;
  tool: string | null;
  resource: string | null;
  environment: string | null;
  scope: Record<string, unknown> | null;
  status: GrantStatus;
  decidedBy: 'policy' | 'human' | 'system' | null;
  ttlSeconds: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  dedupeKey: string;
}

export interface RequestPrincipal {
  teamId: string;
  workspaceId: string;
  taskId: string;
  workerId: string;
  roleSlug: string | null;
}

/** Does a live grant cover this request? Exact tool/resource/environment; risk at least as high. */
export function grantCovers(g: GrantRecord, req: CapabilityRequest, target: GrantTarget, now: Date): boolean {
  return g.status === 'granted'
    && !g.revokedAt && !!g.expiresAt && g.expiresAt.getTime() > now.getTime()
    && g.capability === req.capability
    && g.provider === target.provider
    && (g.connectorId ?? null) === (target.connectorId ?? null)
    && riskAtLeast(g.risk, req.risk)
    && (g.tool ?? null) === req.tool
    && (g.resource ?? null) === req.resource
    && (g.environment ?? null) === req.environment;
}

function decideCandidate(
  c: CapabilityCandidate,
  req: CapabilityRequest,
  principal: RequestPrincipal,
  rules: readonly PolicyRule[],
): CandidateDecision {
  const target: GrantTarget = { provider: c.provider.slug ?? c.provider.name, connectorId: c.connector?.id ?? null, connectorName: c.connector?.name ?? null };
  const base = { target, nextSteps: c.nextSteps };
  if (c.access === 'forbidden') return { ...base, kind: 'forbidden', reasonCode: 'catalog_blocked', policy: null };
  if (!c.connector) return { ...base, kind: 'need_connection', reasonCode: 'not_installed', policy: null };
  if (c.workspace === 'disabled') return { ...base, kind: 'forbidden', reasonCode: 'disabled_in_workspace', policy: null };
  if (c.health === 'not_connected') return { ...base, kind: 'need_connection', reasonCode: 'not_connected', policy: null };
  if (c.access === 'reconnect') return { ...base, kind: 'need_reauth', reasonCode: 'credential_dead', policy: null };
  if (c.access === 'unhealthy') return { ...base, kind: 'unhealthy', reasonCode: 'credential_degraded', policy: null };

  const policy = effectivePolicy(rules, {
    provider: target.provider, risk: req.risk, workspaceId: principal.workspaceId,
    roleSlug: principal.roleSlug, environment: req.environment, resource: req.resource,
  }, c.roles.withAccess.length > 0);
  if (policy.effect === 'forbidden') {
    return { ...base, kind: 'forbidden', reasonCode: 'policy_forbidden', policy, nextSteps: ['A team admin has forbidden this access in capability policy.'] };
  }
  // The role mounts it already: nothing to grant for a read. A write still goes
  // through a person (the provider write guard), mount or not.
  if (c.access === 'permitted' && c.roles.evaluated?.mounts && !isWriteRisk(req.risk)) {
    return { ...base, kind: 'existing', reasonCode: 'role_mounts_connector', policy };
  }
  if (policy.effect === 'auto_grant') return { ...base, kind: 'auto_granted', reasonCode: policy.source === 'rule' ? 'policy_auto_grant' : 'default_auto_grant', policy };
  return {
    ...base, kind: 'pending_approval', reasonCode: isWriteRisk(req.risk) ? 'write_needs_human' : 'policy_ask_human', policy,
    nextSteps: ['A team admin approves or denies this request on Settings → MCP connectors.'],
  };
}

export interface ResolveContext {
  request: CapabilityRequest;
  principal: RequestPrincipal;
  /** resolveCapability for the request's capability under the task's role; null for model.inference. */
  discovery: CapabilityResolution | null;
  rules: readonly PolicyRule[];
  /** This worker's open grants (pending or granted). */
  openGrants: readonly GrantRecord[];
  /** This worker's denied requests, by dedupe key. */
  deniedKeys: ReadonlySet<string>;
  dedupeKeyFor: (target: GrantTarget) => string;
  now: Date;
}

export interface Resolution {
  kind: ResolutionKind;
  reasonCode: string;
  target: GrantTarget | null;
  policy: EffectivePolicy | null;
  /** For auto_granted / pending_approval: the TTL the grant gets once live. */
  ttlSeconds: number;
  /** An open row this resolution reuses (existing grant, or the pending request). */
  grantId: string | null;
  nextSteps: string[];
  alternatives: Alternative[];
}

const clampTtl = (req: number, policyMax: number | undefined) => Math.max(MIN_GRANT_TTL_SECONDS, Math.min(req, policyMax ?? MAX_GRANT_TTL_SECONDS, MAX_GRANT_TTL_SECONDS));

/**
 * Pick the best way to satisfy a request. Candidates come from discovery
 * (already ranked), narrowed to the requested provider. The best decision
 * wins; the rest come back as alternatives, with discovery's own hint when
 * another role already mounts it.
 */
export function resolveCapabilityRequest(ctx: ResolveContext): Resolution {
  const { request: req, principal } = ctx;

  let decisions: CandidateDecision[];
  if (req.modelInference) {
    // No connector: the provider is the team's decision route. Policy alone decides.
    const target: GrantTarget = { provider: req.provider!, connectorId: null, connectorName: null };
    const policy = effectivePolicy(ctx.rules, {
      provider: target.provider, risk: req.risk, workspaceId: principal.workspaceId,
      roleSlug: principal.roleSlug, environment: null, resource: null,
    }, false);
    decisions = [{
      kind: policy.effect === 'forbidden' ? 'forbidden' : policy.effect === 'auto_grant' ? 'auto_granted' : 'pending_approval',
      target,
      reasonCode: policy.effect === 'forbidden' ? 'policy_forbidden' : policy.effect === 'auto_grant' ? 'policy_auto_grant' : 'policy_ask_human',
      policy,
      nextSteps: policy.effect === 'ask_human' ? ['A team admin approves or denies this request.'] : [],
    }];
  } else {
    const all = ctx.discovery?.candidates ?? [];
    const wanted = req.provider ? all.filter(c => c.provider.slug === req.provider) : all;
    if (wanted.length === 0) {
      return {
        kind: 'unavailable', reasonCode: req.provider ? 'provider_not_serving' : 'no_candidates', target: null, policy: null,
        ttlSeconds: 0, grantId: null,
        nextSteps: req.provider
          ? [`Nothing from ${req.provider} serves ${req.capability} here.`]
          : [ctx.discovery?.summary ?? `Nothing serves ${req.capability} here. A team admin can add a connector for it.`],
        alternatives: all.slice(0, 5).map(c => ({ provider: c.provider.slug ?? c.provider.name, connector: c.connector?.name ?? null, outcome: decideCandidate(c, req, principal, ctx.rules).kind, nextSteps: c.nextSteps })),
      };
    }
    decisions = wanted.map(c => decideCandidate(c, req, principal, ctx.rules));
  }

  // A live grant covering the request is "existing", whatever the policy says
  // now about NEW grants... unless that policy now forbids it.
  for (const d of decisions) {
    if (d.kind === 'forbidden') continue;
    const g = ctx.openGrants.find(x => grantCovers(x, req, d.target, ctx.now));
    if (g) return finish({ ...d, kind: 'existing', reasonCode: 'live_grant' }, g.id);
  }

  decisions.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const best = decisions[0];

  if (best.kind === 'auto_granted' || best.kind === 'pending_approval') {
    const key = ctx.dedupeKeyFor(best.target);
    if (ctx.deniedKeys.has(key)) {
      return finish({ ...best, kind: 'denied', reasonCode: 'already_denied', nextSteps: ['A person denied this exact request for this run; ask for something narrower or explain in a note.'] }, null);
    }
    const pending = ctx.openGrants.find(g => g.status === 'pending' && g.dedupeKey === key);
    if (pending) return finish(best.kind === 'pending_approval' ? best : { ...best, kind: 'pending_approval', reasonCode: 'already_pending' }, pending.id);
  }
  return finish(best, null);

  function finish(d: Omit<CandidateDecision, 'kind'> & { kind: ResolutionKind }, grantId: string | null): Resolution {
    return {
      kind: d.kind,
      reasonCode: d.reasonCode,
      target: d.target,
      policy: d.policy,
      ttlSeconds: clampTtl(req.ttlSeconds, d.policy?.maxTtlSeconds),
      grantId,
      nextSteps: d.nextSteps,
      alternatives: decisions
        .filter(x => x.target !== d.target)
        .slice(0, 5)
        .map(x => ({ provider: x.target.provider, connector: x.target.connectorName, outcome: x.kind, nextSteps: x.nextSteps })),
    };
  }
}

// ── Use-time check ───────────────────────────────────────────────────────────

/** One call an agent is about to make under a grant. */
export interface CapabilityUse {
  capability: string;
  provider: string;
  connectorId: string | null;
  tool: string | null;
  resource: string | null;
  environment: string | null;
}

/** Live facts read fresh for every use; nothing here is cached from grant time. */
export interface UseContext {
  principal: RequestPrincipal;
  taskStatus: string;
  workerStatus: string;
  rules: readonly PolicyRule[];
  /** The connector's discovery candidate now; null for model.inference or when no longer visible. */
  candidate: CapabilityCandidate | null;
  now: Date;
}

export type UseRefusal =
  | 'grant_mismatch' | 'grant_not_live' | 'grant_expired' | 'task_terminal' | 'worker_not_live' | 'role_changed'
  | 'target_mismatch' | 'tool_not_granted' | 'tool_risk_exceeds_grant' | 'resource_not_granted' | 'environment_not_granted'
  | 'policy_forbidden' | 'policy_tightened' | 'catalog_blocked' | 'disabled_in_workspace' | 'connector_gone' | 'credential_dead';

/**
 * May this grant be used for this call, now? Every check re-reads live state:
 * a revoke, a terminal task, a role change, a tightened policy, a catalog
 * block or a dead credential each stop the next call.
 */
export function checkGrantUse(g: GrantRecord, use: CapabilityUse, ctx: UseContext): UseRefusal | null {
  const p = ctx.principal;
  if (g.teamId !== p.teamId || g.workspaceId !== p.workspaceId || g.taskId !== p.taskId || g.workerId !== p.workerId) return 'grant_mismatch';
  if (g.status !== 'granted' || g.revokedAt) return 'grant_not_live';
  if (!g.expiresAt || g.expiresAt.getTime() <= ctx.now.getTime()) return 'grant_expired';
  if (!isOpenTaskStatus(ctx.taskStatus)) return 'task_terminal';
  if (!isLiveWorkerStatus(ctx.workerStatus)) return 'worker_not_live';
  if ((g.roleSlug ?? null) !== (p.roleSlug ?? null)) return 'role_changed';
  if (g.capability !== use.capability || g.provider !== use.provider || (g.connectorId ?? null) !== (use.connectorId ?? null)) return 'target_mismatch';
  if (g.tool) {
    if (use.tool !== g.tool) return 'tool_not_granted';
  } else if (use.tool && !riskAtLeast(g.risk, classifyToolRisk(use.tool))) {
    return 'tool_risk_exceeds_grant';
  }
  if (g.resource && use.resource !== g.resource) return 'resource_not_granted';
  if (g.environment && use.environment !== g.environment) return 'environment_not_granted';

  if (g.connectorId) {
    const c = ctx.candidate;
    if (!c || c.connector?.id !== g.connectorId) return 'connector_gone';
    if (c.access === 'forbidden') return 'catalog_blocked';
    if (c.workspace === 'disabled') return 'disabled_in_workspace';
    if (c.access === 'reconnect') return 'credential_dead';
  }
  const policy = effectivePolicy(ctx.rules, {
    provider: g.provider, risk: g.risk, workspaceId: g.workspaceId, roleSlug: g.roleSlug,
    environment: use.environment, resource: use.resource,
  }, (ctx.candidate?.roles.withAccess.length ?? 0) > 0);
  if (policy.effect === 'forbidden') return 'policy_forbidden';
  // A policy grant stands only while policy would still grant it; a person's
  // approval stands until revoked or a rule forbids it.
  if (g.decidedBy === 'policy' && policy.effect !== 'auto_grant') return 'policy_tightened';
  return null;
}

// ── Approval checks ──────────────────────────────────────────────────────────

export type ApprovalRefusal = 'task_terminal' | 'worker_not_live' | 'role_changed' | 'policy_forbidden' | 'catalog_blocked' | 'disabled_in_workspace' | 'connector_gone';

/**
 * Can a person approve this pending request now? A person may grant above
 * the auto-grant line (that is the point), never past a forbid, a catalog
 * block or a workspace disable, and never for a run that has ended.
 */
export function approvalRefusal(g: GrantRecord, ctx: Omit<UseContext, 'principal' | 'now'> & { currentRoleSlug: string | null }): ApprovalRefusal | null {
  if (!isOpenTaskStatus(ctx.taskStatus)) return 'task_terminal';
  if (!isLiveWorkerStatus(ctx.workerStatus)) return 'worker_not_live';
  if ((g.roleSlug ?? null) !== (ctx.currentRoleSlug ?? null)) return 'role_changed';
  if (g.connectorId) {
    const c = ctx.candidate;
    if (!c || c.connector?.id !== g.connectorId) return 'connector_gone';
    if (c.access === 'forbidden') return 'catalog_blocked';
    if (c.workspace === 'disabled') return 'disabled_in_workspace';
  }
  const policy = effectivePolicy(ctx.rules, {
    provider: g.provider, risk: g.risk, workspaceId: g.workspaceId, roleSlug: g.roleSlug,
    environment: g.environment, resource: g.resource,
  }, (ctx.candidate?.roles.withAccess.length ?? 0) > 0);
  if (policy.effect === 'forbidden') return 'policy_forbidden';
  return null;
}

/** The TTL an approval gives: the request's, narrowed by the approver and policy. */
export function approvalTtl(requested: number, approverTtl: number | null | undefined, policyMax: number): number {
  return clampTtl(Math.min(requested, approverTtl ?? requested), policyMax);
}

// ── model.inference adapter ──────────────────────────────────────────────────

/** A stored model.inference grant in the shape the inference adapter checks. Null when malformed. */
export function toModelInferenceGrant(g: GrantRecord): ModelInferenceGrant | null {
  if (g.capability !== MODEL_INFERENCE_CAPABILITY || !g.expiresAt) return null;
  if (!(MODEL_INFERENCE_PROVIDERS as readonly string[]).includes(g.provider)) return null;
  const s = (g.scope ?? {}) as Partial<ModelInferenceScope>;
  if (!Array.isArray(s.models) || !Array.isArray(s.operations) || !isSaneModelInferenceBudget(s.budget as ModelInferenceBudget)) return null;
  return {
    grantId: g.id,
    capability: MODEL_INFERENCE_CAPABILITY,
    teamId: g.teamId,
    workspaceId: g.workspaceId,
    taskId: g.taskId,
    workerId: g.workerId,
    provider: g.provider as ModelInferenceProvider,
    models: s.models,
    operations: s.operations as ModelInferenceOperation[],
    expiresAt: g.expiresAt,
    revokedAt: g.revokedAt,
    budget: s.budget as ModelInferenceBudget,
  };
}
