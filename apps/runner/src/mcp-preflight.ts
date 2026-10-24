/**
 * MCP pre-flight connectivity probe.
 *
 * Before the agent loop begins, verifies that each connector-required MCP
 * server is (a) present in the assembled MCP config and (b) responds to an
 * MCP initialize request. On failure the caller throws WITHOUT invoking the
 * model, preventing agents from improvising when a required tool channel is
 * absent.
 *
 * Scope: only servers from claimConnectors (role's explicit connectorRefs).
 * Workspace-level .mcp.json servers are optional and are not probed here.
 */

export interface McpPreflightFailure {
  code: 'mcp_preflight_failed';
  server: string;
  reason: string;
}

/** Default per-server probe timeout */
export const MCP_PREFLIGHT_TIMEOUT_MS = 8_000;

const MCP_INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'buildd-preflight', version: '1.0.0' },
  },
});

/**
 * The JSON-RPC error in an initialize answer (plain JSON or SSE `data:` lines),
 * as a one-line reason, or null when there is none or the body is not JSON-RPC.
 */
export function initializeRpcError(contentType: string, body: string): string | null {
  const payloads = contentType.includes('text/event-stream')
    ? body.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
    : [body];
  for (const p of payloads) {
    let msg: { error?: { code?: unknown; message?: unknown; data?: { code?: unknown } } };
    try { msg = JSON.parse(p); } catch { continue; }
    const err = msg?.error;
    if (!err || typeof err !== 'object') continue;
    const message = String(err.message ?? 'no message').slice(0, 100);
    const code = typeof err.data?.code === 'string' && !message.includes(err.data.code) ? ` (${err.data.code})` : '';
    return `JSON-RPC error ${String(err.code ?? '?')}: ${message}${code}`;
  }
  return null;
}

/** POST an MCP initialize request and return null on success or an error reason string. */
async function probeHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: MCP_INITIALIZE_BODY,
      signal: ctrl.signal,
    });

    // 404 = wrong URL (URL routing issue, server isn't at this path)
    if (res.status === 404) return `HTTP 404 (server not found at URL)`;
    // 502/503/504 = upstream proxy can't reach the backend
    if (res.status === 502 || res.status === 503 || res.status === 504) return `HTTP ${res.status} (gateway/proxy error)`;
    // A 2xx that answers initialize with a JSON-RPC error is not up: buildd's
    // connector gateway reports a dead provider credential this way, and the
    // SDK then fails the server for the whole session.
    if (res.ok) {
      const rpcError = initializeRpcError(res.headers.get('content-type') ?? '', await res.text().catch(() => ''));
      if (rpcError) return rpcError;
    }
    // Any other response (200, 400, 401, 403, 500) = server is reachable
    return null;
  } catch (err: any) {
    if (err?.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
    return (err?.message ?? String(err)).slice(0, 120);
  } finally {
    clearTimeout(timer);
  }
}

export interface McpPreflightOptions {
  /** Assembled MCP servers (including 'buildd') from queryOptions.mcpServers */
  mcpServers: Record<string, { type: string; url?: string; headers?: Record<string, string>; command?: string }>;
  /** Connector names from claimConnectors — these MUST be mounted and reachable */
  requiredConnectorNames: string[];
  /** Per-server probe timeout (default MCP_PREFLIGHT_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Seam for testing — defaults to globalThis.fetch */
  fetcher?: typeof fetch;
}

export async function runMcpPreflight(opts: McpPreflightOptions): Promise<{ ok: boolean; failures: McpPreflightFailure[] }> {
  const {
    mcpServers,
    requiredConnectorNames,
    timeoutMs = MCP_PREFLIGHT_TIMEOUT_MS,
    fetcher = globalThis.fetch,
  } = opts;

  const failures: McpPreflightFailure[] = [];

  for (const name of requiredConnectorNames) {
    if (name === 'buildd') continue; // buildd is always trusted; never probe it

    const entry = mcpServers[name];

    // Step 1: connector must be mounted in the worker MCP config
    if (!entry) {
      failures.push({
        code: 'mcp_preflight_failed',
        server: name,
        reason: 'not mounted in worker MCP config (connector injection failed — assertion exchange or credential resolution error)',
      });
      continue;
    }

    // Step 2: probe connectivity
    let reason: string | null = null;
    if (entry.type === 'http' && entry.url) {
      reason = await probeHttp(entry.url, entry.headers ?? {}, timeoutMs, fetcher);
    }
    // stdio servers: not probed (spawning a process just to check would have side
    // effects). Stdio connectors are uncommon and their failure mode is obvious.

    if (reason !== null) {
      failures.push({ code: 'mcp_preflight_failed', server: name, reason });
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Split pre-flight failures into the ones that fail the task (connectors the
 * role opted into) and optional ones (gateway connectors mounted for every
 * role), which are removed from `mcpServers` so the session starts without them.
 *
 * The note matters as much as the drop: a gateway connector is served from
 * buildd's own origin (/api/mcp/c/<id>), and agents read its failure as "the
 * buildd MCP server is down", then never call complete_task.
 */
export function settleOptionalConnectorFailures(
  mcpServers: Record<string, unknown>,
  failures: McpPreflightFailure[],
  optionalNames: ReadonlySet<string>,
): { required: McpPreflightFailure[]; dropped: McpPreflightFailure[]; promptNote: string | null } {
  const required = failures.filter(f => !optionalNames.has(f.server));
  const dropped = failures.filter(f => optionalNames.has(f.server));
  for (const f of dropped) delete mcpServers[f.server];
  const promptNote = dropped.length === 0 ? null : [
    '## Unavailable connectors',
    `These optional MCP connectors failed to start and are not in this session: ${dropped.map(f => `${f.server} (${f.reason})`).join('; ')}.`,
    'Each is a separate data source, not the buildd server: the buildd tools (complete_task, artifacts, analytics, progress) still work. Do not report buildd as unavailable because of them. Work from the sources you have, say in your result which one was missing, and finish the task with complete_task as usual.',
  ].join('\n');
  return { required, dropped, promptNote };
}
