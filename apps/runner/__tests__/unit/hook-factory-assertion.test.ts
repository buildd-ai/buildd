/**
 * Unit tests for the assertion-mode 401 re-auth path in createMcpFailureHook
 * (spec §F.2).
 *
 * When a PostToolUseFailure event carries a 401-like error for an MCP tool that
 * belongs to an assertion-mode connector, the hook must:
 *  - silently re-mint + re-exchange
 *  - update the in-memory mcpServersRef headers with the new token
 *  - NOT emit connector:auth_expired or paused_connector_auth
 *
 * Run: bun test apps/runner/__tests__/unit/hook-factory-assertion.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Module mocks (must be declared before any imports) ──────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  getWorker: () => null,
}));

// Controllable assertion-exchange mock
let exchangeResult: { accessToken: string; expiresAt: number } = {
  accessToken: 'refreshed-tok',
  expiresAt: Date.now() + 600_000,
};
let exchangeThrows = false;
const mockExchange = mock(async () => {
  if (exchangeThrows) throw new Error('exchange failed');
  return exchangeResult;
});
const mockIsAuthError = mock((s: string) => /401|unauthorized/i.test(s));

mock.module('../../src/assertion-exchange.js', () => ({
  exchangeAssertionConnector: mockExchange,
  isAuthError: mockIsAuthError,
}));

import { HookFactory } from '../../src/hook-factory';
import type { LocalWorker } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w1',
    taskId: 't1',
    taskTitle: 'test',
    workspaceId: 'ws1',
    workspaceName: 'test',
    branch: 'main',
    status: 'working',
    hasNewActivity: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    milestones: [],
    currentAction: '',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    subagentTasks: [],
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    pendingMcpCalls: [{ server: 'cue', tool: 'search', ts: Date.now(), ok: true }],
    assertionConnectors: [
      { name: 'cue', mintApiUrl: 'https://buildd.dev/api/connectors/c1/assertion', tokenEndpoint: 'https://cue.example.com/token' },
    ],
    assertionTokenCache: new Map(),
    ...overrides,
  } as unknown as LocalWorker;
}

function makeFactory(): HookFactory {
  return new HookFactory({
    config: {},
    buildd: {} as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  });
}

function makeFailureInput(toolName: string, error: string) {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    error,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createMcpFailureHook — assertion re-auth (§F.2)', () => {
  beforeEach(() => {
    exchangeThrows = false;
    exchangeResult = { accessToken: 'refreshed-tok', expiresAt: Date.now() + 600_000 };
    mockExchange.mockClear();
  });

  test('401 on assertion connector → re-exchanges and updates mcpServersRef headers', async () => {
    const worker = makeWorker();
    const mcpServersRef: Record<string, any> = {
      cue: { type: 'http', url: 'https://mcp.cue.example.com', headers: { Authorization: 'Bearer old-tok' } },
    };

    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, mcpServersRef, 'bld_key');
    await hook(makeFailureInput('mcp__cue__search', 'HTTP 401 Unauthorized') as any);

    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockExchange).toHaveBeenCalledWith(
      { name: 'cue', mintApiUrl: 'https://buildd.dev/api/connectors/c1/assertion', tokenEndpoint: 'https://cue.example.com/token' },
      'bld_key',
      'w1',
      't1',
    );
    // Headers must be updated in-place
    expect(mcpServersRef.cue.headers).toEqual({ Authorization: 'Bearer refreshed-tok' });
    // Cache must be updated
    expect(worker.assertionTokenCache!.get('cue')?.accessToken).toBe('refreshed-tok');
  });

  test('401 on assertion connector → exchange fails → logs error, does not throw', async () => {
    exchangeThrows = true;
    const worker = makeWorker();
    const mcpServersRef: Record<string, any> = {
      cue: { type: 'http', url: 'https://mcp.cue.example.com', headers: { Authorization: 'Bearer old-tok' } },
    };

    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, mcpServersRef, 'bld_key');

    // Must not throw even when exchange fails
    await expect(
      hook(makeFailureInput('mcp__cue__search', 'HTTP 401 Unauthorized') as any),
    ).resolves.toEqual({});

    // Old token remains unchanged
    expect(mcpServersRef.cue.headers).toEqual({ Authorization: 'Bearer old-tok' });
  });

  test('401 on non-assertion connector → no exchange attempted', async () => {
    const worker = makeWorker({
      assertionConnectors: [], // no assertion connectors registered
    });
    const mcpServersRef: Record<string, any> = {
      linear: { type: 'http', url: 'https://mcp.linear.app', headers: { Authorization: 'Bearer static' } },
    };

    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, mcpServersRef, 'bld_key');
    await hook(makeFailureInput('mcp__linear__search', 'HTTP 401 Unauthorized') as any);

    expect(mockExchange).not.toHaveBeenCalled();
    expect(mcpServersRef.linear.headers).toEqual({ Authorization: 'Bearer static' });
  });

  test('non-auth failure on assertion connector → no re-exchange', async () => {
    const worker = makeWorker();
    const mcpServersRef: Record<string, any> = {
      cue: { type: 'http', url: 'https://mcp.cue.example.com', headers: { Authorization: 'Bearer tok' } },
    };

    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, mcpServersRef, 'bld_key');
    await hook(makeFailureInput('mcp__cue__search', 'Internal Server Error 500') as any);

    expect(mockExchange).not.toHaveBeenCalled();
    expect(mcpServersRef.cue.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  test('marks matching pending MCP call as failed on any failure', async () => {
    const worker = makeWorker({
      assertionConnectors: [],
      pendingMcpCalls: [{ server: 'cue', tool: 'search', ts: Date.now(), ok: true }],
    });

    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, {}, undefined);
    await hook(makeFailureInput('mcp__cue__search', 'connection refused') as any);

    expect(worker.pendingMcpCalls![0].ok).toBe(false);
  });

  test('hook is a no-op for non-PostToolUseFailure events', async () => {
    const worker = makeWorker();
    const factory = makeFactory();
    const hook = factory.createMcpFailureHook(worker, {}, 'bld_key');

    const result = await hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__cue__search' } as any);
    expect(result).toEqual({});
    expect(mockExchange).not.toHaveBeenCalled();
  });
});
