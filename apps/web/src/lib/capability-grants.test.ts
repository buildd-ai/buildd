import { describe, it, expect } from 'bun:test';
import type { CapabilityCandidate, CapabilityResolution } from './connector-capabilities';
import {
  approvalRefusal,
  approvalTtl,
  checkGrantUse,
  classifyToolRisk,
  effectivePolicy,
  matchPolicy,
  parseCapabilityRequest,
  parsePolicyRule,
  policyScopeKey,
  resolveCapabilityRequest,
  toModelInferenceGrant,
  MAX_GRANT_TTL_SECONDS,
  type CapabilityRequest,
  type GrantRecord,
  type PolicyRule,
  type ResolveContext,
  type UseContext,
} from './capability-grants';

// ── fixtures (illustrative ids) ──────────────────────────────────────────────

const NOW = new Date('2026-10-09T12:00:00Z');
const TEAM = 'team-a';
const WS = '33333333-3333-4333-8333-333333333333';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKER = '11111111-1111-4111-8111-111111111111';
const AXIOM_CONN = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL = { teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, roleSlug: 'builder' };

function cand(over: Partial<CapabilityCandidate> & { slug?: string; connectorId?: string | null } = {}): CapabilityCandidate {
  const { slug = 'axiom', connectorId = AXIOM_CONN, ...rest } = over;
  return {
    provider: { slug, name: slug, catalogPolicy: 'available' },
    connector: connectorId ? { id: connectorId, name: `${slug}-conn`, ownership: 'team', transport: 'http' } : null,
    match: 'exact',
    access: 'auto_grant',
    availableNow: false,
    reasons: [],
    nextSteps: [],
    workspace: 'default_enabled',
    health: 'ok',
    roles: { evaluated: { slug: 'builder', mounts: false }, withAccess: ['researcher'] },
    compatibility: { status: 'documented' },
    risk: { requested: 'read', writeToolsExposed: false, note: '' },
    runtimeNeeds: [],
    ...rest,
  };
}

function discovery(cands: CapabilityCandidate[]): CapabilityResolution {
  return { capability: 'observability:query', role: { slug: 'builder', found: true }, candidates: cands, operator: null, unclassifiedConnectors: [], runtime: '', summary: 'summary' };
}

function req(body: Record<string, unknown>): CapabilityRequest {
  const r = parseCapabilityRequest(body);
  if (!r.ok) throw new Error(r.error);
  return r.request;
}

function ctx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    request: req({ capability: 'observability:query' }),
    principal: PRINCIPAL,
    discovery: discovery([cand()]),
    rules: [],
    openGrants: [],
    deniedKeys: new Set(),
    dedupeKeyFor: t => `k:${t.provider}:${t.connectorId}`,
    now: NOW,
    ...over,
  };
}

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    id: 'g1', teamId: TEAM, workspaceId: WS, taskId: TASK, workerId: WORKER, roleSlug: 'builder',
    capability: 'observability:query', provider: 'axiom', connectorId: AXIOM_CONN, risk: 'query',
    tool: null, resource: null, environment: null, scope: null,
    status: 'granted', decidedBy: 'policy', ttlSeconds: 3600,
    expiresAt: new Date(NOW.getTime() + 3600_000), revokedAt: null, dedupeKey: `k:axiom:${AXIOM_CONN}`,
    ...over,
  };
}

function useCtx(over: Partial<UseContext> = {}): UseContext {
  return { principal: PRINCIPAL, taskStatus: 'in_progress', workerStatus: 'running', rules: [], candidate: cand(), now: NOW, ...over };
}
const USE = { capability: 'observability:query', provider: 'axiom', connectorId: AXIOM_CONN, tool: 'queryApl', resource: null, environment: null };

function rule(over: Partial<PolicyRule>): PolicyRule {
  return { provider: 'axiom', risk: 'query', workspaceId: null, roleSlug: null, environment: null, resource: null, effect: 'ask_human', maxTtlSeconds: null, ...over };
}

// ── parsing ──────────────────────────────────────────────────────────────────

describe('parseCapabilityRequest', () => {
  it('asks semantically: a connector id, credential or endpoint is refused', () => {
    for (const k of ['connectorId', 'credentialRef', 'apiKey', 'baseURL']) {
      const r = parseCapabilityRequest({ capability: 'observability:query', [k]: 'x' });
      expect(r.ok).toBe(false);
    }
  });

  it('never lets a tool or declared risk lower the risk', () => {
    expect(req({ capability: 'observability:read', tool: 'deleteDataset' }).risk).toBe('admin');
    expect(req({ capability: 'deployment:read', tool: 'createDeployment' }).risk).toBe('write');
    expect(req({ capability: 'deployment:write', risk: 'read' }).risk).toBe('write');
    expect(req({ capability: 'observability:query', risk: 'admin' }).risk).toBe('admin');
    expect(req({ capability: 'observability:query', tool: 'mcp__axiom__queryApl' }).risk).toBe('query');
  });

  it('rejects wildcards and malformed scope', () => {
    expect(parseCapabilityRequest({ capability: 'observability:query', resource: '*' }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'observability:query', environment: 'prod*' }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'observability:query', ttlSeconds: 10 }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'observability:query', ttlSeconds: MAX_GRANT_TTL_SECONDS + 1 }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'telepathy:read' }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'observability:query', surprise: 1 }).ok).toBe(false);
  });

  it('model.inference needs a provider, exact models and a sane budget', () => {
    const budget = { maxCalls: 10, maxTokensPerCall: 1000, maxTotalTokens: 10000, maxUsdPerCall: 0.1, maxUsd: 1, timeoutMs: 10000, maxConcurrent: 2 };
    expect(parseCapabilityRequest({ capability: 'model.inference', provider: 'openrouter', models: ['typesafe/jev-1.13'], budget }).ok).toBe(true);
    expect(parseCapabilityRequest({ capability: 'model.inference', provider: 'anthropic', models: ['m'], budget }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'model.inference', provider: 'openrouter', models: [], budget }).ok).toBe(false);
    expect(parseCapabilityRequest({ capability: 'model.inference', provider: 'openrouter', models: ['m'], budget: { ...budget, maxUsd: 1e6 } }).ok).toBe(false);
  });
});

describe('classifyToolRisk', () => {
  it('reads read verbs, fails closed on anything else', () => {
    expect(classifyToolRisk('listDatasets')).toBe('read');
    expect(classifyToolRisk('get_logs')).toBe('read');
    expect(classifyToolRisk('getaway')).toBe('write');
    expect(classifyToolRisk('createDeployment')).toBe('write');
    expect(classifyToolRisk('frobnicate')).toBe('write');
    expect(classifyToolRisk('deleteProject')).toBe('admin');
    expect(classifyToolRisk('mcp__vercel__rotate_token')).toBe('admin');
  });
});

// ── policy ───────────────────────────────────────────────────────────────────

describe('team policy', () => {
  it('refuses auto_grant for write/admin at write time', () => {
    expect(parsePolicyRule({ provider: 'vercel', risk: 'write', effect: 'auto_grant' }).ok).toBe(false);
    expect(parsePolicyRule({ provider: 'vercel', risk: 'admin', effect: 'auto_grant' }).ok).toBe(false);
    expect(parsePolicyRule({ provider: 'vercel', risk: 'write', effect: 'ask_human' }).ok).toBe(true);
  });

  it('clamps a stored write auto_grant to ask_human anyway', () => {
    const p = effectivePolicy([rule({ provider: 'vercel', risk: 'write', effect: 'auto_grant' })], { provider: 'vercel', risk: 'write', workspaceId: WS, roleSlug: null, environment: null, resource: null }, true);
    expect(p.effect).toBe('ask_human');
    expect(p.clamped).toBe(true);
  });

  it('most specific rule wins; ties go to the most restrictive', () => {
    const rules = [
      rule({ id: 'team', effect: 'auto_grant' }),
      rule({ id: 'ws', workspaceId: WS, effect: 'ask_human' }),
      rule({ id: 'ws-prod-allow', workspaceId: WS, environment: 'production', effect: 'auto_grant' }),
      rule({ id: 'ws-prod-forbid', workspaceId: WS, environment: 'production', effect: 'forbidden' }),
    ];
    const scope = { provider: 'axiom', risk: 'query' as const, workspaceId: WS, roleSlug: 'builder', environment: null, resource: null };
    expect(matchPolicy(rules, scope)?.id).toBe('ws');
    expect(matchPolicy(rules, { ...scope, environment: 'production' })?.id).toBe('ws-prod-forbid');
    expect(matchPolicy(rules, { ...scope, workspaceId: 'other' })?.id).toBe('team');
  });

  it('default: reads auto-grant only where a role already mounts the connector; writes ask', () => {
    const scope = { provider: 'axiom', risk: 'read' as const, workspaceId: WS, roleSlug: null, environment: null, resource: null };
    expect(effectivePolicy([], scope, true).effect).toBe('auto_grant');
    expect(effectivePolicy([], scope, false).effect).toBe('ask_human');
    expect(effectivePolicy([], { ...scope, risk: 'write' }, true).effect).toBe('ask_human');
  });

  it('scope key distinguishes unset from set dimensions', () => {
    expect(policyScopeKey(rule({}))).not.toBe(policyScopeKey(rule({ environment: 'production' })));
  });
});

// ── resolution ───────────────────────────────────────────────────────────────

describe('resolveCapabilityRequest', () => {
  it('existing when the role already mounts the connector', () => {
    const r = resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'permitted', roles: { evaluated: { slug: 'builder', mounts: true }, withAccess: ['builder'] } })]) }));
    expect(r.kind).toBe('existing');
    expect(r.reasonCode).toBe('role_mounts_connector');
  });

  it('auto-grants a read another role already mounts, under the default policy', () => {
    const r = resolveCapabilityRequest(ctx());
    expect(r.kind).toBe('auto_granted');
    expect(r.target).toEqual({ provider: 'axiom', connectorId: AXIOM_CONN, connectorName: 'axiom-conn' });
  });

  it('provider write guard: a write asks a person even when the role mounts it', () => {
    const r = resolveCapabilityRequest(ctx({
      request: req({ capability: 'deployment:write', provider: 'vercel' }),
      discovery: discovery([cand({ slug: 'vercel', access: 'permitted', roles: { evaluated: { slug: 'builder', mounts: true }, withAccess: ['builder'] } })]),
      rules: [rule({ provider: 'vercel', risk: 'write', effect: 'auto_grant' })],
    }));
    expect(r.kind).toBe('pending_approval');
    expect(r.reasonCode).toBe('write_needs_human');
  });

  it('blocked-but-installed is forbidden, never pending', () => {
    const r = resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'forbidden', reasons: ['catalog_blocked'] })]) }));
    expect(r.kind).toBe('forbidden');
    expect(r.reasonCode).toBe('catalog_blocked');
  });

  it('a workspace disable is a hard deny', () => {
    const r = resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'ask_admin', workspace: 'disabled' })]) }));
    expect(r.kind).toBe('forbidden');
    expect(r.reasonCode).toBe('disabled_in_workspace');
  });

  it('a forbidding rule wins over the default', () => {
    const r = resolveCapabilityRequest(ctx({ rules: [rule({ effect: 'forbidden' })] }));
    expect(r.kind).toBe('forbidden');
    expect(r.reasonCode).toBe('policy_forbidden');
  });

  it('need_connection / need_reauth / unhealthy from credential health', () => {
    expect(resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'reconnect', health: 'not_connected' })]) })).kind).toBe('need_connection');
    expect(resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'reconnect', health: 'needs_reconnect' })]) })).kind).toBe('need_reauth');
    expect(resolveCapabilityRequest(ctx({ discovery: discovery([cand({ access: 'unhealthy', health: 'degraded' })]) })).kind).toBe('unhealthy');
    expect(resolveCapabilityRequest(ctx({ discovery: discovery([cand({ connectorId: null, access: 'ask_admin', health: 'not_installed' })]) })).kind).toBe('need_connection');
  });

  it('prefers a usable candidate and lists the rest as alternatives', () => {
    const r = resolveCapabilityRequest(ctx({ discovery: discovery([
      cand({ slug: 'sentry', connectorId: null, access: 'ask_admin', nextSteps: ['add sentry'] }),
      cand(),
    ]) }));
    expect(r.kind).toBe('auto_granted');
    expect(r.alternatives).toEqual([{ provider: 'sentry', connector: null, outcome: 'need_connection', nextSteps: ['add sentry'] }]);
  });

  it('unavailable with alternatives when the named provider serves nothing', () => {
    const r = resolveCapabilityRequest(ctx({ request: req({ capability: 'observability:query', provider: 'datadog' }) }));
    expect(r.kind).toBe('unavailable');
    expect(r.alternatives.map(a => a.provider)).toEqual(['axiom']);
  });

  it('a live covering grant is existing; a repeat ask reuses the pending row', () => {
    expect(resolveCapabilityRequest(ctx({ openGrants: [grant()] }))).toMatchObject({ kind: 'existing', grantId: 'g1' });
    const pending = grant({ id: 'p1', status: 'pending', expiresAt: null });
    const r = resolveCapabilityRequest(ctx({ rules: [rule({ effect: 'ask_human' })], openGrants: [pending] }));
    expect(r).toMatchObject({ kind: 'pending_approval', grantId: 'p1' });
  });

  it('an expired grant does not count as existing', () => {
    const r = resolveCapabilityRequest(ctx({ openGrants: [grant({ expiresAt: new Date(NOW.getTime() - 1) })] }));
    expect(r.kind).toBe('auto_granted');
    expect(r.grantId).toBeNull();
  });

  it('a grant for a narrower tool does not cover a different tool', () => {
    const r = resolveCapabilityRequest(ctx({ request: req({ capability: 'observability:query', tool: 'listDatasets' }), openGrants: [grant({ tool: 'queryApl' })] }));
    expect(r.grantId).toBeNull();
  });

  it('a denied request is not re-asked', () => {
    const r = resolveCapabilityRequest(ctx({ rules: [rule({ effect: 'ask_human' })], deniedKeys: new Set([`k:axiom:${AXIOM_CONN}`]) }));
    expect(r.kind).toBe('denied');
  });

  it('TTL is narrowed by policy', () => {
    const r = resolveCapabilityRequest(ctx({ request: req({ capability: 'observability:query', ttlSeconds: 7200 }), rules: [rule({ effect: 'auto_grant', maxTtlSeconds: 600 })] }));
    expect(r.ttlSeconds).toBe(600);
  });

  it('model.inference asks a person by default', () => {
    const budget = { maxCalls: 10, maxTokensPerCall: 1000, maxTotalTokens: 10000, maxUsdPerCall: 0.1, maxUsd: 1, timeoutMs: 10000, maxConcurrent: 2 };
    const r = resolveCapabilityRequest(ctx({ request: req({ capability: 'model.inference', provider: 'openrouter', models: ['typesafe/jev-1.13'], budget }), discovery: null }));
    expect(r.kind).toBe('pending_approval');
    expect(r.target?.connectorId).toBeNull();
  });
});

// ── use-time checks ──────────────────────────────────────────────────────────

describe('checkGrantUse', () => {
  it('allows a live, matching use', () => {
    expect(checkGrantUse(grant(), USE, useCtx())).toBeNull();
  });

  it('revocation and expiry stop the next call', () => {
    expect(checkGrantUse(grant({ status: 'revoked', revokedAt: NOW }), USE, useCtx())).toBe('grant_not_live');
    expect(checkGrantUse(grant({ expiresAt: NOW }), USE, useCtx())).toBe('grant_expired');
  });

  it('no use after the task is terminal or the worker stopped', () => {
    expect(checkGrantUse(grant(), USE, useCtx({ taskStatus: 'completed' }))).toBe('task_terminal');
    expect(checkGrantUse(grant(), USE, useCtx({ workerStatus: 'completed' }))).toBe('worker_not_live');
  });

  it('a role change while the worker runs ends the grant', () => {
    expect(checkGrantUse(grant(), USE, useCtx({ principal: { ...PRINCIPAL, roleSlug: 'researcher' } }))).toBe('role_changed');
  });

  it('replay: another worker, task or team cannot use it', () => {
    expect(checkGrantUse(grant(), USE, useCtx({ principal: { ...PRINCIPAL, workerId: 'w2' } }))).toBe('grant_mismatch');
    expect(checkGrantUse(grant(), USE, useCtx({ principal: { ...PRINCIPAL, taskId: 't2' } }))).toBe('grant_mismatch');
    expect(checkGrantUse(grant(), USE, useCtx({ principal: { ...PRINCIPAL, teamId: 'team-b' } }))).toBe('grant_mismatch');
  });

  it('provider write guard: a read grant cannot call a write tool', () => {
    expect(checkGrantUse(grant(), { ...USE, tool: 'createMonitor' }, useCtx())).toBe('tool_risk_exceeds_grant');
    expect(checkGrantUse(grant({ tool: 'queryApl' }), { ...USE, tool: 'listDatasets' }, useCtx())).toBe('tool_not_granted');
  });

  it('exact resource and environment', () => {
    const g = grant({ resource: 'traces', environment: 'production' });
    expect(checkGrantUse(g, { ...USE, resource: 'traces', environment: 'production' }, useCtx())).toBeNull();
    expect(checkGrantUse(g, { ...USE, resource: 'billing', environment: 'production' }, useCtx())).toBe('resource_not_granted');
    expect(checkGrantUse(g, { ...USE, resource: 'traces', environment: 'staging' }, useCtx())).toBe('environment_not_granted');
  });

  it('a catalog block, workspace disable or dead credential stops a granted call', () => {
    expect(checkGrantUse(grant(), USE, useCtx({ candidate: cand({ access: 'forbidden' }) }))).toBe('catalog_blocked');
    expect(checkGrantUse(grant(), USE, useCtx({ candidate: cand({ workspace: 'disabled', access: 'ask_admin' }) }))).toBe('disabled_in_workspace');
    expect(checkGrantUse(grant(), USE, useCtx({ candidate: cand({ access: 'reconnect', health: 'revoked' }) }))).toBe('credential_dead');
    expect(checkGrantUse(grant(), USE, useCtx({ candidate: null }))).toBe('connector_gone');
  });

  it('a tightened policy ends policy grants; a forbid ends human ones too', () => {
    const ask = [rule({ effect: 'ask_human' })];
    expect(checkGrantUse(grant({ decidedBy: 'policy' }), USE, useCtx({ rules: ask }))).toBe('policy_tightened');
    expect(checkGrantUse(grant({ decidedBy: 'human' }), USE, useCtx({ rules: ask }))).toBeNull();
    expect(checkGrantUse(grant({ decidedBy: 'human' }), USE, useCtx({ rules: [rule({ effect: 'forbidden' })] }))).toBe('policy_forbidden');
  });
});

describe('approvalRefusal / approvalTtl', () => {
  const base = { taskStatus: 'in_progress', workerStatus: 'running', rules: [] as PolicyRule[], candidate: cand(), currentRoleSlug: 'builder' };
  it('a person can approve above the auto-grant line, never past a forbid or block', () => {
    const write = grant({ status: 'pending', risk: 'write', capability: 'deployment:write' });
    expect(approvalRefusal(write, base)).toBeNull();
    expect(approvalRefusal(write, { ...base, rules: [rule({ risk: 'write', effect: 'forbidden' })] })).toBe('policy_forbidden');
    expect(approvalRefusal(write, { ...base, candidate: cand({ access: 'forbidden' }) })).toBe('catalog_blocked');
  });
  it('no approval for an ended run or a changed role', () => {
    const p = grant({ status: 'pending' });
    expect(approvalRefusal(p, { ...base, taskStatus: 'failed' })).toBe('task_terminal');
    expect(approvalRefusal(p, { ...base, workerStatus: 'error' })).toBe('worker_not_live');
    expect(approvalRefusal(p, { ...base, currentRoleSlug: 'operator' })).toBe('role_changed');
  });
  it('approver can only narrow the TTL', () => {
    expect(approvalTtl(3600, 600, MAX_GRANT_TTL_SECONDS)).toBe(600);
    expect(approvalTtl(3600, 99999, MAX_GRANT_TTL_SECONDS)).toBe(3600);
    expect(approvalTtl(3600, null, 900)).toBe(900);
  });
});

describe('toModelInferenceGrant', () => {
  const budget = { maxCalls: 10, maxTokensPerCall: 1000, maxTotalTokens: 10000, maxUsdPerCall: 0.1, maxUsd: 1, timeoutMs: 10000, maxConcurrent: 2 };
  it('maps a stored grant to the inference adapter shape', () => {
    const g = grant({ capability: 'model.inference', provider: 'openrouter', connectorId: null, scope: { models: ['m1'], operations: ['decide'], budget } });
    expect(toModelInferenceGrant(g)).toMatchObject({ grantId: 'g1', provider: 'openrouter', models: ['m1'], workerId: WORKER });
  });
  it('null for a malformed or non-inference grant', () => {
    expect(toModelInferenceGrant(grant())).toBeNull();
    expect(toModelInferenceGrant(grant({ capability: 'model.inference', provider: 'openrouter', scope: { models: ['m1'], operations: ['decide'], budget: { ...budget, maxUsd: 1e9 } } }))).toBeNull();
  });
});
