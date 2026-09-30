/**
 * Unit tests for buildMcpServerEntries — the runner-side mapping of claim-time
 * resolved MCP connectors into the SDK `mcpServers` record shape. Covers both the
 * `http` (url/headers) and `stdio` (command/args/env) transports plus the
 * skip-when-incomplete guards.
 */

import { describe, test, expect, mock } from 'bun:test';

// Must be before importing workers.ts (it transitively loads the Claude SDK).
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

import { buildMcpServerEntries, buildWorkerMcpUrl } from '../../src/workers';

describe('buildMcpServerEntries', () => {
  test('maps an http connector to { type: http, url, headers }', () => {
    const entries = buildMcpServerEntries([
      { name: 'linear', transport: 'http', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer tok' } },
    ]);
    expect(entries).toEqual({
      linear: { type: 'http', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer tok' } },
    });
  });

  test('omits headers for an http connector with no auth', () => {
    const entries = buildMcpServerEntries([
      { name: 'docs', transport: 'http', url: 'https://mcp.example.com' },
    ]);
    expect(entries).toEqual({ docs: { type: 'http', url: 'https://mcp.example.com' } });
  });

  test('maps a stdio connector to { type: stdio, command, args, env }', () => {
    const entries = buildMcpServerEntries([
      { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } },
    ]);
    expect(entries).toEqual({
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_x' },
      },
    });
  });

  test('omits empty args/env on a stdio connector', () => {
    const entries = buildMcpServerEntries([
      { name: 'bare', transport: 'stdio', command: 'my-server', args: [], env: {} },
    ]);
    expect(entries).toEqual({ bare: { type: 'stdio', command: 'my-server' } });
  });

  test('defaults to http transport when transport is absent', () => {
    const entries = buildMcpServerEntries([
      { name: 'legacy', url: 'https://legacy.example.com' },
    ]);
    expect(entries.legacy).toEqual({ type: 'http', url: 'https://legacy.example.com' });
  });

  test('skips a stdio connector missing its command', () => {
    const entries = buildMcpServerEntries([
      { name: 'broken', transport: 'stdio' },
    ]);
    expect(entries).toEqual({});
  });

  test('skips an http connector missing its url', () => {
    const entries = buildMcpServerEntries([
      { name: 'broken', transport: 'http', headers: { 'X-Key': 'v' } },
    ]);
    expect(entries).toEqual({});
  });

  test('maps mixed transports together', () => {
    const entries = buildMcpServerEntries([
      { name: 'remote', transport: 'http', url: 'https://r.example.com' },
      { name: 'local', transport: 'stdio', command: 'uvx', args: ['some-mcp'] },
    ]);
    expect(Object.keys(entries).sort()).toEqual(['local', 'remote']);
    expect(entries.remote).toEqual({ type: 'http', url: 'https://r.example.com' });
    expect(entries.local).toEqual({ type: 'stdio', command: 'uvx', args: ['some-mcp'] });
  });

  test('returns an empty record for undefined input', () => {
    expect(buildMcpServerEntries(undefined)).toEqual({});
  });

  test('skips assertion-mode connectors (resolved async at connect time)', () => {
    const entries = buildMcpServerEntries([
      {
        name: 'cue',
        assertionMode: true,
        url: 'https://mcp.cue.example.com',
        mintApiUrl: 'https://buildd.dev/api/connectors/c1/assertion',
        tokenEndpoint: 'https://cue.example.com/token',
      } as any,
      { name: 'linear', transport: 'http', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer tok' } },
    ]);
    // Assertion connector must be excluded; static connector must be included.
    expect(Object.keys(entries)).toEqual(['linear']);
    expect(entries.linear).toEqual({ type: 'http', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer tok' } });
  });
});

describe('reserved worker MCP surface', () => {
  test('Analyst mount advertises the analytics and lifecycle tools', async () => {
    const { mcpToolSurfaceFor, listMcpTools } = await import('../../../web/src/app/api/mcp/tools');
    const { DEFAULT_ROLES } = await import('../../../web/src/lib/default-roles');
    const analyst = DEFAULT_ROLES.find(role => role.slug === 'analyst')!;
    const configuredUrl = new URL((analyst.mcpServers.buildd as { url: string }).url);
    const url = new URL(buildWorkerMcpUrl(configuredUrl.origin, 'test-workspace', 'test-worker', analyst.slug));
    const surface = mcpToolSurfaceFor({ toolsParam: url.searchParams.get('tools'), workerParam: url.searchParams.get('worker') });
    expect(url.searchParams.get('workspace')).toBe('test-workspace');
    expect(url.searchParams.get('worker')).toBe('test-worker');
    const names = listMcpTools({ accountLevel: 'worker', isSensitive: false, surface }).map(tool => tool.name);
    expect(names).toContain('buildd_analytics');
    expect(names).toContain('buildd_work');
    for (const tool of analyst.allowedTools.filter(tool => tool.startsWith('mcp__buildd__'))) {
      expect(names).toContain(tool.replace('mcp__buildd__', ''));
    }
  });

  test('other role sessions retain legacy and grouped skill agents opt in', () => {
    for (const role of ['builder', 'organizer', undefined]) {
      expect(new URL(buildWorkerMcpUrl('https://buildd.dev', 'workspace', 'worker', role)).searchParams.has('tools')).toBe(false);
    }
    expect(new URL(buildWorkerMcpUrl('https://buildd.dev', 'workspace', 'worker', 'organizer', {
      analyst: { tools: ['mcp__buildd__buildd_analytics', 'mcp__buildd__buildd_work'] },
    })).searchParams.get('tools')).toBe('groups');
  });
});
