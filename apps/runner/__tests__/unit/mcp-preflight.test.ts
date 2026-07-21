import { describe, it, expect } from 'bun:test';
import { runMcpPreflight, MCP_PREFLIGHT_TIMEOUT_MS } from '../../src/mcp-preflight';

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
