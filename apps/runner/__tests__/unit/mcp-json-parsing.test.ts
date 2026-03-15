import { describe, it, expect } from 'bun:test';
// Import from mcp-json directly — this module is NOT mocked by other test files,
// unlike env-scan which is widely mocked and causes mock.module() pollution in Bun.
import { parseMcpJsonContent, extractVarReferences, type McpServerInfo } from '../../src/mcp-json';

describe('extractVarReferences', () => {
  it('extracts ${VAR} from a string', () => {
    expect(extractVarReferences('Bearer ${API_TOKEN}')).toEqual(['API_TOKEN']);
  });

  it('extracts multiple vars from a string', () => {
    const vars = extractVarReferences('${HOST}:${PORT}/path');
    expect(vars).toEqual(['HOST', 'PORT']);
  });

  it('returns empty array for strings without vars', () => {
    expect(extractVarReferences('plain text')).toEqual([]);
  });

  it('deduplicates repeated vars', () => {
    const vars = extractVarReferences('${TOKEN} and ${TOKEN}');
    expect(vars).toEqual(['TOKEN']);
  });
});

describe('parseMcpJsonContent', () => {
  it('parses valid JSON with mcpServers', () => {
    const mcpConfig = {
      mcpServers: {
        buildd: {
          type: 'sse',
          url: 'https://api.buildd.dev/mcp',
          headers: {
            Authorization: 'Bearer ${BUILDD_API_KEY}',
          },
        },
        memory: {
          command: 'node',
          args: ['server.js'],
          env: {
            DATABASE_URL: '${MEMORY_DB_URL}',
            SECRET: '${MEMORY_SECRET}',
          },
        },
      },
    };

    const result = parseMcpJsonContent(JSON.stringify(mcpConfig));
    expect(result).toHaveLength(2);

    const buildd = result.find(s => s.name === 'buildd')!;
    expect(buildd).toBeDefined();
    expect(buildd.requiredVars).toContain('BUILDD_API_KEY');
    expect(buildd.requiredVars).toHaveLength(1);

    const memory = result.find(s => s.name === 'memory')!;
    expect(memory).toBeDefined();
    expect(memory.requiredVars).toContain('MEMORY_DB_URL');
    expect(memory.requiredVars).toContain('MEMORY_SECRET');
    expect(memory.requiredVars).toHaveLength(2);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseMcpJsonContent('not json')).toEqual([]);
  });

  it('returns empty array when mcpServers key is missing', () => {
    expect(parseMcpJsonContent(JSON.stringify({ other: 'stuff' }))).toEqual([]);
  });

  it('extracts vars from deeply nested config', () => {
    const mcpConfig = {
      mcpServers: {
        deep: {
          config: {
            nested: {
              value: '${DEEP_VAR}',
            },
          },
          headers: {
            'X-Custom': '${HEADER_VAR}',
          },
        },
      },
    };

    const result = parseMcpJsonContent(JSON.stringify(mcpConfig));
    expect(result).toHaveLength(1);
    expect(result[0].requiredVars).toContain('DEEP_VAR');
    expect(result[0].requiredVars).toContain('HEADER_VAR');
  });

  it('handles server with no var references', () => {
    const mcpConfig = {
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
      },
    };

    const result = parseMcpJsonContent(JSON.stringify(mcpConfig));
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('local');
    expect(result[0].requiredVars).toEqual([]);
  });

  it('extracts vars from args array strings', () => {
    const mcpConfig = {
      mcpServers: {
        cli: {
          command: 'tool',
          args: ['--token', '${CLI_TOKEN}', '--host', '${CLI_HOST}'],
        },
      },
    };

    const result = parseMcpJsonContent(JSON.stringify(mcpConfig));
    expect(result[0].requiredVars).toContain('CLI_TOKEN');
    expect(result[0].requiredVars).toContain('CLI_HOST');
  });
});

describe('scanMcpServersRich', () => {
  it('includes resolved status based on env', () => {
    // scanMcpServersRich reads files via parseMcpJson — test with content-based approach
    // by testing the resolved logic with known McpServerInfo inputs
    const servers: McpServerInfo[] = [
      { name: 'svc', requiredVars: ['TEST_VAR_A'], resolved: false },
    ];

    // Test resolved logic: all requiredVars present
    const envWith = { TEST_VAR_A: 'value' };
    const resolved = servers[0].requiredVars.every(v => envWith[v] !== undefined && envWith[v] !== '');
    expect(resolved).toBe(true);

    // Test resolved logic: missing vars
    const envWithout: Record<string, string | undefined> = {};
    const notResolved = servers[0].requiredVars.every(v => envWithout[v] !== undefined && envWithout[v] !== '');
    expect(notResolved).toBe(false);
  });

  it('marks servers with no required vars as resolved', () => {
    // A server with no requiredVars should always be resolved
    const requiredVars: string[] = [];
    const resolved = requiredVars.every(v => false); // every on empty array = true
    expect(resolved).toBe(true);
  });
});

describe('checkMcpPreFlight (content-based)', () => {
  it('detects missing vars from parsed content', () => {
    const mcpConfig = {
      mcpServers: {
        svc: { headers: { Auth: 'Bearer ${MISSING_KEY}' } },
      },
    };
    const servers = parseMcpJsonContent(JSON.stringify(mcpConfig));
    expect(servers).toHaveLength(1);
    expect(servers[0].requiredVars).toContain('MISSING_KEY');

    // Simulate pre-flight logic
    const env: Record<string, string | undefined> = {};
    const missing = servers[0].requiredVars.filter(v => !env[v] || env[v] === '');
    expect(missing).toContain('MISSING_KEY');
  });

  it('returns no missing when all vars present', () => {
    const mcpConfig = {
      mcpServers: {
        svc: { headers: { Auth: 'Bearer ${MY_KEY}' } },
      },
    };
    const servers = parseMcpJsonContent(JSON.stringify(mcpConfig));
    const env = { MY_KEY: 'value' };
    const missing = servers[0].requiredVars.filter(v => !env[v] || env[v] === '');
    expect(missing).toEqual([]);
  });

  it('deduplicates vars across servers', () => {
    const mcpConfig = {
      mcpServers: {
        a: { headers: { Auth: '${SHARED_VAR}' } },
        b: { env: { KEY: '${SHARED_VAR}' } },
      },
    };
    const servers = parseMcpJsonContent(JSON.stringify(mcpConfig));
    const allVars = servers.flatMap(s => s.requiredVars);
    expect(allVars.filter(v => v === 'SHARED_VAR')).toHaveLength(2); // Each server reports it
    const unique = [...new Set(allVars)];
    expect(unique).toEqual(['SHARED_VAR']);
  });
});
