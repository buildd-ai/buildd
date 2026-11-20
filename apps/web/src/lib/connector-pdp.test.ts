import { describe, expect, it, mock } from 'bun:test';
import { decideToolCall, type GatewayRun, type GrantCheck, type ToolClass } from './connector-gateway';
import {
  allOf,
  builtinPdp,
  connectorPdp,
  pdpMode,
  toCallDecision,
  toolCallRequest,
  type PolicyDecision,
  type PolicyDecisionPoint,
  type PolicyRequest,
} from './connector-pdp';

function run(over: Partial<GatewayRun> & { connector?: Partial<GatewayRun['connector']> } = {}): GatewayRun {
  const { connector, ...rest } = over;
  return {
    teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w-1', roleSlug: 'analyst',
    taskStatus: 'in_progress', workerStatus: 'running', unattended: false, roleCeiling: 'write', roleMounts: true,
    rules: [],
    ...rest,
    connector: { id: 'conn-1', provider: 'axiom', visible: true, enabledInWorkspace: true, blocked: false, credential: 'ok', ...connector },
  };
}

const PRINCIPAL = { kind: 'agent_run' as const, via: 'task_token' as const, workerId: 'w-1', taskId: 'task-1', workspaceId: 'ws-1', teamId: 'team-1', accountId: 'acct-1' };
const noGrant: GrantCheck = async () => ({ allowed: false, reasonCode: 'no_grant' });
const yesGrant: GrantCheck = async () => ({ allowed: true, grantId: 'g-1' });

function request(risk: ToolClass, r: GatewayRun, grant: GrantCheck, tool = 'createMonitor'): PolicyRequest {
  return toolCallRequest({ principal: PRINCIPAL, run: r, tool, risk, scope: { resource: 'p1', environment: 'production' }, grant });
}

describe('builtinPdp — the grants logic, unchanged', () => {
  const RISKS: ToolClass[] = ['read', 'query', 'write', 'admin', 'denied'];
  const RUNS: [string, GatewayRun][] = [
    ['mounted', run()],
    ['not mounted', run({ roleMounts: false })],
    ['query ceiling', run({ roleCeiling: 'query' })],
    ['admin ceiling', run({ roleCeiling: 'admin' })],
    ['unattended', run({ unattended: true })],
    ['task ended', run({ taskStatus: 'completed' })],
    ['worker gone', run({ workerStatus: 'completed' })],
    ['no role', run({ roleSlug: null })],
    ['blocked', run({ connector: { blocked: true } })],
    ['credential dead', run({ connector: { credential: 'dead' } })],
    ['policy forbids writes', run({ rules: [{ provider: 'axiom', risk: 'write', workspaceId: null, roleSlug: null, environment: null, resource: null, effect: 'forbidden', maxTtlSeconds: null }] })],
  ];
  for (const [label, r] of RUNS) {
    for (const risk of RISKS) {
      for (const [gl, grant] of [['no grant', noGrant], ['grant', yesGrant]] as const) {
        it(`${label} / ${risk} / ${gl}: same decision as decideToolCall`, async () => {
          const via = toCallDecision(await builtinPdp.decide(request(risk, r, grant)));
          expect(via).toEqual(await decideToolCall(risk, r, grant));
        });
      }
    }
  }

  it('asks the grant store only when the rules leave it open', async () => {
    const grant = mock(yesGrant);
    await builtinPdp.decide(request('read', run(), grant));
    await builtinPdp.decide(request('write', run({ roleCeiling: 'query' }), grant));
    expect(grant).not.toHaveBeenCalled();
    await builtinPdp.decide(request('write', run(), grant));
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('answers in PDP shape: effect, reason, and the grant behind an allow', async () => {
    expect(await builtinPdp.decide(request('write', run(), yesGrant))).toEqual({ effect: 'allow', reason: 'grant', grantId: 'g-1' });
    expect(await builtinPdp.decide(request('read', run(), noGrant))).toEqual({ effect: 'allow', reason: 'role_mount', grantId: null });
    expect(await builtinPdp.decide(request('write', run(), noGrant))).toEqual({ effect: 'deny', reason: 'capability_not_granted', grantReason: 'no_grant' });
  });
});

describe('toolCallRequest — principal, action, resource, context', () => {
  it('carries the run facts a policy can key on', () => {
    const r = request('write', run({ unattended: true }), noGrant, 'createMonitor');
    expect(r.principal).toMatchObject({ kind: 'agent_run', workerId: 'w-1', taskId: 'task-1', workspaceId: 'ws-1', teamId: 'team-1', roleSlug: 'analyst', unattended: true, via: 'task_token' });
    expect(r.action).toEqual({ name: 'tools/call', risk: 'write' });
    expect(r.resource).toEqual({ kind: 'connector_tool', connectorId: 'conn-1', provider: 'axiom', tool: 'createMonitor', scope: { resource: 'p1', environment: 'production' } });
  });
});

describe('allOf — every PDP must allow', () => {
  const fixed = (id: string, d: PolicyDecision) => {
    const decide = mock(async (_r: PolicyRequest) => d);
    return { pdp: { id, decide } as PolicyDecisionPoint, decide };
  };

  it('the first deny wins and later PDPs are not asked', async () => {
    const a = fixed('a', { effect: 'deny', reason: 'role_ceiling' });
    const b = fixed('b', { effect: 'allow', reason: 'policy', policyId: 'p' });
    expect(await allOf(a.pdp, b.pdp).decide(request('write', run(), noGrant))).toEqual({ effect: 'deny', reason: 'role_ceiling' });
    expect(b.decide).not.toHaveBeenCalled();
  });

  it('a later deny overrides an earlier allow, naming its policy', async () => {
    const a = fixed('a', { effect: 'allow', reason: 'grant', grantId: 'g-1' });
    const b = fixed('b', { effect: 'deny', reason: 'policy_denied', policyId: 'no-prod-writes' });
    expect(await allOf(a.pdp, b.pdp).decide(request('write', run(), noGrant))).toEqual({ effect: 'deny', reason: 'policy_denied', policyId: 'no-prod-writes' });
  });

  it('allow keeps the first basis and grant, and the later policy id; later PDPs see the earlier allow', async () => {
    const a = fixed('a', { effect: 'allow', reason: 'grant', grantId: 'g-1' });
    const b = fixed('b', { effect: 'allow', reason: 'policy', policyId: 'writes-with-grant' });
    expect(await allOf(a.pdp, b.pdp).decide(request('write', run(), noGrant))).toEqual({ effect: 'allow', reason: 'grant', grantId: 'g-1', policyId: 'writes-with-grant' });
    expect(b.decide.mock.calls[0][0].context.prior).toEqual({ effect: 'allow', reason: 'grant', grantId: 'g-1' });
  });
});

describe('toCallDecision — what the gateway enforces and audits', () => {
  it('maps allow and deny, carrying the policy id only when there is one', () => {
    expect(toCallDecision({ effect: 'allow', reason: 'role_mount', grantId: null })).toEqual({ allowed: true, basis: 'role_mount', grantId: null });
    expect(toCallDecision({ effect: 'allow', reason: 'grant', grantId: 'g-1', policyId: 'p1' })).toEqual({ allowed: true, basis: 'grant', grantId: 'g-1', policyId: 'p1' });
    expect(toCallDecision({ effect: 'deny', reason: 'capability_not_granted', grantReason: 'no_grant' })).toEqual({ allowed: false, code: 'capability_not_granted', grantReason: 'no_grant' });
    expect(toCallDecision({ effect: 'deny', reason: 'policy_denied', policyId: 'p2' })).toEqual({ allowed: false, code: 'policy_denied', policyId: 'p2' });
  });
});

describe('which PDP the gateway asks (server env, no db yet)', () => {
  it('defaults to the built-in; an unknown value fails closed', () => {
    expect(pdpMode({})).toBe('builtin');
    expect(pdpMode({ BUILDD_CONNECTOR_PDP: ' ' })).toBe('builtin');
    expect(pdpMode({ BUILDD_CONNECTOR_PDP: 'builtin' })).toBe('builtin');
    expect(pdpMode({ BUILDD_CONNECTOR_PDP: 'Cedar' })).toBe('cedar');
    expect(() => pdpMode({ BUILDD_CONNECTOR_PDP: 'cedr' })).toThrow(/BUILDD_CONNECTOR_PDP/);
  });

  it('builtin mode is the built-in PDP itself', async () => {
    expect(await connectorPdp({})).toBe(builtinPdp);
  });

  it('cedar mode without policies fails closed rather than allowing everything', async () => {
    await expect(connectorPdp({ BUILDD_CONNECTOR_PDP: 'cedar' })).rejects.toThrow(/BUILDD_CONNECTOR_CEDAR_POLICIES/);
  });

  it('cedar mode layers Cedar on the built-in: the built-in still refuses first, Cedar can only narrow', async () => {
    const env = { BUILDD_CONNECTOR_PDP: 'cedar', BUILDD_CONNECTOR_CEDAR_POLICIES: '@id("all") permit(principal, action, resource);' };
    const pdp = await connectorPdp(env);
    expect(pdp.id).toBe('builtin+cedar');
    expect(await connectorPdp(env)).toBe(pdp); // compiled once per policy text
    expect(await pdp.decide(request('write', run(), noGrant))).toEqual({ effect: 'deny', reason: 'capability_not_granted', grantReason: 'no_grant' });
    expect(await pdp.decide(request('write', run(), yesGrant))).toEqual({ effect: 'allow', reason: 'grant', grantId: 'g-1', policyId: 'all' });
  });
});
