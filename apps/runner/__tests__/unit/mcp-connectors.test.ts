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

import { buildMcpServerEntries } from '../../src/workers';

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
});
