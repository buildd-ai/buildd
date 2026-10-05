/**
 * What an agent role may do in one workspace: the effective grant of an agent
 * capability (permission-registry.ts, "Agent capabilities") and the deployment
 * targets it covers. Pure; the db read is operator-capability-source.ts.
 *
 * A grant is stored on the role's own rows, as `metadata.operator` (no
 * migration): the team default row (workspaceId NULL) and an optional
 * workspace override row, the same two rows effective-roles.ts resolves.
 *
 *   { enabled?: boolean,
 *     capabilities?: AgentCapability[],
 *     scope?: { providers?, projects?, environments?, credentialRefs? } }
 *
 * Resolution, all of it deny-by-default:
 *
 * - Only a role with a capability ceiling (ROLE_CAPABILITY_CEILINGS) is read
 *   at all. A builder row carrying `metadata.operator` grants nothing.
 * - The WORKSPACE must opt in with `enabled: true`. A team default can switch
 *   the role off everywhere (`enabled: false`) but cannot switch it on for a
 *   workspace that never asked. A disabled role row disables too.
 * - Capabilities: the team default's list (or the role's default set) is the
 *   ceiling; a workspace list narrows it. Elevated capabilities
 *   (`deployment_secrets:manage`, `secrets:reveal`) come only from an explicit
 *   workspace list: never from a default, never from the team row.
 * - Scope: each dimension is the workspace's list, intersected with the team
 *   default's list when the team sets one. A dimension the workspace leaves
 *   unset is empty, and empty allows nothing. There is no wildcard.
 */
import {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
  ELEVATED_AGENT_CAPABILITIES,
  defaultRoleCapabilities,
  isAgentCapability,
  roleMayHold,
  type AgentCapability,
  type AgentCapabilityTier,
} from './permission-registry';

export const SCOPE_DIMENSIONS = ['providers', 'projects', 'environments', 'credentialRefs'] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

export type DeploymentScope = Record<ScopeDimension, string[]>;

/** What is stored under `metadata.operator` on a role row, after sanitising. */
export interface OperatorGrantConfig {
  enabled?: boolean;
  capabilities?: AgentCapability[];
  scope?: Partial<DeploymentScope>;
}

export interface OperatorGrant {
  roleSlug: string;
  workspaceId: string;
  enabled: boolean;
  capabilities: AgentCapability[];
  scope: DeploymentScope;
}

/** One deploy target an action names. Credential refs are labels, never values. */
export interface DeploymentTarget {
  provider?: string;
  project?: string;
  environment?: string;
  credentialRef?: string;
}

export type AgentDenyReason =
  | 'role_not_capable'
  | 'not_enabled'
  | 'capability_not_granted'
  | 'provider_required'
  | 'project_required'
  | 'environment_required'
  | 'credential_ref_required'
  | 'provider_not_allowed'
  | 'project_not_allowed'
  | 'environment_not_allowed'
  | 'credential_ref_not_allowed';

export type AgentAuthorization = { allowed: true } | { allowed: false; reason: AgentDenyReason };

export interface RoleGrantRow {
  enabled?: boolean | null;
  metadata?: unknown;
}

const EMPTY_SCOPE = (): DeploymentScope => ({ providers: [], projects: [], environments: [], credentialRefs: [] });

/** Scope values compare trimmed and lower-cased. */
function normaliseValue(v: string): string {
  return v.trim().toLowerCase();
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string').map(normaliseValue).filter(v => v.length > 0 && v !== '*');
  return [...new Set(out)];
}

/**
 * Read a stored `metadata.operator` defensively: unknown capabilities, unknown
 * scope keys, non-strings and the `*` wildcard are dropped, never trusted.
 * Anything that is not an object reads as no config.
 */
export function sanitizeOperatorGrantConfig(raw: unknown): OperatorGrantConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: OperatorGrantConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (Array.isArray(r.capabilities)) out.capabilities = [...new Set(r.capabilities.filter(isAgentCapability))];
  if (r.scope && typeof r.scope === 'object' && !Array.isArray(r.scope)) {
    const s = r.scope as Record<string, unknown>;
    const scope: Partial<DeploymentScope> = {};
    for (const dim of SCOPE_DIMENSIONS) {
      const list = stringList(s[dim]);
      if (list) scope[dim] = list;
    }
    out.scope = scope;
  }
  return out;
}

/**
 * Validate a grant an admin submits. Strict, unlike the sanitiser: an unknown
 * capability, scope key or a wildcard is an error, so a typo is reported
 * instead of silently granting less (or more) than meant.
 */
export function parseOperatorGrantInput(
  raw: unknown,
): { ok: true; config: OperatorGrantConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'operator grant must be an object' };
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!['enabled', 'capabilities', 'scope'].includes(key)) return { ok: false, error: `Unknown field: ${key}` };
  }
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
  if (r.capabilities !== undefined) {
    if (!Array.isArray(r.capabilities)) return { ok: false, error: 'capabilities must be an array' };
    const bad = r.capabilities.find(c => !isAgentCapability(c));
    if (bad !== undefined) return { ok: false, error: `Unknown capability: ${JSON.stringify(bad)}` };
  }
  if (r.scope !== undefined) {
    if (!r.scope || typeof r.scope !== 'object' || Array.isArray(r.scope)) return { ok: false, error: 'scope must be an object' };
    for (const [dim, list] of Object.entries(r.scope as Record<string, unknown>)) {
      if (!(SCOPE_DIMENSIONS as readonly string[]).includes(dim)) return { ok: false, error: `Unknown scope dimension: ${dim}` };
      if (!Array.isArray(list) || list.some(v => typeof v !== 'string' || v.trim() === '')) {
        return { ok: false, error: `scope.${dim} must be an array of non-empty strings` };
      }
      if (list.some(v => (v as string).trim() === '*')) return { ok: false, error: `scope.${dim}: wildcards are not allowed; name each target` };
    }
  }
  return { ok: true, config: sanitizeOperatorGrantConfig(r) ?? {} };
}

function configOf(row: RoleGrantRow | null | undefined): OperatorGrantConfig | null {
  if (!row?.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return null;
  return sanitizeOperatorGrantConfig((row.metadata as Record<string, unknown>).operator);
}

/**
 * The effective grant of `roleSlug` in `workspaceId`, from its team default row
 * and its workspace override row (either may be absent). See the file header
 * for the rules.
 */
export function resolveOperatorGrant(input: {
  roleSlug: string;
  workspaceId: string;
  teamRow?: RoleGrantRow | null;
  workspaceRow?: RoleGrantRow | null;
}): OperatorGrant {
  const { roleSlug, workspaceId, teamRow, workspaceRow } = input;
  const denied: OperatorGrant = { roleSlug, workspaceId, enabled: false, capabilities: [], scope: EMPTY_SCOPE() };

  if (!AGENT_CAPABILITY_NAMES.some(c => roleMayHold(roleSlug, c))) return denied;
  if (teamRow?.enabled === false || workspaceRow?.enabled === false) return denied;

  const team = configOf(teamRow);
  const ws = configOf(workspaceRow);
  if (team?.enabled === false || ws?.enabled !== true) return denied;

  const ceiling = (team?.capabilities ?? defaultRoleCapabilities(roleSlug)).filter(c => roleMayHold(roleSlug, c) && !ELEVATED_AGENT_CAPABILITIES.has(c));
  const standard = ws.capabilities ? ceiling.filter(c => ws.capabilities!.includes(c)) : ceiling;
  const elevated = (ws.capabilities ?? []).filter(c => ELEVATED_AGENT_CAPABILITIES.has(c) && roleMayHold(roleSlug, c));
  const capabilities = AGENT_CAPABILITY_NAMES.filter(c => standard.includes(c) || elevated.includes(c));

  const scope = EMPTY_SCOPE();
  for (const dim of SCOPE_DIMENSIONS) {
    const own = ws.scope?.[dim] ?? [];
    const cap = team?.scope?.[dim];
    scope[dim] = cap ? own.filter(v => cap.includes(v)) : own;
  }
  return { roleSlug, workspaceId, enabled: true, capabilities, scope };
}

/** Which target fields each capability must name. A named optional field is still checked. */
const REQUIRED_TARGET: Record<AgentCapability, ReadonlyArray<keyof DeploymentTarget>> = {
  'deployments:read': ['provider', 'project', 'environment'],
  'deployments:write': ['provider', 'project', 'environment'],
  'deployment_secrets:use': ['provider', 'project', 'environment', 'credentialRef'],
  'deployment_secrets:manage': ['provider', 'credentialRef'],
  'secrets:reveal': ['credentialRef'],
};

const TARGET_DIMENSION: Record<keyof DeploymentTarget, { dim: ScopeDimension; required: AgentDenyReason; notAllowed: AgentDenyReason }> = {
  provider: { dim: 'providers', required: 'provider_required', notAllowed: 'provider_not_allowed' },
  project: { dim: 'projects', required: 'project_required', notAllowed: 'project_not_allowed' },
  environment: { dim: 'environments', required: 'environment_required', notAllowed: 'environment_not_allowed' },
  credentialRef: { dim: 'credentialRefs', required: 'credential_ref_required', notAllowed: 'credential_ref_not_allowed' },
};

/**
 * Whether `grant` covers `capability` against `target`. Every target field the
 * capability requires must be named and in scope; an optional field that is
 * named must be in scope too.
 */
export function authorizeAgent(
  grant: OperatorGrant | null | undefined,
  capability: AgentCapability,
  target: DeploymentTarget = {},
): AgentAuthorization {
  if (!grant || !roleMayHold(grant.roleSlug, capability)) return { allowed: false, reason: 'role_not_capable' };
  if (!grant.enabled) return { allowed: false, reason: 'not_enabled' };
  if (!grant.capabilities.includes(capability)) return { allowed: false, reason: 'capability_not_granted' };
  const required = REQUIRED_TARGET[capability];
  for (const field of Object.keys(TARGET_DIMENSION) as Array<keyof DeploymentTarget>) {
    const { dim, required: missing, notAllowed } = TARGET_DIMENSION[field];
    const value = target[field];
    if (value === undefined || value.trim() === '') {
      if (required.includes(field)) return { allowed: false, reason: missing };
      continue;
    }
    if (!grant.scope[dim].includes(normaliseValue(value))) return { allowed: false, reason: notAllowed };
  }
  return { allowed: true };
}

/**
 * The audit record of one authorization decision: who, where, what, and
 * whether elevated authority was used. Carries the credential REFERENCE only;
 * there is no field a credential value could go in.
 */
export interface AgentAuthorizationAudit {
  roleSlug: string;
  workspaceId: string;
  capability: AgentCapability;
  tier: AgentCapabilityTier;
  elevated: boolean;
  target: { provider: string | null; project: string | null; environment: string | null; credentialRef: string | null };
  allowed: boolean;
  reason: AgentDenyReason | null;
}

export function agentAuthorizationAudit(
  grant: Pick<OperatorGrant, 'roleSlug' | 'workspaceId'>,
  capability: AgentCapability,
  target: DeploymentTarget,
  decision: AgentAuthorization,
): AgentAuthorizationAudit {
  const tier = AGENT_CAPABILITIES[capability].tier;
  return {
    roleSlug: grant.roleSlug,
    workspaceId: grant.workspaceId,
    capability,
    tier,
    elevated: tier === 'elevated',
    target: {
      provider: target.provider ?? null,
      project: target.project ?? null,
      environment: target.environment ?? null,
      credentialRef: target.credentialRef ?? null,
    },
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  };
}
