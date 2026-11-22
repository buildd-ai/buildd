import { describe, expect, it } from 'bun:test';
import type { GatewayRun, ToolClass } from './connector-gateway';
import { toolCallRequest, type PolicyDecision, type PolicyRequest } from './connector-pdp';
import { cedarEntities, cedarPdp } from './connector-pdp-cedar';

function run(over: Partial<GatewayRun> = {}): GatewayRun {
  return {
    teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', workerId: 'w-1', roleSlug: 'analyst',
    taskStatus: 'in_progress', workerStatus: 'running', unattended: false, roleCeiling: 'write', roleMounts: true,
    rules: [],
    connector: { id: 'conn-1', provider: 'axiom', visible: true, enabledInWorkspace: true, blocked: false, credential: 'ok' },
    ...over,
  };
}

const PRINCIPAL = { kind: 'agent_run' as const, via: 'task_token' as const, workerId: 'w-1', taskId: 'task-1', workspaceId: 'ws-1', teamId: 'team-1', accountId: 'acct-1' };

function request(risk: ToolClass, opts: { run?: Partial<GatewayRun>; principal?: Partial<typeof PRINCIPAL> & { teamId?: string | null }; tool?: string; environment?: string | null; prior?: PolicyDecision } = {}): PolicyRequest {
  const r = toolCallRequest({
    principal: { ...PRINCIPAL, ...opts.principal }, run: run(opts.run), tool: opts.tool ?? 'queryApl', risk,
    scope: { resource: null, environment: opts.environment ?? null },
    grant: async () => { throw new Error('a Cedar PDP never asks the grant store'); },
  });
  return opts.prior ? { ...r, context: { ...r.context, prior: opts.prior } } : r;
}

const POLICIES = `
@id("reads-in-ws-1")
permit(principal in Buildd::Workspace::"ws-1", action == Buildd::Action::"read", resource);

@id("analysts-write-axiom-with-grant")
permit(principal in Buildd::Role::"analyst", action == Buildd::Action::"write", resource in Buildd::Provider::"axiom")
when { context has grantBasis && context.grantBasis == "grant" };

@id("no-production-writes")
forbid(principal, action in Buildd::Action::"mutate", resource)
when { context has environment && context.environment == "production" };

@id("unattended-never-calls-deleteNotifier")
forbid(principal, action in Buildd::Action::"callTool", resource == Buildd::Tool::"conn-1/deleteNotifier")
when { principal.unattended };
`;

describe('cedarPdp — Cedar policies decide one tools/call', () => {
  const pdp = cedarPdp(POLICIES);

  it('allow: a matching permit, named by its @id', async () => {
    expect(await pdp.decide(request('read'))).toEqual({ effect: 'allow', reason: 'policy', policyId: 'reads-in-ws-1' });
  });

  it('deny: a matching forbid wins over a matching permit, and is named', async () => {
    const prior: PolicyDecision = { effect: 'allow', reason: 'grant', grantId: 'g-1' };
    expect(await pdp.decide(request('write', { tool: 'createMonitor', prior }))).toMatchObject({ effect: 'allow', policyId: 'analysts-write-axiom-with-grant' });
    expect(await pdp.decide(request('write', { tool: 'createMonitor', prior, environment: 'production' })))
      .toEqual({ effect: 'deny', reason: 'policy_denied', policyId: 'no-production-writes' });
  });

  it('no policy matched: deny, with no policy named', async () => {
    // A write with no grant behind it: the analyst permit needs grantBasis == "grant".
    expect(await pdp.decide(request('write', { tool: 'createMonitor' }))).toEqual({ effect: 'deny', reason: 'policy_denied' });
    // A read outside ws-1.
    expect(await pdp.decide(request('read', { principal: { workspaceId: 'ws-2' } }))).toEqual({ effect: 'deny', reason: 'policy_denied' });
    // An empty policy set denies everything.
    expect(await cedarPdp('').decide(request('read'))).toEqual({ effect: 'deny', reason: 'policy_denied' });
  });

  it('keys on principal attributes, action groups and the exact tool', async () => {
    const unattended = await pdp.decide(request('read', { tool: 'deleteNotifier', run: { unattended: true } }));
    expect(unattended).toEqual({ effect: 'deny', reason: 'policy_denied', policyId: 'unattended-never-calls-deleteNotifier' });
    expect(await pdp.decide(request('read', { tool: 'deleteNotifier' }))).toMatchObject({ effect: 'allow' });
  });

  it('a tool the admin turned off is never allowed, whatever the policy says', async () => {
    const permitAll = cedarPdp('permit(principal, action, resource);');
    expect(await permitAll.decide(request('denied'))).toEqual({ effect: 'deny', reason: 'tool_denied_by_admin' });
  });
});

describe('cedarPdp — policy text is checked up front and fails closed', () => {
  it('refuses text that does not parse', () => {
    expect(() => cedarPdp('permit(principal, action resource);')).toThrow(/Cedar/);
  });

  it('refuses two policies with the same @id', () => {
    expect(() => cedarPdp('@id("a") permit(principal, action, resource);\n@id("a") forbid(principal, action, resource);')).toThrow(/duplicate/i);
  });

  it('a policy without @id gets a positional id', async () => {
    expect(await cedarPdp('permit(principal, action, resource);').decide(request('read'))).toEqual({ effect: 'allow', reason: 'policy', policyId: 'policy0' });
  });
});

describe('cedarEntities — the request shape policies are written against', () => {
  it('principal is the run, inside its workspace, team and role; resource is the tool inside its connector and provider', () => {
    const { principal, action, resource, entities, context } = cedarEntities(request('write', { tool: 'createMonitor', environment: 'production' }));
    expect(principal).toEqual({ type: 'Buildd::AgentRun', id: 'w-1' });
    expect(action).toEqual({ type: 'Buildd::Action', id: 'write' });
    expect(resource).toEqual({ type: 'Buildd::Tool', id: 'conn-1/createMonitor' });
    const run = entities.find(e => (e.uid as { id: string }).id === 'w-1')!;
    expect(run.parents).toEqual([
      { type: 'Buildd::Workspace', id: 'ws-1' }, { type: 'Buildd::Team', id: 'team-1' }, { type: 'Buildd::Role', id: 'analyst' },
    ]);
    expect(run.attrs).toMatchObject({ task: 'task-1', workspace: 'ws-1', team: 'team-1', role: 'analyst', via: 'task_token', unattended: false });
    const tool = entities.find(e => (e.uid as { id: string }).id === 'conn-1/createMonitor')!;
    expect(tool.parents).toEqual([{ type: 'Buildd::Connector', id: 'conn-1' }]);
    expect(context).toEqual({ risk: 'write', environment: 'production' });
  });

  it('absent facts are left out of the request rather than sent as null', () => {
    const { entities, context } = cedarEntities(request('read', { run: { roleSlug: null }, principal: { teamId: null } }));
    const run = entities.find(e => (e.uid as { id: string }).id === 'w-1')!;
    expect(run.attrs).not.toHaveProperty('role');
    expect(run.attrs).not.toHaveProperty('team');
    expect(run.parents).toEqual([{ type: 'Buildd::Workspace', id: 'ws-1' }]);
    expect(context).toEqual({ risk: 'read' });
  });
});
