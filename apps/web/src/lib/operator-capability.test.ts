import { describe, it, expect } from 'bun:test';
import {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
  ELEVATED_AGENT_CAPABILITIES,
  OPERATOR_ROLE_SLUG,
  PERMISSIONS,
  ROLE_CAPABILITY_CEILINGS,
  defaultRoleCapabilities,
  roleMayHold,
} from './permission-registry';
import {
  agentAuthorizationAudit,
  authorizeAgent,
  parseOperatorGrantInput,
  resolveOperatorGrant,
  sanitizeOperatorGrantConfig,
  withOperatorGrantMetadata,
  type DeploymentTarget,
} from './operator-capability';
import { DEFAULT_ROLES } from './default-roles';

const WS = 'ws-a';
const PROD: DeploymentTarget = { provider: 'cloudflare', project: 'model-policy', environment: 'production', credentialRef: 'cloudflare-prod' };

const row = (operator: unknown, enabled: boolean | null = true) => ({ enabled, metadata: { operator } });
const enabledWs = (over: Record<string, unknown> = {}) => row({
  enabled: true,
  scope: { providers: ['cloudflare'], projects: ['model-policy', 'cloud-runner'], environments: ['staging', 'production'], credentialRefs: ['cloudflare-prod'] },
  ...over,
});
const operatorIn = (workspaceRow: unknown, teamRow: unknown = null) =>
  resolveOperatorGrant({ roleSlug: OPERATOR_ROLE_SLUG, workspaceId: WS, teamRow: teamRow as never, workspaceRow: workspaceRow as never });

describe('agent capability registry', () => {
  it('splits deploy authority from credential management and reveal', () => {
    expect([...ELEVATED_AGENT_CAPABILITIES].sort()).toEqual(['deployment_secrets:manage', 'secrets:reveal']);
    for (const c of ['deployments:read', 'deployments:write', 'deployment_secrets:use'] as const) {
      expect(AGENT_CAPABILITIES[c].tier).toBe('standard');
    }
  });

  it('only the operator role has a ceiling; every other default role holds nothing', () => {
    expect(Object.keys(ROLE_CAPABILITY_CEILINGS)).toEqual([OPERATOR_ROLE_SLUG]);
    for (const role of DEFAULT_ROLES.filter(r => r.slug !== OPERATOR_ROLE_SLUG)) {
      expect({ slug: role.slug, caps: defaultRoleCapabilities(role.slug) }).toEqual({ slug: role.slug, caps: [] });
      for (const c of AGENT_CAPABILITY_NAMES) expect(roleMayHold(role.slug, c)).toBe(false);
    }
    expect(roleMayHold(null, 'deployments:read')).toBe(false);
  });

  it("the operator's default set never includes an elevated capability", () => {
    expect(defaultRoleCapabilities(OPERATOR_ROLE_SLUG)).toEqual(['deployments:read', 'deployments:write', 'deployment_secrets:use']);
  });

  it('is a separate namespace from team permissions', () => {
    for (const c of AGENT_CAPABILITY_NAMES) expect(Object.prototype.hasOwnProperty.call(PERMISSIONS, c)).toBe(false);
  });
});

describe('resolveOperatorGrant', () => {
  it('is disabled with no rows, and with only a team default (workspace must opt in)', () => {
    expect(operatorIn(null).enabled).toBe(false);
    const teamOnly = operatorIn(null, enabledWs());
    expect(teamOnly).toMatchObject({ enabled: false, capabilities: [] });
  });

  it('a workspace opt-in gets the standard set and its own scope', () => {
    const g = operatorIn(enabledWs());
    expect(g.enabled).toBe(true);
    expect(g.capabilities).toEqual(['deployments:read', 'deployments:write', 'deployment_secrets:use']);
    expect(g.scope.projects).toEqual(['model-policy', 'cloud-runner']);
  });

  it('a team default can switch the role off everywhere', () => {
    expect(operatorIn(enabledWs(), row({ enabled: false })).enabled).toBe(false);
  });

  it('a disabled role row (team or workspace) disables the grant', () => {
    expect(operatorIn(enabledWs(), { enabled: false, metadata: {} }).enabled).toBe(false);
    expect(operatorIn({ ...enabledWs(), enabled: false }).enabled).toBe(false);
  });

  it('the team default scope is a ceiling the workspace cannot widen', () => {
    const team = row({ scope: { providers: ['cloudflare'], environments: ['staging'] } });
    const g = operatorIn(enabledWs({ scope: { providers: ['cloudflare', 'vercel'], projects: ['model-policy'], environments: ['staging', 'production'], credentialRefs: ['cloudflare-prod'] } }), team);
    expect(g.scope.providers).toEqual(['cloudflare']);
    expect(g.scope.environments).toEqual(['staging']);
    // The team set no project list: the workspace's own stands.
    expect(g.scope.projects).toEqual(['model-policy']);
  });

  it('a workspace capability list narrows; the team list is a ceiling', () => {
    expect(operatorIn(enabledWs({ capabilities: ['deployments:read'] })).capabilities).toEqual(['deployments:read']);
    const team = row({ capabilities: ['deployments:read'] });
    expect(operatorIn(enabledWs({ capabilities: ['deployments:read', 'deployments:write'] }), team).capabilities).toEqual(['deployments:read']);
  });

  it('elevated capabilities come only from an explicit workspace grant, never the team row', () => {
    expect(operatorIn(enabledWs(), row({ capabilities: ['secrets:reveal', 'deployments:read'] })).capabilities).toEqual(['deployments:read']);
    const g = operatorIn(enabledWs({ capabilities: ['deployments:read', 'deployment_secrets:manage'] }));
    expect(g.capabilities).toEqual(['deployments:read', 'deployment_secrets:manage']);
    expect(g.capabilities).not.toContain('secrets:reveal');
  });

  it('existing roles gain nothing even when their rows carry an operator config', () => {
    for (const slug of ['builder', 'reviewer', 'organizer', 'a-team-role']) {
      const g = resolveOperatorGrant({ roleSlug: slug, workspaceId: WS, teamRow: enabledWs() as never, workspaceRow: enabledWs({ capabilities: [...AGENT_CAPABILITY_NAMES] }) as never });
      expect({ slug, enabled: g.enabled, caps: g.capabilities }).toEqual({ slug, enabled: false, caps: [] });
      expect(authorizeAgent(g, 'deployments:write', PROD)).toEqual({ allowed: false, reason: 'role_not_capable' });
    }
  });
});

describe('authorizeAgent', () => {
  const g = operatorIn(enabledWs());

  it('allows a deploy and credential use inside scope', () => {
    expect(authorizeAgent(g, 'deployments:write', PROD)).toEqual({ allowed: true });
    expect(authorizeAgent(g, 'deployment_secrets:use', PROD)).toEqual({ allowed: true });
    expect(authorizeAgent(g, 'deployments:read', { provider: ' Cloudflare ', project: 'model-policy', environment: 'staging' })).toEqual({ allowed: true });
  });

  it('denies a target outside each scope dimension', () => {
    expect(authorizeAgent(g, 'deployments:write', { ...PROD, provider: 'vercel' })).toEqual({ allowed: false, reason: 'provider_not_allowed' });
    expect(authorizeAgent(g, 'deployments:write', { ...PROD, project: 'other' })).toEqual({ allowed: false, reason: 'project_not_allowed' });
    expect(authorizeAgent(g, 'deployments:write', { ...PROD, environment: 'preview' })).toEqual({ allowed: false, reason: 'environment_not_allowed' });
    expect(authorizeAgent(g, 'deployment_secrets:use', { ...PROD, credentialRef: 'someone-elses' })).toEqual({ allowed: false, reason: 'credential_ref_not_allowed' });
  });

  it('requires the target fields each capability names', () => {
    expect(authorizeAgent(g, 'deployments:write', { provider: 'cloudflare', project: 'model-policy' })).toEqual({ allowed: false, reason: 'environment_required' });
    expect(authorizeAgent(g, 'deployment_secrets:use', { provider: 'cloudflare', project: 'model-policy', environment: 'production' })).toEqual({ allowed: false, reason: 'credential_ref_required' });
    expect(authorizeAgent(g, 'deployments:write', {})).toEqual({ allowed: false, reason: 'provider_required' });
  });

  it('secret use does not imply manage or reveal', () => {
    expect(authorizeAgent(g, 'deployment_secrets:manage', PROD)).toEqual({ allowed: false, reason: 'capability_not_granted' });
    expect(authorizeAgent(g, 'secrets:reveal', PROD)).toEqual({ allowed: false, reason: 'capability_not_granted' });
  });

  it('an explicit reveal grant is still scoped to its credential refs', () => {
    const r = operatorIn(enabledWs({ capabilities: ['secrets:reveal'] }));
    expect(authorizeAgent(r, 'secrets:reveal', { credentialRef: 'cloudflare-prod' })).toEqual({ allowed: true });
    expect(authorizeAgent(r, 'secrets:reveal', { credentialRef: 'other' })).toEqual({ allowed: false, reason: 'credential_ref_not_allowed' });
    // Reveal alone is not a deploy.
    expect(authorizeAgent(r, 'deployments:write', PROD)).toEqual({ allowed: false, reason: 'capability_not_granted' });
  });

  it('a workspace not enabled is not_enabled; a null grant is role_not_capable', () => {
    expect(authorizeAgent(operatorIn(null), 'deployments:read', PROD)).toEqual({ allowed: false, reason: 'not_enabled' });
    expect(authorizeAgent(null, 'deployments:read', PROD)).toEqual({ allowed: false, reason: 'role_not_capable' });
  });

  it('a grant is per workspace: the same role elsewhere holds nothing', () => {
    const other = resolveOperatorGrant({ roleSlug: OPERATOR_ROLE_SLUG, workspaceId: 'ws-b', teamRow: null, workspaceRow: null });
    expect(authorizeAgent(other, 'deployments:write', PROD)).toEqual({ allowed: false, reason: 'not_enabled' });
    const stagingOnly = operatorIn(enabledWs({ scope: { providers: ['vercel'], projects: ['site'], environments: ['staging'], credentialRefs: [] } }));
    expect(authorizeAgent(stagingOnly, 'deployments:write', PROD)).toEqual({ allowed: false, reason: 'provider_not_allowed' });
    expect(authorizeAgent(stagingOnly, 'deployments:write', { provider: 'vercel', project: 'site', environment: 'staging' })).toEqual({ allowed: true });
  });
});

describe('grant config parsing', () => {
  it('the sanitiser drops unknown capabilities, unknown dimensions and wildcards', () => {
    expect(sanitizeOperatorGrantConfig({
      enabled: true, capabilities: ['deployments:read', 'admin:all'],
      scope: { providers: ['*', 'Cloudflare', 'cloudflare', 3], regions: ['x'] },
    })).toEqual({ enabled: true, capabilities: ['deployments:read'], scope: { providers: ['cloudflare'] } });
    expect(sanitizeOperatorGrantConfig('yes')).toBeNull();
  });

  it('a wildcard grants nothing even if stored', () => {
    const g = operatorIn(row({ enabled: true, scope: { providers: ['*'], projects: ['*'], environments: ['*'] } }));
    expect(authorizeAgent(g, 'deployments:read', PROD)).toEqual({ allowed: false, reason: 'provider_not_allowed' });
  });

  it('strict input parsing reports typos and wildcards', () => {
    expect(parseOperatorGrantInput({ enabled: true, capabilities: ['deployment:write'] })).toEqual({ ok: false, error: 'Unknown capability: "deployment:write"' });
    expect(parseOperatorGrantInput({ scope: { region: ['eu'] } })).toEqual({ ok: false, error: 'Unknown scope dimension: region' });
    expect(parseOperatorGrantInput({ scope: { providers: ['*'] } }).ok).toBe(false);
    expect(parseOperatorGrantInput({ enabeld: true }).ok).toBe(false);
    expect(parseOperatorGrantInput({ enabled: true, scope: { providers: ['cloudflare'] } })).toEqual({ ok: true, config: { enabled: true, scope: { providers: ['cloudflare'] } } });
  });
});

describe('withOperatorGrantMetadata', () => {
  it('sets operator alongside other metadata keys, untouched', () => {
    const out = withOperatorGrantMetadata({ routing: { whenToUse: 'x' } }, { enabled: true, capabilities: ['deployments:read'] });
    expect(out).toEqual({ routing: { whenToUse: 'x' }, operator: { enabled: true, capabilities: ['deployments:read'] } });
  });

  it('drops operator when the config is null or empty, keeping other keys', () => {
    const base = { routing: { whenToUse: 'x' }, operator: { enabled: true } };
    expect(withOperatorGrantMetadata(base, null)).toEqual({ routing: { whenToUse: 'x' } });
    expect(withOperatorGrantMetadata(base, {})).toEqual({ routing: { whenToUse: 'x' } });
  });

  it('tolerates non-object metadata, starting fresh', () => {
    expect(withOperatorGrantMetadata('garbage', { enabled: false })).toEqual({ operator: { enabled: false } });
    expect(withOperatorGrantMetadata(undefined, { enabled: false })).toEqual({ operator: { enabled: false } });
  });
});

describe('agentAuthorizationAudit', () => {
  it('records the credential reference, flags elevated use, and has no field for a value', () => {
    const g = operatorIn(enabledWs({ capabilities: ['secrets:reveal'] }));
    const decision = authorizeAgent(g, 'secrets:reveal', { credentialRef: 'cloudflare-prod' });
    const audit = agentAuthorizationAudit(g, 'secrets:reveal', { credentialRef: 'cloudflare-prod' }, decision);
    expect(audit).toEqual({
      roleSlug: OPERATOR_ROLE_SLUG, workspaceId: WS, capability: 'secrets:reveal', tier: 'elevated', elevated: true,
      target: { provider: null, project: null, environment: null, credentialRef: 'cloudflare-prod' },
      allowed: true, reason: null,
    });
    const denied = agentAuthorizationAudit(g, 'deployments:write', PROD, authorizeAgent(g, 'deployments:write', PROD));
    expect(denied).toMatchObject({ elevated: false, allowed: false, reason: 'capability_not_granted' });
  });
});
