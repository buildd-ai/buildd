/**
 * Gateway connectors on the runner: how Claude and Codex mount them, and how
 * a restarted or resumed worker gets them back.
 *
 * A gateway entry carries no provider credential, only a path on the runner's
 * own buildd server. The runtime mounts it with the agent's own buildd token,
 * minted fresh for every session, so a resumed session never reuses an old
 * token, and the server re-checks every call (no stale grant survives a resume).
 *
 * Writes only under its own BUILDD_HOME; never mocks 'fs'.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LocalWorker } from '../../src/types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'buildd-gateway-mount-'));
process.env.BUILDD_HOME = TEST_HOME;

const { buildMcpServerEntries } = await import('../../src/workers');
const { buildCodexMcpServers, gatewayConnectorsOnly, gatewayConnectorUrl } = await import('../../src/mcp-json');
let store: typeof import('../../src/worker-store');

const CONN = '0b0b0b0b-1111-4222-8333-444455556666';
const ORIGIN = 'https://buildd.example';
const GATEWAY = { id: CONN, name: 'axiom', transport: 'http' as const, gateway: true as const, gatewayPath: `/api/mcp/c/${CONN}` };
const DIRECT = { id: 'c2', name: 'linear', transport: 'http' as const, url: 'https://mcp.linear.example/mcp', headers: { Authorization: 'Bearer direct-provider-token' } };
const STDIO = { name: 'local', transport: 'stdio' as const, command: 'npx', env: { API_KEY: 'stdio-secret' } };

beforeAll(async () => {
  store = await import('../../src/worker-store');
  store.__resetWorkerStoreRoot();
});
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

describe('Claude: buildMcpServerEntries', () => {
  test('mounts a gateway connector on the buildd origin with the agent token', () => {
    const entries = buildMcpServerEntries([GATEWAY, DIRECT] as any, { origin: ORIGIN, token: 'bldt_session-1', workerId: 'w-1' });
    expect(entries.axiom).toEqual({
      type: 'http',
      url: `${ORIGIN}/api/mcp/c/${CONN}?worker=w-1`,
      headers: { Authorization: 'Bearer bldt_session-1' },
    });
    expect(entries.linear).toMatchObject({ type: 'http', url: DIRECT.url });
  });

  test('skips a gateway connector with no agent token (never mounts it unauthenticated)', () => {
    expect(buildMcpServerEntries([GATEWAY] as any, { origin: ORIGIN, token: '', workerId: 'w-1' })).toEqual({});
    expect(buildMcpServerEntries([GATEWAY] as any)).toEqual({});
  });

  test('refuses a gateway path that is not a connector gateway path', () => {
    const bad = { ...GATEWAY, gatewayPath: 'https://evil.example/steal' };
    expect(buildMcpServerEntries([bad] as any, { origin: ORIGIN, token: 't', workerId: 'w' })).toEqual({});
    expect(gatewayConnectorUrl(ORIGIN, '/api/mcp/../../x', 'w')).toBeNull();
  });
});

describe('Codex: buildCodexMcpServers', () => {
  test('mounts a gateway connector via a bearer env var holding the agent token, not a provider token', () => {
    const out = buildCodexMcpServers({
      mcpJson: undefined,
      connectors: [GATEWAY, DIRECT] as any,
      env: {},
      builddCredential: { origin: ORIGIN, token: 'bldt_session-1' },
      workerId: 'w-1',
    });
    const axiom = out.servers.find(s => s.name === 'axiom')!;
    expect(axiom.url).toBe(`${ORIGIN}/api/mcp/c/${CONN}?worker=w-1`);
    expect(out.bearerEnv[axiom.bearerTokenEnvVar]).toBe('bldt_session-1');
    expect(out.servers.map(s => s.name)).toEqual(['axiom', 'linear']);
  });

  test('warns and skips without a worker id or token', () => {
    const out = buildCodexMcpServers({ mcpJson: undefined, connectors: [GATEWAY] as any, env: {}, builddCredential: { origin: ORIGIN, token: 't' } });
    expect(out.servers).toEqual([]);
    expect(out.warnings[0]).toContain('gateway connector "axiom" not mounted');
  });
});

describe('restart and resume: gateway connectors persist, credentials never do', () => {
  function worker(over: Partial<LocalWorker> = {}): LocalWorker {
    const now = Date.now();
    return {
      id: 'w-restart', taskId: 't-1', taskTitle: 'x', workspaceId: 'ws', workspaceName: 'ws', branch: 'b',
      status: 'waiting', startedAt: now, lastActivity: now, messages: [], milestones: [], toolCalls: [], commits: [], output: [],
      hasNewActivity: false, currentAction: '', subagentTasks: [], checkpoints: [], checkpointEvents: new Set(),
      phaseText: null, phaseStart: null, phaseToolCount: 0, phaseTools: [],
      ...over,
    } as LocalWorker;
  }

  test('only gateway entries reach disk; direct headers and stdio env never do', () => {
    const w = worker();
    (w as any).mcpConnectors = [GATEWAY, DIRECT, STDIO];
    store.saveWorker(w);
    const raw = readFileSync(join(TEST_HOME, 'workers', 'w-restart.json'), 'utf8');
    expect(raw).not.toContain('direct-provider-token');
    expect(raw).not.toContain('stdio-secret');
    expect(JSON.parse(raw).mcpConnectors).toEqual([GATEWAY]);
  });

  test('a restored worker (Claude or Codex) re-mounts with a freshly minted token', () => {
    const restored = store.loadWorker('w-restart')!;
    expect((restored as any).mcpConnectors).toEqual([GATEWAY]);
    const claude = buildMcpServerEntries((restored as any).mcpConnectors, { origin: ORIGIN, token: 'bldt_session-2', workerId: restored.id });
    expect(claude.axiom.type === 'http' && claude.axiom.headers?.Authorization).toBe('Bearer bldt_session-2');
    const codex = buildCodexMcpServers({ mcpJson: undefined, connectors: (restored as any).mcpConnectors, env: {}, builddCredential: { origin: ORIGIN, token: 'bldt_session-2' }, workerId: restored.id });
    expect(Object.values(codex.bearerEnv)).toEqual(['bldt_session-2']);
    const all = store.loadAllWorkers().find(x => x.id === 'w-restart')!;
    expect((all as any).mcpConnectors).toEqual([GATEWAY]);
  });

  test('a tampered record cannot smuggle a credential back in', () => {
    expect(gatewayConnectorsOnly([{ ...GATEWAY, headers: { Authorization: 'Bearer x' }, url: 'https://evil' }])).toEqual([GATEWAY]);
    expect(gatewayConnectorsOnly([{ ...DIRECT, gateway: true }])).toEqual([]);
  });
});
