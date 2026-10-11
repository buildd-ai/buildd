/**
 * The connector gateway end to end, with the provider's native MCP mocked at
 * fetch. Covers: verbatim tools/list subset, per-call decisions with changes
 * before and during a task (role ceiling, block after install, grant revoked
 * mid-task), expired OAuth (refresh + retry), access revoked mid-call
 * (reconnect_required, no abort), network outage on either side (fail
 * closed), anti-replay, rate control, audit, and no credential in any answer.
 */
import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { NextRequest } from 'next/server';

const CONN = '0b0b0b0b-1111-4222-8333-444455556666';
const WORKER = 'worker-1';
const PROVIDER_TOKEN = 'axiom-provider-access-token-SECRET';
const AGENT_TOKEN = 'bldt_agent-task-token';

// ── auth ─────────────────────────────────────────────────────────────────────
const mockAuth = mock(async (_k: string | null, _r?: unknown) => ({ id: 'acct-1', level: 'worker', taskScope: { taskId: 'task-1', workspaceId: 'ws-1', expiresAt: Date.now() + 1e6 } }) as any);
mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorker: (a: any, w: any) => !a.taskScope || a.taskScope.taskId === w.taskId,
  taskScopeAllowsWorkspace: (a: any, ws: any) => !a.taskScope || a.taskScope.workspaceId === ws,
}));
const PRINCIPAL = { kind: 'agent_run', via: 'runner_key', workerId: WORKER, taskId: 'task-1', workspaceId: 'ws-1', teamId: 'team-1', accountId: 'acct-1' };
const mockResolvePrincipal = mock(async (_a: any, _i: any) => ({ ok: true, principal: PRINCIPAL, workspace: {} }) as any);
mock.module('@/lib/agent-capabilities/worker-principal', () => ({ resolveWorkerPrincipal: mockResolvePrincipal }));

// ── grants ───────────────────────────────────────────────────────────────────
const mockAuthorizeTool = mock(async (_p: any, _u: any) => ({ allowed: false, reasonCode: 'no_grant' }) as any);
mock.module('@/lib/capability-grants-store', () => ({ authorizeConnectorToolUse: mockAuthorizeTool }));

// ── gateway store ────────────────────────────────────────────────────────────
function loaded(over: { run?: Record<string, unknown>; connector?: Record<string, unknown> } = {}) {
  return {
    run: {
      teamId: 'team-1', workspaceId: 'ws-1', taskId: 'task-1', workerId: WORKER, roleSlug: 'analyst',
      taskStatus: 'in_progress', workerStatus: 'running', unattended: false, roleCeiling: 'write', roleMounts: true, rules: [],
      ...(over.run ?? {}),
      connector: { id: CONN, provider: 'axiom', visible: true, enabledInWorkspace: true, blocked: false, credential: 'ok', ...((over.run as any)?.connector ?? {}) },
    },
    connector: { id: CONN, name: 'axiom', url: 'https://mcp.axiom.example/mcp', authMode: 'oauth', headerName: null, teamId: 'team-1', transport: 'http', discoveredMetadata: null, ...(over.connector ?? {}) },
    secret: { id: 'sec-1', tokenExpiresAt: null },
  };
}
let currentLoaded: any = loaded();
const mockLoadRun = mock(async (_p: any, _c: string) => currentLoaded);
let providerToken = PROVIDER_TOKEN;
const mockAuthHeader = mock(async (_g: any) => (providerToken ? { name: 'Authorization', value: `Bearer ${providerToken}` } : null));
const mockRefresh = mock(async (_g: any) => false);
const mockMarkRejected = mock(async (_g: any) => {});
const mockRecentCount = mock(async (_w: string, _c: string) => 0);
const seenKeys = new Set<string>();
const mockIsReplay = mock(async (_w: string, k: string) => seenKeys.has(k));
const audit: any[] = [];
let auditFails = false;
const events: string[] = [];
const mockWriteAudit = mock(async (row: any) => {
  if (auditFails) throw new Error('db down');
  audit.push(row);
  events.push(`audit:${row.capability}:${row.decision}`);
  if (row.sideEffect?.callKey && row.decision === 'allowed' && row.capability === 'connector.tool_call') seenKeys.add(row.sideEffect.callKey);
});
const mockNoteAudit = mock((row: any) => { audit.push(row); events.push(`note:${row.capability}:${row.decision}`); });
mock.module('@/lib/connector-gateway-store', () => ({
  TOOL_CALL_CAPABILITY: 'connector.tool_call',
  TOOL_RESULT_CAPABILITY: 'connector.tool_result',
  loadGatewayRun: mockLoadRun,
  providerAuthHeader: mockAuthHeader,
  refreshAfterRejection: mockRefresh,
  markCredentialRejected: mockMarkRejected,
  recentCallCount: mockRecentCount,
  isReplayedCall: mockIsReplay,
  writeToolAudit: mockWriteAudit,
  noteToolAudit: mockNoteAudit,
}));

// ── the provider's native MCP (mocked at fetch) ──────────────────────────────
const AXIOM_TOOLS = [
  { name: 'queryApl', description: 'Run APL', inputSchema: { type: 'object', properties: { apl: { type: 'string' } }, required: ['apl'] }, annotations: { readOnlyHint: true } },
  { name: 'createMonitor', description: 'Create a monitor', inputSchema: { type: 'object' } },
  { name: 'deleteDashboard', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
];
type Upstream = { status?: number; body?: unknown; sse?: boolean; throws?: Error; native?: true };
let upstreamQueue: Upstream[] = [];
const upstreamCalls: { url: string; headers: Headers; body: any }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  upstreamCalls.push({ url: String(url), headers: new Headers(init?.headers), body });
  events.push(`upstream:${body?.method ?? init?.method}`);
  const queued = upstreamQueue.shift();
  const next = !queued || queued.native ? { body: defaultAnswer(body) } : queued;
  if (next.throws) throw next.throws;
  if (next.sse) {
    return new Response(`event: message\ndata: ${JSON.stringify(next.body)}\n\n`, { status: next.status ?? 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'up-sess' } });
  }
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'up-sess', 'www-authenticate': 'Bearer realm="x"', 'set-cookie': 'a=b' } });
}) as any;
afterAll(() => { globalThis.fetch = realFetch; });

function defaultAnswer(body: any) {
  if (body?.method === 'tools/list') return { jsonrpc: '2.0', id: body.id, result: { tools: AXIOM_TOOLS } };
  if (body?.method === 'tools/call') return { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } };
  return { jsonrpc: '2.0', id: body?.id ?? null, result: {} };
}

const { POST, GET, DELETE, __resetGatewayCache } = await import('./route');

function req(body: unknown, opts: { worker?: string; session?: string; token?: string } = {}) {
  const url = `http://localhost/api/mcp/c/${CONN}?worker=${opts.worker ?? WORKER}`;
  return new NextRequest(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token ?? AGENT_TOKEN}`, 'content-type': 'application/json', ...(opts.session ? { 'mcp-session-id': opts.session } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const ctx = (id = CONN) => ({ params: Promise.resolve({ connectorId: id }) });
const call = (name: string, args: unknown = {}, id: unknown = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
async function toolError(res: Response) {
  const j = await res.json();
  expect(j.result?.isError).toBe(true);
  return j.result.structuredContent as { code: string; nextSteps: string[] };
}

beforeEach(() => {
  __resetGatewayCache();
  currentLoaded = loaded();
  providerToken = PROVIDER_TOKEN;
  upstreamQueue = [];
  upstreamCalls.length = 0;
  audit.length = 0;
  events.length = 0;
  seenKeys.clear();
  auditFails = false;
  mockAuthorizeTool.mockReset();
  mockAuthorizeTool.mockResolvedValue({ allowed: false, reasonCode: 'no_grant' });
  mockRecentCount.mockReset();
  mockRecentCount.mockResolvedValue(0);
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue(false);
  mockMarkRejected.mockClear();
  mockLoadRun.mockClear();
  mockAuth.mockClear();
  mockResolvePrincipal.mockClear();
});

describe('auth and surface', () => {
  it('an unknown key answers 401 without a WWW-Authenticate challenge', async () => {
    mockAuth.mockResolvedValueOnce(null as any);
    const res = await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it("another task's worker answers 404 and nothing reaches the provider", async () => {
    mockResolvePrincipal.mockResolvedValueOnce({ ok: true, principal: { ...PRINCIPAL, taskId: 'task-2' }, workspace: {} });
    const res = await POST(req(call('queryApl')), ctx());
    expect(res.status).toBe(404);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('a connector this team cannot see answers 404', async () => {
    currentLoaded = null;
    expect((await POST(req(call('queryApl')), ctx())).status).toBe(404);
  });

  it('a trigger token is refused; GET is 405; a batch and an unknown method are refused', async () => {
    mockAuth.mockResolvedValueOnce({ id: 'a', level: 'trigger' } as any);
    expect((await POST(req(call('queryApl')), ctx())).status).toBe(403);
    expect((await GET()).status).toBe(405);
    expect((await POST(req([call('queryApl')]), ctx())).status).toBe(400);
    const r = await (await POST(req({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage' }), ctx())).json();
    expect(r.error.code).toBe(-32601);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('tools/list — native, subset-filtered', () => {
  it('forwards with the server-held credential, never the agent token, and filters a read-only role', async () => {
    currentLoaded = loaded({ run: { roleCeiling: 'query' } });
    const res = await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { session: 'sess-1' }), ctx());
    const j = await res.json();
    expect(j.result.tools).toEqual([AXIOM_TOOLS[0]]); // byte-equal native entry, mutations gone
    expect(upstreamCalls[0].headers.get('authorization')).toBe(`Bearer ${PROVIDER_TOKEN}`);
    expect(upstreamCalls[0].headers.get('mcp-session-id')).toBe('sess-1');
    expect(res.headers.get('mcp-session-id')).toBe('up-sess');
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('filters an SSE answer the same way', async () => {
    currentLoaded = loaded({ run: { roleCeiling: 'read' } });
    upstreamQueue.push({ sse: true, body: { jsonrpc: '2.0', id: 'L', result: { tools: AXIOM_TOOLS } } });
    const res = await POST(req({ jsonrpc: '2.0', id: 'L', method: 'tools/list' }), ctx());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const data = JSON.parse(text.split('\n').find(l => l.startsWith('data: '))!.slice(6));
    expect(data.result.tools.map((t: any) => t.name)).toEqual(['queryApl']);
  });
});

describe('tools/call — decided per call', () => {
  it('a role-mounted read is forwarded verbatim, audited as attempt and result', async () => {
    const res = await POST(req(call('queryApl', { apl: "['logs'] | count" })), ctx());
    const j = await res.json();
    expect(j.result.content[0].text).toBe('ok');
    expect(upstreamCalls.at(-1)!.body).toEqual(call('queryApl', { apl: "['logs'] | count" }));
    const caps = audit.map(a => `${a.capability}:${a.decision}:${a.reasonCode}`);
    expect(caps).toContain('connector.tool_call:allowed:role_mount');
    expect(caps).toContain('connector.tool_result:allowed:ok');
    expect(JSON.stringify(audit)).not.toContain('logs'); // args are hashed, never stored
    expect(JSON.stringify(audit)).not.toContain(PROVIDER_TOKEN);
  });

  it('classifies an uncached tool by asking the provider (fails closed if it cannot)', async () => {
    currentLoaded = loaded({ run: { roleCeiling: 'query' } });
    // Provider unreachable for the classification list: the tool is unknown, so it is a write.
    upstreamQueue.push({ throws: new Error('ECONNRESET') });
    const denied = await toolError(await POST(req(call('queryApl')), ctx()));
    expect(denied.code).toBe('role_ceiling');
  });

  it('a write without a grant is refused with a next step and never sent', async () => {
    const out = await toolError(await POST(req(call('createMonitor', { name: 'x' })), ctx()));
    expect(out.code).toBe('capability_not_granted');
    expect(out.nextSteps[0]).toContain('request_capability');
    expect(upstreamCalls.filter(c => c.body?.method === 'tools/call')).toHaveLength(0);
    expect(audit.some(a => a.capability === 'connector.tool_call' && a.decision === 'refused' && a.reasonCode === 'capability_not_granted')).toBe(true);
  });

  it('a read-only role cannot call a mutation even when the grant store would allow it', async () => {
    currentLoaded = loaded({ run: { roleCeiling: 'query' } });
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    const out = await toolError(await POST(req(call('createMonitor')), ctx()));
    expect(out.code).toBe('role_ceiling');
    expect(mockAuthorizeTool).not.toHaveBeenCalled();
  });

  it('a granted write is recorded before it is sent, with the annotation risk passed to the grant check', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    const res = await POST(req(call('createMonitor', { projectId: 'p1', environment: 'Production' })), ctx());
    expect((await res.json()).result.content[0].text).toBe('ok');
    const iAudit = events.indexOf('audit:connector.tool_call:allowed');
    const iSend = events.lastIndexOf('upstream:tools/call');
    expect(iAudit).toBeGreaterThanOrEqual(0);
    expect(iAudit).toBeLessThan(iSend);
    expect(mockAuthorizeTool.mock.calls[0][1]).toMatchObject({ connectorId: CONN, provider: 'axiom', tool: 'createMonitor', risk: 'write', resource: 'p1', environment: 'production' });
  });

  it('a destructive tool is checked as admin', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: false, reasonCode: 'tool_risk_exceeds_grant' });
    currentLoaded = loaded({ run: { roleCeiling: 'admin' } });
    const out = await toolError(await POST(req(call('deleteDashboard')), ctx()));
    expect(out.code).toBe('capability_not_granted');
    expect(mockAuthorizeTool.mock.calls[0][1].risk).toBe('admin');
  });

  it('anti-replay: the same write (session, id, tool, args) is never sent twice', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    await POST(req(call('createMonitor', { a: 1 }, 42), { session: 's' }), ctx());
    const second = await toolError(await POST(req(call('createMonitor', { a: 1 }, 42), { session: 's' }), ctx()));
    expect(second.code).toBe('replayed_call');
    expect(upstreamCalls.filter(c => c.body?.method === 'tools/call')).toHaveLength(1);
    // A new JSON-RPC id is a new call.
    await POST(req(call('createMonitor', { a: 1 }, 43), { session: 's' }), ctx());
    expect(upstreamCalls.filter(c => c.body?.method === 'tools/call')).toHaveLength(2);
  });

  it('a write is refused when its attempt cannot be recorded', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    auditFails = true;
    const out = await toolError(await POST(req(call('createMonitor')), ctx()));
    expect(out.code).toBe('gateway_unavailable');
    expect(upstreamCalls.filter(c => c.body?.method === 'tools/call')).toHaveLength(0);
  });

  it('rate control: over the per-minute budget is refused; unattended runs get less', async () => {
    mockRecentCount.mockResolvedValue(60);
    expect((await toolError(await POST(req(call('queryApl')), ctx()))).code).toBe('rate_limited');
    mockRecentCount.mockResolvedValue(20);
    currentLoaded = loaded({ run: { unattended: true } });
    expect((await toolError(await POST(req(call('queryApl')), ctx()))).code).toBe('rate_limited');
  });

  it('a scheduled run reads but never writes', async () => {
    currentLoaded = loaded({ run: { unattended: true } });
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    expect((await (await POST(req(call('queryApl')), ctx())).json()).result.content[0].text).toBe('ok');
    expect((await toolError(await POST(req(call('createMonitor')), ctx()))).code).toBe('unattended_ceiling');
  });
});

describe('changes before and during a task', () => {
  it('blocked after install: the next call is refused, and nothing is sent', async () => {
    expect((await (await POST(req(call('queryApl')), ctx())).json()).result.content[0].text).toBe('ok');
    const sentBefore = upstreamCalls.length;
    currentLoaded = loaded({ run: { connector: { blocked: true } } });
    expect((await toolError(await POST(req(call('queryApl')), ctx()))).code).toBe('catalog_blocked');
    expect(upstreamCalls.length).toBe(sentBefore);
    // Non-call methods are refused too.
    const list = await (await POST(req({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx())).json();
    expect(list.error.data.code).toBe('catalog_blocked');
  });

  it('grant revoked mid-task: allowed, then refused on the next call', async () => {
    mockAuthorizeTool.mockResolvedValueOnce({ allowed: true, grantId: 'g-1' });
    mockAuthorizeTool.mockResolvedValueOnce({ allowed: false, reasonCode: 'grant_not_live' });
    expect((await (await POST(req(call('createMonitor', {}, 1)), ctx())).json()).result.content[0].text).toBe('ok');
    const out = await toolError(await POST(req(call('createMonitor', {}, 2)), ctx()));
    expect(out).toMatchObject({ code: 'capability_not_granted', grantReason: 'grant_not_live' });
  });

  it('task ended or worker stopped (a resumed session on a stale grant): refused', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    currentLoaded = loaded({ run: { taskStatus: 'completed' } });
    expect((await toolError(await POST(req(call('createMonitor')), ctx()))).code).toBe('task_terminal');
    currentLoaded = loaded({ run: { workerStatus: 'failed' } });
    expect((await toolError(await POST(req(call('queryApl')), ctx()))).code).toBe('worker_not_live');
  });

  it('role changed to a read-only role mid-task: writes stop, reads go on', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    currentLoaded = loaded({ run: { roleCeiling: 'read' } });
    expect((await toolError(await POST(req(call('createMonitor')), ctx()))).code).toBe('role_ceiling');
    expect((await (await POST(req(call('queryApl')), ctx())).json()).result.content[0].text).toBe('ok');
  });
});

describe('provider credential lifecycle', () => {
  it('expired OAuth: a 401 is refreshed and retried once, transparently', async () => {
    upstreamQueue.push({ native: true }); // the classification tools/list
    upstreamQueue.push({ status: 401, body: {} });
    mockRefresh.mockResolvedValueOnce(true);
    const res = await POST(req(call('queryApl')), ctx());
    expect((await res.json()).result.content[0].text).toBe('ok');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockMarkRejected).not.toHaveBeenCalled();
  });

  it('access revoked at the provider mid-call: reconnect_required as a tool result, credential marked, no abort', async () => {
    upstreamQueue.push({ native: true });
    upstreamQueue.push({ status: 401, body: {} });
    const res = await POST(req(call('queryApl')), ctx());
    expect(res.status).toBe(200);
    const out = await toolError(res);
    expect(out.code).toBe('reconnect_required');
    expect(JSON.stringify(out)).not.toMatch(/401|unauthorized/i); // the runner's 401 breaker must not fire
    expect(mockMarkRejected).toHaveBeenCalledTimes(1);
    expect(audit.some(a => a.capability === 'connector.tool_result' && a.reasonCode === 'reconnect_required')).toBe(true);
  });

  it('no usable credential (refresh failed before the call): reconnect_required, nothing sent', async () => {
    await POST(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ctx()); // tool classes seen
    upstreamCalls.length = 0;
    providerToken = '';
    const out = await toolError(await POST(req(call('queryApl')), ctx()));
    expect(out.code).toBe('reconnect_required');
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('network outage fails closed', () => {
  it('buildd cannot read run state: refused, nothing sent', async () => {
    mockLoadRun.mockImplementationOnce(async () => { throw new Error('neon timeout'); });
    expect((await toolError(await POST(req(call('queryApl')), ctx()))).code).toBe('gateway_unavailable');
    expect(upstreamCalls).toHaveLength(0);
  });

  it('the grant store is unreachable: refused', async () => {
    mockAuthorizeTool.mockImplementationOnce(async () => { throw new Error('neon timeout'); });
    expect((await toolError(await POST(req(call('createMonitor')), ctx()))).code).toBe('gateway_unavailable');
  });

  it('the provider is unreachable mid-call: a tool error that says a write may or may not have happened', async () => {
    upstreamQueue.push({ native: true });
    upstreamQueue.push({ throws: new Error('ECONNRESET') });
    const out = await toolError(await POST(req(call('queryApl')), ctx()));
    expect(out.code).toBe('provider_unreachable');
  });
});

describe('no credential ever leaves the server', () => {
  it('no answer, header or audit row carries the provider token', async () => {
    mockAuthorizeTool.mockResolvedValue({ allowed: true, grantId: 'g-1' });
    const bodies: string[] = [];
    for (const r of [
      await POST(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), ctx()),
      await POST(req({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx()),
      await POST(req(call('queryApl')), ctx()),
      await POST(req(call('createMonitor')), ctx()),
    ]) {
      bodies.push(await r.text(), JSON.stringify([...r.headers.entries()]));
    }
    expect(bodies.join('\n')).not.toContain(PROVIDER_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(PROVIDER_TOKEN);
    // And the agent's buildd token never reaches the provider.
    expect(upstreamCalls.every(c => !JSON.stringify([...c.headers.entries()]).includes(AGENT_TOKEN))).toBe(true);
  });

  it('DELETE ends the provider session with the server-held credential', async () => {
    const r = new NextRequest(`http://localhost/api/mcp/c/${CONN}?worker=${WORKER}`, { method: 'DELETE', headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'mcp-session-id': 's1' } });
    await DELETE(r, ctx());
    expect(upstreamCalls.at(-1)!.headers.get('authorization')).toBe(`Bearer ${PROVIDER_TOKEN}`);
  });
});
