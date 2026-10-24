import { describe, it, expect } from 'bun:test';
import { runMcpPreflight, settleOptionalConnectorFailures, MCP_PREFLIGHT_TIMEOUT_MS } from '../../src/mcp-preflight';

// Helpers to build fake fetch responses
function okFetch(_url: string, _opts?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response('{"result":{"serverInfo":{}}}', { status: 200 }));
}

function notFoundFetch(_url: string, _opts?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response('Not Found', { status: 404 }));
}

function gatewayFetch(status: 502 | 503 | 504) {
  return (_url: string, _opts?: RequestInit): Promise<Response> =>
    Promise.resolve(new Response('Gateway Error', { status }));
}

function connRefusedFetch(_url: string, _opts?: RequestInit): Promise<Response> {
  return Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
}

function timeoutFetch(_url: string, opts?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    // Simulate the AbortController firing
    const signal = opts?.signal as AbortSignal | undefined;
    if (signal) {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    }
  });
}

function unauthorizedFetch(_url: string, _opts?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response('Unauthorized', { status: 401 }));
}

function serverErrorFetch(_url: string, _opts?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
}

describe('runMcpPreflight', () => {
  it('returns ok when no required connectors and no servers to probe', async () => {
    const result = await runMcpPreflight({
      mcpServers: { buildd: { type: 'http', url: 'http://buildd' } },
      requiredConnectorNames: [],
      fetcher: okFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('returns ok when all required connectors are mounted and reachable', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp', headers: { Authorization: 'Bearer token' } },
        dispatch: { type: 'http', url: 'http://dispatch.example.com/mcp' },
      },
      requiredConnectorNames: ['cue', 'dispatch'],
      fetcher: okFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when a required connector is not mounted (injection failed)', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        // cue is MISSING — injection failed (assertion exchange or build error)
      },
      requiredConnectorNames: ['cue'],
      fetcher: okFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].server).toBe('cue');
    expect(result.failures[0].reason).toMatch(/not mounted/);
  });

  it('fails when a required connector returns 404', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      fetcher: notFoundFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].server).toBe('cue');
    expect(result.failures[0].reason).toMatch(/404/);
  });

  it('fails when a required connector returns 502 (gateway error)', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      fetcher: gatewayFetch(502) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toMatch(/502/);
  });

  it('fails when a required connector connection is refused', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      fetcher: connRefusedFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].server).toBe('cue');
    expect(result.failures[0].reason).toMatch(/ECONNREFUSED/);
  });

  it('fails when a required connector times out', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      timeoutMs: 50,
      fetcher: timeoutFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].server).toBe('cue');
    expect(result.failures[0].reason).toMatch(/timeout/);
  });

  it('treats 401 (unauthorized) as server reachable (ok)', async () => {
    // A 401 means the server is up but auth failed — not a preflight failure
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      fetcher: unauthorizedFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  // buildd's connector gateway answers a provider credential problem
  // (no_credential / reconnect_required) with HTTP 200 and a JSON-RPC error.
  // Claude Code then fails the server as a ProtocolError, so a 200 is not "up".
  it('fails when a 2xx initialize answer carries a JSON-RPC error', async () => {
    const result = await runMcpPreflight({
      mcpServers: { axiom: { type: 'http', url: 'https://buildd.dev/api/mcp/c/conn-1' } },
      requiredConnectorNames: ['axiom'],
      fetcher: (async () => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Provider request failed: reconnect_required', data: { code: 'reconnect_required' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].server).toBe('axiom');
    expect(result.failures[0].reason).toContain('-32002');
    expect(result.failures[0].reason).toContain('reconnect_required');
  });

  it('reads a JSON-RPC error from an SSE initialize answer', async () => {
    const result = await runMcpPreflight({
      mcpServers: { axiom: { type: 'http', url: 'https://buildd.dev/api/mcp/c/conn-1' } },
      requiredConnectorNames: ['axiom'],
      fetcher: (async () => new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Provider request failed: no_credential' } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain('no_credential');
  });

  it('passes an SSE initialize answer that carries a result', async () => {
    const result = await runMcpPreflight({
      mcpServers: { axiom: { type: 'http', url: 'https://buildd.dev/api/mcp/c/conn-1' } },
      requiredConnectorNames: ['axiom'],
      fetcher: (async () => new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'axiom' } } })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('treats 500 (server error) as server reachable (ok)', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        cue: { type: 'http', url: 'http://cue.example.com/mcp' },
      },
      requiredConnectorNames: ['cue'],
      fetcher: serverErrorFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('collects multiple failures when several required connectors fail', async () => {
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        // cue missing, dispatch unreachable
        dispatch: { type: 'http', url: 'http://dispatch.example.com/mcp' },
      },
      requiredConnectorNames: ['cue', 'dispatch'],
      fetcher: connRefusedFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
    const names = result.failures.map(f => f.server);
    expect(names).toContain('cue');
    expect(names).toContain('dispatch');
  });

  it('skips buildd server even if in requiredConnectorNames', async () => {
    // 'buildd' is always trusted — never probe it
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
      },
      requiredConnectorNames: ['buildd'],
      fetcher: connRefusedFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it('does not probe non-required (workspace-level) servers', async () => {
    // A workspace .mcp.json server that isn't a connector should not be probed
    let probeCount = 0;
    const countingFetch = (_url: string, _opts?: RequestInit): Promise<Response> => {
      probeCount++;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };
    const result = await runMcpPreflight({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        optional_workspace_server: { type: 'http', url: 'http://optional.example.com/mcp' },
      },
      requiredConnectorNames: [],  // No connector requirements
      fetcher: countingFetch as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(probeCount).toBe(0);  // No probes sent
  });

  it('exports MCP_PREFLIGHT_TIMEOUT_MS constant', () => {
    expect(typeof MCP_PREFLIGHT_TIMEOUT_MS).toBe('number');
    expect(MCP_PREFLIGHT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('settleOptionalConnectorFailures', () => {
  const failure = (server: string) => ({ code: 'mcp_preflight_failed' as const, server, reason: 'JSON-RPC error -32002: Provider request failed: reconnect_required' });

  it('drops a failed optional connector from the session and keeps the task running', () => {
    const mcpServers: Record<string, unknown> = { buildd: {}, axiom: {} };
    const out = settleOptionalConnectorFailures(mcpServers, [failure('axiom')], new Set(['axiom']));
    expect(out.required).toEqual([]);
    expect(out.dropped.map(f => f.server)).toEqual(['axiom']);
    expect(Object.keys(mcpServers)).toEqual(['buildd']);
  });

  it('tells the agent the dropped connector is not the buildd server', () => {
    const out = settleOptionalConnectorFailures({ buildd: {}, axiom: {} }, [failure('axiom')], new Set(['axiom']));
    expect(out.promptNote).toContain('axiom');
    expect(out.promptNote).toContain('reconnect_required');
    expect(out.promptNote).toMatch(/not the buildd server/i);
    expect(out.promptNote).toContain('complete_task');
  });

  it('leaves a failed required connector to fail the task', () => {
    const mcpServers: Record<string, unknown> = { buildd: {}, cue: {}, axiom: {} };
    const out = settleOptionalConnectorFailures(mcpServers, [failure('cue'), failure('axiom')], new Set(['axiom']));
    expect(out.required.map(f => f.server)).toEqual(['cue']);
    expect(out.dropped.map(f => f.server)).toEqual(['axiom']);
    expect(Object.keys(mcpServers)).toEqual(['buildd', 'cue']);
  });

  it('writes no note when nothing was dropped', () => {
    expect(settleOptionalConnectorFailures({ buildd: {} }, [], new Set()).promptNote).toBeNull();
  });
});
