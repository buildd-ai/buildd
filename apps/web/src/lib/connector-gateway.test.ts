import { describe, expect, it, mock } from 'bun:test';
import {
  argsHash,
  callKey,
  callScope,
  classifyNativeTool,
  connectorRefusal,
  decideToolCall,
  deniedToolResult,
  effectiveCeiling,
  filterToolsList,
  gatewayMode,
  methodAllowed,
  parseToolPolicy,
  readRoleCeiling,
  readToolOverrides,
  toolVisible,
  usesGateway,
  type GatewayRun,
} from './connector-gateway';

/**
 * Mocked native tool surfaces, shaped like the providers' own tools/list.
 * Names and annotations are fixtures: the gateway keys on annotations and
 * the admin's overrides, never on a hard-coded provider tool list.
 */
const AXIOM_TOOLS = [
  { name: 'queryApl', description: 'Run an APL query', inputSchema: { type: 'object', properties: { apl: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'listDatasets', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'createMonitor', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'updateDashboard', inputSchema: { type: 'object' } }, // unannotated
  { name: 'deleteNotifier', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
const VERCEL_TOOLS = [
  { name: 'list_deployments', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'get_deployment_build_logs', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'deploy_to_vercel', inputSchema: { type: 'object' } },
  { name: 'update_project_settings', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
];

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

const noGrant = mock(async () => ({ allowed: false as const, reasonCode: 'no_grant' }));
const yesGrant = mock(async () => ({ allowed: true as const, grantId: 'g-1' }));

describe('classifyNativeTool — the provider annotations decide, and fail closed', () => {
  it('reads readOnlyHint, treats destructive as admin and unannotated as write', () => {
    expect(classifyNativeTool('queryApl', { readOnlyHint: true })).toBe('read');
    expect(classifyNativeTool('createMonitor', { readOnlyHint: false })).toBe('write');
    expect(classifyNativeTool('updateDashboard', undefined)).toBe('write');
    expect(classifyNativeTool('deleteNotifier', { destructiveHint: true })).toBe('admin');
  });

  it('an unannotated read-sounding name is still a write (no name-based read)', () => {
    expect(classifyNativeTool('getEverything', undefined)).toBe('write');
  });

  it('a readOnlyHint on an admin verb is a contradiction and stays admin', () => {
    expect(classifyNativeTool('delete_project', { readOnlyHint: true })).toBe('admin');
  });

  it("an admin's read-only mark covers an unannotated tool; a deny wins over everything", () => {
    const o = readToolOverrides({ toolPolicy: { readOnlyTools: ['updateDashboard'], denyTools: ['queryApl'] } });
    expect(classifyNativeTool('updateDashboard', undefined, o)).toBe('read');
    expect(classifyNativeTool('queryApl', { readOnlyHint: true }, o)).toBe('denied');
  });

  it('a destructive hint beats an admin read-only mark', () => {
    const o = readToolOverrides({ toolPolicy: { readOnlyTools: ['deleteNotifier'] } });
    expect(classifyNativeTool('deleteNotifier', { destructiveHint: true }, o)).toBe('admin');
  });
});

describe('parseToolPolicy', () => {
  it('accepts exact names, dedupes and sorts', () => {
    expect(parseToolPolicy({ readOnlyTools: ['b', 'a', 'a'] })).toEqual({ readOnlyTools: ['a', 'b'], denyTools: [] });
  });
  it('refuses wildcards, unknown keys and non-arrays', () => {
    expect(parseToolPolicy({ readOnlyTools: ['*'] })).toBeNull();
    expect(parseToolPolicy({ allowAll: true })).toBeNull();
    expect(parseToolPolicy({ denyTools: 'x' })).toBeNull();
    expect(parseToolPolicy(null)).toBeNull();
  });
});

describe('tools/list — subset-filtered, never rewritten', () => {
  it('a read-only role never sees Axiom monitor/dashboard/notifier mutations', () => {
    const out = filterToolsList({ tools: AXIOM_TOOLS }, run({ roleCeiling: 'query' }), readToolOverrides(null));
    const kept = (out.result as { tools: unknown[] }).tools;
    expect(kept.map(t => (t as { name: string }).name)).toEqual(['queryApl', 'listDatasets']);
    // Byte-for-byte the provider's own objects.
    expect(kept[0]).toBe(AXIOM_TOOLS[0]);
    expect(JSON.stringify(kept[0])).toBe(JSON.stringify(AXIOM_TOOLS[0]));
    expect(out.classes.get('createMonitor')).toBe('write');
  });

  it('a read-only role never sees Vercel deploy or settings changes', () => {
    const out = filterToolsList({ tools: VERCEL_TOOLS, nextCursor: 'c2' }, run({ roleCeiling: 'read', connector: { provider: 'vercel' } }), readToolOverrides(null));
    expect((out.result as { tools: { name: string }[] }).tools.map(t => t.name)).toEqual(['list_deployments', 'get_deployment_build_logs']);
    expect((out.result as { nextCursor?: string }).nextCursor).toBe('c2');
  });

  it('a write-ceiling role sees writes but not admin tools', () => {
    const out = filterToolsList({ tools: AXIOM_TOOLS }, run(), readToolOverrides(null));
    expect((out.result as { tools: { name: string }[] }).tools.map(t => t.name)).toEqual(['queryApl', 'listDatasets', 'createMonitor', 'updateDashboard']);
  });

  it('an unattended run is capped at query whatever its role says', () => {
    expect(effectiveCeiling({ roleCeiling: 'admin', unattended: true })).toBe('query');
    expect(toolVisible('write', run({ unattended: true }))).toBe(false);
    expect(toolVisible('read', run({ unattended: true }))).toBe(true);
  });

  it('a forbidding team rule hides the class', () => {
    const r = run({ rules: [{ provider: 'axiom', risk: 'write', workspaceId: null, roleSlug: null, environment: null, resource: null, effect: 'forbidden', maxTtlSeconds: null }] });
    expect(toolVisible('write', r)).toBe(false);
    expect(toolVisible('read', r)).toBe(true);
  });
});

describe('decideToolCall — every call against live state', () => {
  it('a role-mounted read is allowed without a grant', async () => {
    noGrant.mockClear();
    expect(await decideToolCall('read', run(), noGrant)).toEqual({ allowed: true, basis: 'role_mount', grantId: null });
    expect(noGrant).not.toHaveBeenCalled();
  });

  it('a write needs a live grant even on a role-mounted connector', async () => {
    expect(await decideToolCall('write', run(), noGrant)).toEqual({ allowed: false, code: 'capability_not_granted', grantReason: 'no_grant' });
    expect(await decideToolCall('write', run(), yesGrant)).toEqual({ allowed: true, basis: 'grant', grantId: 'g-1' });
  });

  it('a read on a connector the role does not mount needs a grant', async () => {
    expect(await decideToolCall('read', run({ roleMounts: false }), noGrant)).toMatchObject({ allowed: false, code: 'capability_not_granted' });
  });

  it('a read-only role cannot call a write even holding a grant (the grant is never consulted)', async () => {
    yesGrant.mockClear();
    expect(await decideToolCall('write', run({ roleCeiling: 'query' }), yesGrant)).toEqual({ allowed: false, code: 'role_ceiling' });
    expect(yesGrant).not.toHaveBeenCalled();
  });

  it('a scheduled run cannot write even holding a grant', async () => {
    expect(await decideToolCall('write', run({ unattended: true }), yesGrant)).toEqual({ allowed: false, code: 'unattended_ceiling' });
  });

  it('blocked after install, disabled, ended task, stopped worker, dead credential: refused before any grant', async () => {
    yesGrant.mockClear();
    const cases: [Partial<GatewayRun> & { connector?: Partial<GatewayRun['connector']> }, string][] = [
      [{ connector: { blocked: true } }, 'catalog_blocked'],
      [{ connector: { enabledInWorkspace: false } }, 'disabled_in_workspace'],
      [{ connector: { visible: false } }, 'connector_gone'],
      [{ connector: { credential: 'dead' } }, 'credential_dead'],
      [{ connector: { credential: 'missing' } }, 'need_connection'],
      [{ taskStatus: 'completed' }, 'task_terminal'],
      [{ workerStatus: 'completed' }, 'worker_not_live'],
      [{ roleSlug: null }, 'no_role'],
    ];
    for (const [over, code] of cases) {
      expect(await decideToolCall('read', run(over), yesGrant)).toEqual({ allowed: false, code: code as never });
    }
    expect(yesGrant).not.toHaveBeenCalled();
  });

  it('a denied tool and a forbidding rule are refused', async () => {
    expect(await decideToolCall('denied', run(), yesGrant)).toEqual({ allowed: false, code: 'tool_denied_by_admin' });
    const r = run({ rules: [{ provider: 'axiom', risk: 'read', workspaceId: 'ws-1', roleSlug: null, environment: null, resource: null, effect: 'forbidden', maxTtlSeconds: null }] });
    expect(await decideToolCall('read', r, yesGrant)).toEqual({ allowed: false, code: 'policy_forbidden' });
  });

  it('connectorRefusal is null for a healthy run', () => {
    expect(connectorRefusal(run())).toBeNull();
  });
});

describe('call identity, scope and denial shape', () => {
  it('argsHash is stable under key order; callKey changes with any part', () => {
    expect(argsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(argsHash({ b: { d: 3, c: 2 }, a: 1 }));
    const base = { workerId: 'w', sessionId: 's', rpcId: 7, tool: 't', argsHash: argsHash({}) };
    expect(callKey(base)).toBe(callKey({ ...base }));
    expect(callKey(base)).not.toBe(callKey({ ...base, rpcId: 8 }));
    expect(callKey(base)).not.toBe(callKey({ ...base, workerId: 'w2' }));
  });

  it('reads resource and environment from well-known argument keys only', () => {
    expect(callScope({ projectId: 'prj_1', target: 'Production' })).toEqual({ resource: 'prj_1', environment: 'production' });
    expect(callScope({ apl: "['logs']" })).toEqual({ resource: null, environment: null });
    expect(callScope(null)).toEqual({ resource: null, environment: null });
  });

  it('a denial is an MCP tool error with a next step, never a JSON-RPC auth error', () => {
    const r = deniedToolResult(3, 'capability_not_granted', { tool: 'createMonitor' });
    expect(r.id).toBe(3);
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent).toMatchObject({ code: 'capability_not_granted', tool: 'createMonitor' });
    expect(r.result.content[0].text).toContain('request_capability');
  });

  it('only known MCP methods are forwarded', () => {
    expect(methodAllowed('tools/call')).toBe(true);
    expect(methodAllowed('notifications/initialized')).toBe(true);
    expect(methodAllowed('sampling/createMessage')).toBe(false);
    expect(methodAllowed(undefined)).toBe(false);
  });
});

describe('which connectors are brokered', () => {
  it('Axiom and Vercel oauth/header connectors by default; stdio, none and assertion never', () => {
    expect(usesGateway({ transport: 'http', authMode: 'oauth' }, 'axiom', 'providers')).toBe(true);
    expect(usesGateway({ transport: 'http', authMode: 'header' }, 'vercel', 'providers')).toBe(true);
    expect(usesGateway({ transport: 'http', authMode: 'oauth' }, 'linear', 'providers')).toBe(false);
    expect(usesGateway({ transport: 'http', authMode: 'oauth' }, 'linear', 'all')).toBe(true);
    expect(usesGateway({ transport: 'http', authMode: 'none' }, 'axiom', 'all')).toBe(false);
    expect(usesGateway({ transport: 'http', authMode: 'assertion' }, 'axiom', 'all')).toBe(false);
    expect(usesGateway({ transport: 'stdio', authMode: 'header' }, 'axiom', 'all')).toBe(false);
    expect(usesGateway({ transport: 'http', authMode: 'oauth' }, 'axiom', 'off')).toBe(false);
  });

  it('reads the mode and the role ceiling defensively', () => {
    expect(gatewayMode({})).toBe('providers');
    expect(gatewayMode({ BUILDD_CONNECTOR_GATEWAY: 'OFF' })).toBe('off');
    expect(gatewayMode({ BUILDD_CONNECTOR_GATEWAY: 'all' })).toBe('all');
    expect(readRoleCeiling({ connectorCeiling: 'query' })).toBe('query');
    expect(readRoleCeiling({ connectorCeiling: 'root' })).toBe('write');
    expect(readRoleCeiling(null)).toBe('write');
  });
});
