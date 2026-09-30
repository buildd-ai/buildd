import { describe, it, expect } from 'bun:test';
// Pure module: imported directly (never mocked elsewhere), so no mock.module leak.
import {
  expandVarRefs,
  resolveMcpJsonHttpServers,
  buildCodexMcpServers,
} from '../../src/mcp-json';

describe('expandVarRefs', () => {
  it('substitutes resolved refs and reports none unresolved', () => {
    expect(expandVarRefs('Bearer ${TOKEN}', { TOKEN: 'abc' })).toEqual({ value: 'Bearer abc', unresolved: [] });
  });

  it('reports a missing ref instead of hiding it behind an empty string', () => {
    const r = expandVarRefs('Bearer ${TOKEN}', {});
    expect(r.unresolved).toEqual(['TOKEN']);
  });

  it('treats an empty-string value as unresolved (a missing secret, not a token)', () => {
    expect(expandVarRefs('Bearer ${TOKEN}', { TOKEN: '' }).unresolved).toEqual(['TOKEN']);
  });

  it('dedupes and keeps order', () => {
    expect(expandVarRefs('${A}${B}${A}', {}).unresolved).toEqual(['A', 'B']);
  });

  it('passes plain strings through', () => {
    expect(expandVarRefs('https://x.test/mcp', {})).toEqual({ value: 'https://x.test/mcp', unresolved: [] });
  });
});

describe('resolveMcpJsonHttpServers', () => {
  const mcpJson = {
    mcpServers: {
      buildd: { type: 'http', url: 'https://buildd.test/mcp' },
      good: { type: 'http', url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${GOOD_TOKEN}' } },
      missing: { type: 'http', url: 'https://m.test/mcp', headers: { Authorization: 'Bearer ${MISSING_TOKEN}' } },
      badUrl: { type: 'http', url: 'https://${NO_HOST}/mcp' },
      stdio: { command: 'node', args: ['x.js'] },
    },
  };
  const env = { HOST: 'h.test', GOOD_TOKEN: 'secret' };

  it('mounts a server whose refs all resolve, with URL expansion', () => {
    const { servers } = resolveMcpJsonHttpServers(mcpJson, env);
    expect(servers).toEqual([
      { name: 'good', url: 'https://h.test/mcp', headers: { Authorization: 'Bearer secret' } },
    ]);
  });

  it('skips (never mounts with an empty Bearer) a server whose auth ref is missing', () => {
    const { servers, skipped } = resolveMcpJsonHttpServers(mcpJson, env);
    expect(servers.find(s => s.name === 'missing')).toBeUndefined();
    expect(skipped).toContainEqual({ name: 'missing', unresolved: ['MISSING_TOKEN'] });
    expect(skipped).toContainEqual({ name: 'badUrl', unresolved: ['NO_HOST'] });
  });

  it('never returns the reserved buildd server or stdio servers', () => {
    const names = resolveMcpJsonHttpServers(mcpJson, env).servers.map(s => s.name);
    expect(names).not.toContain('buildd');
    expect(names).not.toContain('stdio');
  });

  it('skips names already taken (connector wins)', () => {
    const { servers } = resolveMcpJsonHttpServers(mcpJson, env, { isTaken: n => n === 'good' });
    expect(servers).toEqual([]);
  });

  it('returns nothing for malformed input', () => {
    expect(resolveMcpJsonHttpServers(null, env)).toEqual({ servers: [], skipped: [] });
    expect(resolveMcpJsonHttpServers({ mcpServers: 'x' }, env)).toEqual({ servers: [], skipped: [] });
  });
});

describe('buildCodexMcpServers', () => {
  it('expands the .mcp.json URL (Codex used to pass ${VAR} through literally)', () => {
    const r = buildCodexMcpServers({
      mcpJson: { mcpServers: { cue: { url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${T}' } } } },
      connectors: [],
      env: { HOST: 'cue.test', T: 'tok' },
    });
    expect(r.servers).toEqual([{ name: 'cue', url: 'https://cue.test/mcp', bearerTokenEnvVar: 'MCP_BEARER_CUE' }]);
    expect(r.bearerEnv).toEqual({ MCP_BEARER_CUE: 'tok' });
  });

  it('skips a .mcp.json server whose auth ref is unresolved', () => {
    const r = buildCodexMcpServers({
      mcpJson: { mcpServers: { cue: { url: 'https://cue.test/mcp', headers: { Authorization: 'Bearer ${T}' } } } },
      connectors: [],
      env: {},
    });
    expect(r.servers).toEqual([]);
    expect(r.bearerEnv).toEqual({});
    expect(r.warnings.join('\n')).toContain('T');
  });

  it('connector beats .mcp.json for the same name (same precedence as the Claude path)', () => {
    const r = buildCodexMcpServers({
      mcpJson: { mcpServers: { cue: { url: 'https://file.test/mcp', headers: { Authorization: 'Bearer ${T}' } } } },
      connectors: [{ name: 'cue', url: 'https://conn.test/mcp', headers: { Authorization: 'Bearer conn-tok' } }],
      env: { T: 'file-tok' },
    });
    expect(r.servers).toEqual([{ name: 'cue', url: 'https://conn.test/mcp', bearerTokenEnvVar: 'MCP_BEARER_CONN_CUE' }]);
    expect(r.bearerEnv).toEqual({ MCP_BEARER_CONN_CUE: 'conn-tok' });
  });

  it('skips stdio, assertion-mode and non-Bearer connectors', () => {
    const r = buildCodexMcpServers({
      mcpJson: undefined,
      connectors: [
        { name: 'a', transport: 'stdio' },
        { name: 'b', url: 'https://b.test', assertionMode: true },
        { name: 'c', url: 'https://c.test', headers: { Authorization: 'Basic xyz' } },
        { name: 'd', url: 'https://d.test' },
        { name: 'buildd', url: 'https://buildd.test', headers: { Authorization: 'Bearer x' } },
      ],
      env: {},
    });
    expect(r.servers).toEqual([]);
  });
});
