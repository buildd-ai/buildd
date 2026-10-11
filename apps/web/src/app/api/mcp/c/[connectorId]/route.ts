/**
 * /api/mcp/c/[connectorId]?worker=<workerId> — the connector gateway.
 *
 * A verbatim MCP (Streamable HTTP) pass-through in front of a provider's own
 * MCP server (Axiom, Vercel, …). The agent's runtime mounts this URL with its
 * per-task buildd token; the provider credential never leaves the server.
 *
 *   POST    one JSON-RPC message, forwarded unchanged with the provider
 *           credential added. `tools/list` is subset-filtered to the run's
 *           ceiling; `tools/call` is decided per call (connector-gateway.ts)
 *           and audited (attempt, result, denial). A denial is an MCP tool
 *           result with isError, never an HTTP auth challenge.
 *   DELETE  ends the provider session.
 *   GET     405: stateless, no server-initiated stream (same as /api/mcp).
 *
 * Auth: per-task token (bldt_…) or runner key, naming a live worker on its own
 * task. Another team's connector or worker answers 404. Every request re-reads
 * the run's state, so a revoke, block, role change or ended task stops the
 * next call, including in a resumed session.
 *
 * Spec: docs/specs/capability-requests.md §Connector gateway.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { authenticateTaskScopedCaller, taskScopeAllowsWorker, taskScopeAllowsWorkspace } from '@/lib/task-token-auth';
import { resolveWorkerPrincipal } from '@/lib/agent-capabilities/worker-principal';
import type { AgentPrincipal } from '@/lib/agent-capabilities/principal';
import { authorizeConnectorToolUse } from '@/lib/capability-grants-store';
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  RATE_LIMITS,
  UPSTREAM_TIMEOUT_MS,
  argsHash,
  callKey,
  callScope,
  classifyNativeTool,
  connectorRefusal,
  decideToolCall,
  deniedToolResult,
  filterToolsList,
  methodAllowed,
  readToolOverrides,
  toolResource,
  upstreamToolError,
  type CallRefusal,
  type ToolClass,
} from '@/lib/connector-gateway';
import {
  TOOL_CALL_CAPABILITY,
  TOOL_RESULT_CAPABILITY,
  isReplayedCall,
  loadGatewayRun,
  markCredentialRejected,
  noteToolAudit,
  providerAuthHeader,
  recentCallCount,
  refreshAfterRejection,
  writeToolAudit,
  type LoadedGateway,
  type ToolAuditRow,
} from '@/lib/connector-gateway-store';

export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
/** Request headers forwarded to the provider. Never the caller's Authorization or cookies. */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
/** Response headers returned. Never WWW-Authenticate (the agent must not start an OAuth dance) or Set-Cookie. */
const FORWARD_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version'];

// ── Tool classes seen in tools/list, per connector (per instance, short-lived) ─

const CLASS_TTL_MS = 10 * 60 * 1000;
const classCache = new Map<string, { at: number; classes: Map<string, ToolClass> }>();

function cachedClass(connectorId: string, tool: string, now: number): ToolClass | undefined {
  const e = classCache.get(connectorId);
  if (!e || now - e.at > CLASS_TTL_MS) return undefined;
  return e.classes.get(tool);
}

function rememberClasses(connectorId: string, classes: Map<string, ToolClass>, now: number, merge: boolean) {
  const prev = merge ? classCache.get(connectorId) : undefined;
  const merged = prev && now - prev.at <= CLASS_TTL_MS ? new Map([...prev.classes, ...classes]) : classes;
  classCache.delete(connectorId);
  classCache.set(connectorId, { at: now, classes: merged });
  if (classCache.size > 500) classCache.delete(classCache.keys().next().value!);
}

/** Test-only. */
export function __resetGatewayCache() { classCache.clear(); }

// ── Helpers ──────────────────────────────────────────────────────────────────

function rpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }, { status, headers: NO_STORE });
}

const rpcJson = (body: unknown) => NextResponse.json(body, { headers: NO_STORE });

/** An https URL (http only in development). Credentials are never sent anywhere else. */
function upstreamUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (process.env.NODE_ENV === 'development' && u.protocol === 'http:');
  } catch {
    return false;
  }
}

async function authenticate(req: NextRequest, connectorId: string): Promise<{ principal: AgentPrincipal } | NextResponse> {
  if (!UUID_RE.test(connectorId)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const account = await authenticateTaskScopedCaller(token, req);
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  if (account.level === 'trigger') return NextResponse.json({ error: 'Trigger tokens cannot use connectors' }, { status: 403, headers: NO_STORE });
  const workerId = req.nextUrl.searchParams.get('worker') ?? '';
  if (!ID_RE.test(workerId)) return NextResponse.json({ error: 'worker is required' }, { status: 400, headers: NO_STORE });
  const resolved = await resolveWorkerPrincipal(account, { workerId });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error, code: resolved.reasonCode }, { status: resolved.status, headers: NO_STORE });
  if (!(taskScopeAllowsWorker(account, { taskId: resolved.principal.taskId }) && taskScopeAllowsWorkspace(account, resolved.principal.workspaceId))) {
    return NextResponse.json({ error: 'Worker not found' }, { status: 404, headers: NO_STORE });
  }
  return { principal: { ...resolved.principal, via: account.taskScope ? 'task_token' : 'runner_key' } };
}

type Upstream =
  | { ok: true; res: Response; body: string }
  | { ok: false; code: 'reconnect_required' | 'provider_unreachable' | 'provider_timeout' | 'response_too_large' | 'no_credential' };

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Send one message to the provider with the server-held credential. On a 401
 * the OAuth token is refreshed and the request retried once (a 401 means the
 * provider did not act, so this is safe for writes too).
 */
async function sendUpstream(g: LoadedGateway, method: 'POST' | 'DELETE', reqHeaders: Headers, body: string | null): Promise<Upstream> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await providerAuthHeader(g);
    if (!auth) return { ok: false, code: attempt === 0 ? 'no_credential' : 'reconnect_required' };
    const headers = new Headers();
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = reqHeaders.get(h);
      if (v) headers.set(h, v);
    }
    if (method === 'POST' && !headers.has('accept')) headers.set('accept', 'application/json, text/event-stream');
    headers.set(auth.name, auth.value);
    let res: Response;
    try {
      res = await fetch(g.connector.url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, code: (err as Error)?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unreachable' };
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, code: 'provider_unreachable' };
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      if (attempt === 0 && await refreshAfterRejection(g)) continue;
      await markCredentialRejected(g).catch(() => {});
      return { ok: false, code: 'reconnect_required' };
    }
    const text = await readCapped(res);
    if (text === null) return { ok: false, code: 'response_too_large' };
    return { ok: true, res, body: text };
  }
  return { ok: false, code: 'reconnect_required' };
}

/** The JSON-RPC messages in a provider answer (JSON or SSE), with a re-serializer. */
function parseRpcBody(contentType: string, body: string): { messages: unknown[]; serialize: (msgs: unknown[]) => string } | null {
  if (contentType.includes('text/event-stream')) {
    const events = body.split(/\r?\n\r?\n/);
    const parsed: { lines: string[]; dataIdx: number; msg: unknown }[] = [];
    for (const ev of events) {
      if (!ev.trim()) continue;
      const lines = ev.split(/\r?\n/);
      const dataLines = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
      let msg: unknown = undefined;
      if (dataLines.length) {
        try { msg = JSON.parse(dataLines.join('\n')); } catch { msg = undefined; }
      }
      parsed.push({ lines: lines.filter(l => !l.startsWith('data:')), dataIdx: dataLines.length ? 1 : -1, msg });
    }
    return {
      messages: parsed.map(p => p.msg),
      serialize: msgs => parsed.map((p, i) => {
        const out = [...p.lines];
        if (p.dataIdx >= 0) out.push(`data: ${msgs[i] === undefined ? '' : JSON.stringify(msgs[i])}`);
        return out.join('\n');
      }).join('\n\n') + '\n\n',
    };
  }
  try {
    const msg = JSON.parse(body);
    return { messages: [msg], serialize: msgs => JSON.stringify(msgs[0]) };
  } catch {
    return null;
  }
}

function respond(up: { res: Response; body: string }, body: string = up.body) {
  const headers = new Headers(NO_STORE);
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = up.res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(body, { status: up.res.status, headers });
}

/** Classify a tool the cache has not seen by asking the provider for its list (fail closed on any error). */
async function classifyFromProvider(g: LoadedGateway, reqHeaders: Headers, tool: string): Promise<ToolClass> {
  const overrides = readToolOverrides(g.connector.discoveredMetadata);
  const now = Date.now();
  let cursor: string | undefined;
  const seen = new Map<string, ToolClass>();
  for (let page = 0; page < 5; page++) {
    const id = `buildd-gw-${randomUUID()}`;
    const up = await sendUpstream(g, 'POST', reqHeaders, JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }));
    if (!up.ok || up.res.status >= 400) break;
    const parsed = parseRpcBody(up.res.headers.get('content-type') ?? '', up.body);
    const msg = parsed?.messages.find(m => (m as { id?: unknown })?.id === id) as { result?: { tools?: unknown; nextCursor?: unknown } } | undefined;
    const tools = Array.isArray(msg?.result?.tools) ? msg!.result!.tools as { name?: unknown; annotations?: unknown }[] : [];
    for (const t of tools) if (typeof t?.name === 'string') seen.set(t.name, classifyNativeTool(t.name, t.annotations as never, overrides));
    if (seen.has(tool) || typeof msg?.result?.nextCursor !== 'string') break;
    cursor = msg.result.nextCursor;
  }
  if (seen.size) rememberClasses(g.connector.id, seen, now, true);
  return seen.get(tool) ?? classifyNativeTool(tool, null, overrides);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params;
  const authed = await authenticate(req, connectorId);
  if (authed instanceof NextResponse) return authed;
  const { principal } = authed;

  const raw = await req.text().catch(() => null);
  if (raw === null) return rpcError(null, -32700, 'Invalid body', undefined, 400);
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) return rpcError(null, -32600, 'Request too large', undefined, 413);
  let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, 'Parse error', undefined, 400);
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, 'Batched requests are not supported by this connector gateway', undefined, 400);
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid request', undefined, 400);
  const isRequest = typeof msg.method === 'string';
  const isNotification = isRequest && !('id' in msg);
  if (isRequest && !methodAllowed(msg.method)) return rpcError(msg.id, -32601, `Method not available through the buildd connector gateway: ${String(msg.method).slice(0, 80)}`);

  let g: LoadedGateway | null;
  try {
    g = await loadGatewayRun(principal, connectorId);
  } catch (err) {
    console.warn(`[connector-gateway] run state unavailable: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    return msg.method === 'tools/call'
      ? rpcJson(deniedToolResult(msg.id, 'gateway_unavailable'))
      : rpcError(msg.id, -32603, 'buildd could not check this request right now', { code: 'gateway_unavailable' }, 503);
  }
  if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  if (!upstreamUrlAllowed(g.connector.url)) return rpcError(msg.id, -32603, 'Connector URL must be https', { code: 'connector_url_refused' }, 502);

  const refusal = connectorRefusal(g.run);
  if (refusal && msg.method !== 'tools/call') {
    if (isNotification) return new NextResponse(null, { status: 202, headers: NO_STORE });
    return rpcError(msg.id, -32001, `Connector not available to this run: ${refusal}`, { code: refusal });
  }

  if (msg.method === 'tools/call') return toolsCall(req, principal, g, msg);

  const up = await sendUpstream(g, 'POST', req.headers, raw);
  if (!up.ok) {
    if (isNotification) return new NextResponse(null, { status: 202, headers: NO_STORE });
    return rpcError(msg.id, -32002, `Provider request failed: ${up.code}`, { code: up.code }, up.code === 'no_credential' || up.code === 'reconnect_required' ? 200 : 502);
  }

  if (msg.method === 'tools/list' && up.res.status < 400) {
    const parsed = parseRpcBody(up.res.headers.get('content-type') ?? '', up.body);
    if (!parsed) return rpcError(msg.id, -32603, 'Provider answered tools/list with something that is not JSON-RPC', { code: 'provider_bad_response' }, 502);
    const overrides = readToolOverrides(g.connector.discoveredMetadata);
    const seen = new Map<string, ToolClass>();
    const filtered = parsed.messages.map(m => {
      const mm = m as { id?: unknown; result?: unknown } | undefined;
      if (!mm || mm.id !== msg.id || !mm.result) return m;
      const f = filterToolsList(mm.result, g!.run, overrides);
      for (const [k, v] of f.classes) seen.set(k, v);
      return { ...mm, result: f.result };
    });
    rememberClasses(g.connector.id, seen, Date.now(), !!(msg.params as { cursor?: unknown } | undefined)?.cursor);
    return respond(up, parsed.serialize(filtered));
  }
  return respond(up);
}

async function toolsCall(
  req: NextRequest,
  principal: AgentPrincipal,
  g: LoadedGateway,
  msg: { id?: unknown; params?: Record<string, unknown> },
) {
  const tool = typeof msg.params?.name === 'string' ? msg.params.name : '';
  if (!tool || tool.length > 160) return rpcError(msg.id, -32602, 'tools/call needs a tool name');
  const args = msg.params?.arguments ?? {};
  const hash = argsHash(args);
  const resource = toolResource(g.connector.id, tool);
  const base = { principal, resource };
  const refuse = (code: CallRefusal, cls: ToolClass | null, extra: Record<string, unknown> = {}) => {
    noteToolAudit({ ...base, capability: TOOL_CALL_CAPABILITY, decision: 'refused', reasonCode: code, sideEffect: { risk: cls, argsHash: hash, provider: g.run.connector.provider, ...extra } });
    return rpcJson(deniedToolResult(msg.id, code, { tool, provider: g.run.connector.provider, ...(extra.grantReason ? { grantReason: extra.grantReason } : {}) }));
  };

  let cls: ToolClass;
  let decision: Awaited<ReturnType<typeof decideToolCall>>;
  try {
    const limit = g.run.unattended ? RATE_LIMITS.unattended : RATE_LIMITS.attended;
    if (!connectorRefusal(g.run) && await recentCallCount(principal.workerId, g.connector.id) >= limit) return refuse('rate_limited', null);
    cls = connectorRefusal(g.run) ? classifyNativeTool(tool, null) : cachedClass(g.connector.id, tool, Date.now()) ?? await classifyFromProvider(g, req.headers, tool);
    const scope = callScope(args);
    decision = await decideToolCall(cls, g.run, () => authorizeConnectorToolUse(principal, {
      provider: g.run.connector.provider, connectorId: g.connector.id, tool,
      resource: scope.resource, environment: scope.environment, risk: cls === 'denied' ? 'admin' : cls,
    }));
  } catch (err) {
    console.warn(`[connector-gateway] decision failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
    return refuse('gateway_unavailable', null);
  }
  if (!decision.allowed) return refuse(decision.code, cls, decision.grantReason ? { grantReason: decision.grantReason } : {});

  const isWrite = cls === 'write' || cls === 'admin';
  const key = callKey({ workerId: principal.workerId, sessionId: req.headers.get('mcp-session-id'), rpcId: msg.id, tool, argsHash: hash });
  const attempt: ToolAuditRow = {
    ...base, capability: TOOL_CALL_CAPABILITY, decision: 'allowed' as const, reasonCode: decision.basis,
    sideEffect: { risk: cls, basis: decision.basis, grantId: decision.grantId, argsHash: hash, callKey: key, provider: g.run.connector.provider },
  };
  if (isWrite) {
    // A write is sent once, and only after its attempt is on record.
    try {
      if (await isReplayedCall(principal.workerId, key)) return refuse('replayed_call', cls);
      await writeToolAudit(attempt);
    } catch {
      return refuse('gateway_unavailable', cls);
    }
  } else {
    noteToolAudit(attempt);
  }

  const started = Date.now();
  const up = await sendUpstream(g, 'POST', req.headers, JSON.stringify(msg));
  const result = (status: string, http: number | null) => noteToolAudit({
    ...base, capability: TOOL_RESULT_CAPABILITY, decision: status === 'ok' ? 'allowed' : 'refused', reasonCode: status,
    sideEffect: { risk: cls, callKey: key, status, httpStatus: http, durationMs: Date.now() - started },
  });
  if (!up.ok) {
    const code = up.code === 'no_credential' ? 'reconnect_required' : up.code;
    result(code, null);
    return rpcJson(upstreamToolError(msg.id, code));
  }
  const parsed = parseRpcBody(up.res.headers.get('content-type') ?? '', up.body);
  const answer = parsed?.messages.find(m => (m as { id?: unknown })?.id === msg.id) as { result?: { isError?: unknown }; error?: unknown } | undefined;
  result(up.res.status >= 400 || answer?.error ? 'upstream_error' : answer?.result?.isError === true ? 'tool_error' : 'ok', up.res.status);
  return respond(up);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ connectorId: string }> }) {
  const { connectorId } = await params;
  const authed = await authenticate(req, connectorId);
  if (authed instanceof NextResponse) return authed;
  let g: LoadedGateway | null;
  try {
    g = await loadGatewayRun(authed.principal, connectorId);
  } catch {
    return NextResponse.json({ error: 'gateway_unavailable' }, { status: 503, headers: NO_STORE });
  }
  if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  if (!req.headers.get('mcp-session-id') || !upstreamUrlAllowed(g.connector.url)) return new NextResponse(null, { status: 204, headers: NO_STORE });
  const up = await sendUpstream(g, 'DELETE', req.headers, null);
  return up.ok ? respond(up) : new NextResponse(null, { status: 204, headers: NO_STORE });
}

export async function GET() {
  return NextResponse.json({ error: 'This connector gateway is stateless and has no server-initiated stream.' }, { status: 405, headers: { ...NO_STORE, Allow: 'POST, DELETE' } });
}
