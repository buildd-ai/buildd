/**
 * The runner's own buildd key stays out of what an agent session can see.
 *
 * The agent's buildd access is its per-task token (agent-task-token.ts). These
 * cover the other channels a runner credential could reach the session through:
 * `${BUILDD_API_KEY}` expansion in a .mcp.json (resolved headers go on the
 * Claude CLI argv; Codex bearer tokens go into the agent env), role env, and
 * the human's ~/.claude.json that `buildd login` writes.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/runner-key-agent-exposure.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveMcpJsonHttpServers,
  buildCodexMcpServers,
  describeSkippedMcpServer,
  urlOrigin,
} from '../../src/mcp-json';
import { withoutRunnerKeyValues } from '../../src/runner-key-guard';
import { refreshBuilddMcpEntries } from '../../src/claude-json-mcp';

const RUNNER_KEY = 'bld_runner_key_never_for_agents';
const TASK_TOKEN = 'bldt_task_token_for_this_session';
const CRED = { origin: 'https://buildd.test', token: TASK_TOKEN };

const mcpJson = {
  mcpServers: {
    // Another name for buildd itself, on the runner's buildd origin.
    'buildd-alt': { type: 'http', url: 'https://buildd.test/api/mcp?x=1', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } },
    // A third-party server asking for the buildd key.
    thirdparty: { type: 'http', url: 'https://other.test/mcp', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } },
    // The ref in a URL is never expanded, even for buildd's own origin.
    inurl: { type: 'http', url: 'https://buildd.test/mcp?key=${BUILDD_API_KEY}' },
    // A look-alike host is not the buildd origin.
    lookalike: { type: 'http', url: 'https://buildd.test.evil.test/mcp', headers: { Authorization: 'Bearer ${BUILDD_API_KEY}' } },
    // A server using its own secret is unaffected.
    own: { type: 'http', url: 'https://other.test/mcp2', headers: { Authorization: 'Bearer ${OWN_TOKEN}' } },
  },
};
// The env as it used to be built: the runner key sat in it.
const env = { BUILDD_API_KEY: RUNNER_KEY, OWN_TOKEN: 'own-secret' };

describe('${BUILDD_API_KEY} in .mcp.json (Claude path)', () => {
  const { servers, skipped } = resolveMcpJsonHttpServers(mcpJson, env, { requireHttpType: true, builddCredential: CRED });

  test('a server on the buildd origin gets the agent credential, not the runner key', () => {
    expect(servers.find(s => s.name === 'buildd-alt')?.headers).toEqual({ Authorization: `Bearer ${TASK_TOKEN}` });
  });

  test('a server anywhere else is refused, naming the host', () => {
    expect(servers.map(s => s.name)).not.toContain('thirdparty');
    expect(skipped).toContainEqual({
      name: 'thirdparty',
      unresolved: ['BUILDD_API_KEY'],
      builddCredentialRefused: { host: 'other.test', where: 'foreign-host' },
    });
    expect(servers.map(s => s.name)).not.toContain('lookalike');
  });

  test('a URL carrying the ref is refused', () => {
    expect(servers.map(s => s.name)).not.toContain('inurl');
    expect(skipped.find(s => s.name === 'inurl')?.builddCredentialRefused?.where).toBe('url');
  });

  test('other secrets still expand for any host', () => {
    expect(servers.find(s => s.name === 'own')?.headers).toEqual({ Authorization: 'Bearer own-secret' });
  });

  test('the runner key appears nowhere in the result', () => {
    expect(JSON.stringify({ servers, skipped })).not.toContain(RUNNER_KEY);
  });

  test('the warning names the server and host, never a value', () => {
    const line = describeSkippedMcpServer(skipped.find(s => s.name === 'thirdparty')!);
    expect(line).toContain('"thirdparty"');
    expect(line).toContain('other.test');
    expect(line).not.toContain(RUNNER_KEY);
    expect(line).not.toContain(TASK_TOKEN);
  });

  test('no agent credential (empty token) refuses rather than mounting a bare Bearer', () => {
    const r = resolveMcpJsonHttpServers(mcpJson, env, { builddCredential: { origin: CRED.origin, token: '' } });
    expect(r.servers.map(s => s.name)).not.toContain('buildd-alt');
    expect(JSON.stringify(r)).not.toContain(RUNNER_KEY);
  });
});

describe('${BUILDD_API_KEY} in .mcp.json (Codex path, tokens land in the agent env)', () => {
  const r = buildCodexMcpServers({ mcpJson, connectors: [], env, builddCredential: CRED });

  test('no agent env value is the runner key', () => {
    expect(Object.values(r.bearerEnv)).not.toContain(RUNNER_KEY);
    expect(JSON.stringify(r)).not.toContain(RUNNER_KEY);
  });

  test('the buildd-origin server carries the agent credential', () => {
    expect(r.bearerEnv.MCP_BEARER_BUILDD_ALT).toBe(TASK_TOKEN);
    expect(r.servers.map(s => s.name)).toEqual(['buildd-alt', 'own']);
  });

  test('the refusal is one warning naming the host', () => {
    const w = r.warnings.filter(x => x.includes('"thirdparty"'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('other.test');
  });
});

describe('urlOrigin', () => {
  test('origin of a url, null when unparseable', () => {
    expect(urlOrigin('https://buildd.test/api/mcp')).toBe('https://buildd.test');
    expect(urlOrigin('not a url')).toBeNull();
  });
});

describe('withoutRunnerKeyValues (role env)', () => {
  test('drops any entry equal to the runner key, reporting the name only', () => {
    const r = withoutRunnerKeyValues({ A: 'a', ROLE_KEY: RUNNER_KEY, BUILDD_API_KEY: RUNNER_KEY }, RUNNER_KEY);
    expect(r.env).toEqual({ A: 'a' });
    expect(r.dropped).toEqual(['ROLE_KEY', 'BUILDD_API_KEY']);
  });

  test('no runner key: unchanged', () => {
    expect(withoutRunnerKeyValues({ A: 'a' }, '')).toEqual({ env: { A: 'a' }, dropped: [] });
  });
});

describe('WorkerManager role env never carries the runner key', () => {
  const LABEL = 'RUNNER_KEY_EXPOSURE_TEST_LABEL';
  afterEach(() => { delete process.env[LABEL]; });

  test('a role mapping a label that resolves to the runner key gets nothing for it', async () => {
    process.env[LABEL] = RUNNER_KEY;
    const { WorkerManager } = await import('../../src/workers');
    const resolve = (WorkerManager.prototype as any).resolveWorkerRoleEnv;
    const out = await resolve.call({ config: { apiKey: RUNNER_KEY } }, {
      roleBundle: { envMapping: { AGENT_VAR: LABEL } },
      roleEnvSecrets: { OTHER: 'fine', LEAKED: RUNNER_KEY },
    });
    expect(out.resolved).toEqual({ OTHER: 'fine' });
    expect(out.missing).toEqual(expect.arrayContaining(['AGENT_VAR', 'LEAKED']));
  });
});

describe('workers.ts wiring', () => {
  // startSession is too large to drive here; pin the two facts the unit tests
  // above depend on: the expansion env has no runner key, and both backends'
  // .mcp.json expansion goes through the origin-scoped buildd credential.
  const src = readFileSync(join(import.meta.dir, '../../src/workers.ts'), 'utf-8');

  test('the header expansion env does not carry the runner key', () => {
    const block = src.match(/const headerExpansionEnv: Record<string, string> = \{([\s\S]*?)\};/);
    expect(block).not.toBeNull();
    expect(block![1]).not.toContain('apiKey');
    expect(block![1]).not.toContain('BUILDD_API_KEY');
  });

  test('both .mcp.json expansions pass the agent buildd credential', () => {
    expect(src.match(/builddCredential: builddMcpCredential/g)?.length).toBe(2);
    expect(src).toMatch(/token: agentBuilddToken \?\? ''/);
  });
});

describe('refreshBuilddMcpEntries (buildd login keeps the install scope)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const key = (k: string) => ({ type: 'http', url: 'https://old.test/api/mcp', headers: { Authorization: `Bearer ${k}` } });

  test('re-keys existing key entries (user-wide and per folder), never adds a user-wide one, leaves OAuth entries alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-json-'));
    const p = join(dir, '.claude.json');
    const oauth = { type: 'http', url: 'https://old.test/api/mcp-oauth/ws-1' };
    writeFileSync(p, JSON.stringify({
      theme: 'dark',
      projects: {
        '/code/a': { allowedTools: ['Bash'], mcpServers: { buildd: key('bld_old'), other: { command: 'x' } } },
        '/code/b': { mcpServers: { buildd: oauth } },
        '/code/c': {},
      },
    }));
    expect(refreshBuilddMcpEntries(p, 'bld_new', 'https://buildd.test')).toBe(1);
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    expect(data.mcpServers?.buildd).toBeUndefined();
    expect(data.projects['/code/a'].mcpServers.buildd).toEqual({ type: 'http', url: 'https://buildd.test/api/mcp', headers: { Authorization: 'Bearer bld_new' } });
    expect(data.projects['/code/a'].mcpServers.other).toEqual({ command: 'x' });
    expect(data.projects['/code/a'].allowedTools).toEqual(['Bash']);
    expect(data.projects['/code/b'].mcpServers.buildd).toEqual(oauth);
    expect(data.projects['/code/c']).toEqual({});
    expect(data.theme).toBe('dark');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test('an existing user-wide key entry (from --everywhere) is re-keyed in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-json-'));
    const p = join(dir, '.claude.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { buildd: key('bld_old') } }));
    expect(refreshBuilddMcpEntries(p, 'bld_new', 'https://buildd.test')).toBe(1);
    expect(JSON.parse(readFileSync(p, 'utf-8')).mcpServers.buildd.headers.Authorization).toBe('Bearer bld_new');
  });

  test('no file or no buildd entry: nothing written, 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-json-'));
    const p = join(dir, '.claude.json');
    expect(refreshBuilddMcpEntries(p, 'bld_new', 'https://buildd.test')).toBe(0);
    expect(existsSync(p)).toBe(false);
    writeFileSync(p, '{"mcpServers":{"x":{"command":"y"}}}');
    expect(refreshBuilddMcpEntries(p, 'bld_new', 'https://buildd.test')).toBe(0);
    expect(readFileSync(p, 'utf-8')).toBe('{"mcpServers":{"x":{"command":"y"}}}');
  });
});
