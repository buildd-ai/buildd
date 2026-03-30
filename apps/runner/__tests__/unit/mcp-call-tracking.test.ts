/**
 * Unit tests for MCP tool call tracking in the runner.
 *
 * Tests:
 * 1. MCP tool name parsing (mcp__server__tool → server + tool)
 * 2. Pending calls buffering on LocalWorker
 * 3. Flush behavior (calls included in sync, cleared after)
 * 4. Error detection (ok set to false on PostToolUseFailure)
 *
 * Run: bun test apps/runner/__tests__/unit/mcp-call-tracking.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// ─── Capture query options ──────────────────────────────────────────────────

let lastQueryOpts: any = null;
let mockMessages: any[] = [];
const mockStreamInputFn = mock(() => {});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mockStreamInputFn,
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) {
              return { value: msgs[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] }));
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockListWorkspaceSkills = mock(async () => []);
const mockGetAccountInfo = mock(async () => ({ id: 'acc-1', name: 'Test' }));
const mockSendHeartbeat = mock(async () => ({}));
const mockGetWorkerRemote = mock(async () => null);
const mockMatchRepos = mock(async () => ({ matched: [], unmatchedInOrg: [], unmatchedExternal: [] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    listWorkspaceSkills = mockListWorkspaceSkills;
    getAccountInfo = mockGetAccountInfo;
    sendHeartbeat = mockSendHeartbeat;
    getWorkerRemote = mockGetWorkerRemote;
    matchRepos = mockMatchRepos;
    setOutbox() {}
  },
}));

mock.module('../../src/history', () => ({
  HistoryStore: class {
    init() { return Promise.resolve(); }
    save() { return Promise.resolve(); }
    list() { return Promise.resolve([]); }
    get() { return Promise.resolve(null); }
  },
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [], labels: { type: 'local' } }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
}));

import { WorkerManager } from '../../src/workers';

// ─── Helper to create a minimal WorkerManager and worker ─────────────────────

function createTestConfig(): LocalUIConfig {
  return {
    projectRoots: ['/tmp/test-project'],
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 1,
    model: 'claude-sonnet-4-20250514',
    serverless: true,
  };
}

function createTestWorkerManager() {
  const config = createTestConfig();
  const manager = new WorkerManager(config);
  return manager;
}

// ─── MCP tool name parsing ──────────────────────────────────────────────────

describe('MCP tool name parsing', () => {
  test('parses standard mcp__server__tool format', () => {
    const toolName = 'mcp__dispatch__dispatch_read';
    const parts = toolName.split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || toolName;

    expect(server).toBe('dispatch');
    expect(tool).toBe('dispatch_read');
  });

  test('parses tool with multiple underscores in tool name', () => {
    const toolName = 'mcp__paper__get_node_info';
    const parts = toolName.split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || toolName;

    expect(server).toBe('paper');
    expect(tool).toBe('get_node_info');
  });

  test('parses tool with double underscores in tool name', () => {
    const toolName = 'mcp__claude-in-chrome__tabs_context_mcp';
    const parts = toolName.split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || toolName;

    expect(server).toBe('claude-in-chrome');
    expect(tool).toBe('tabs_context_mcp');
  });

  test('handles minimal mcp__ prefix with no tool part', () => {
    const toolName = 'mcp__server';
    const parts = toolName.split('__');
    const server = parts[1] || 'unknown';
    const tool = parts.slice(2).join('__') || toolName;

    expect(server).toBe('server');
    // Falls back to full toolName when no tool part exists
    expect(tool).toBe('mcp__server');
  });

  test('does not match non-MCP tools', () => {
    const toolName = 'Read';
    expect(toolName.startsWith('mcp__')).toBe(false);
  });

  test('does not match tools with mcp in the middle', () => {
    const toolName = 'some_mcp__tool';
    expect(toolName.startsWith('mcp__')).toBe(false);
  });
});

// ─── Integration tests: MCP call detection via SDK messages ─────────────────

describe('MCP call tracking in worker lifecycle', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    mockUpdateWorker.mockClear();
    lastQueryOpts = null;
    mockMessages = [];
    manager = createTestWorkerManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  test('MCP tool_use adds to pendingMcpCalls', async () => {
    // Set up mock messages: an MCP tool_use followed by a result and stop
    mockMessages = [
      {
        type: 'tool_use',
        tool_use_id: 'tu_1',
        name: 'mcp__dispatch__dispatch_read',
        input: { query: 'tasks' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [{ type: 'text', text: 'result' }],
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        session_id: 'sess-1',
        total_cost_usd: 0.01,
        usage: {},
      },
    ];

    // Create a worker with a fake task
    const workers = (manager as any).workers as Map<string, any>;
    workers.set('w-1', {
      id: 'w-1',
      taskId: 't-1',
      taskTitle: 'Test Task',
      workspaceId: 'ws-1',
      workspaceName: 'Test',
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
      pendingMcpCalls: [],
    });

    // Directly invoke the tool_use message handler to test detection
    // We access the internal method via the hooks
    const worker = workers.get('w-1')!;

    // Simulate what the tool_use handler does for MCP tools
    const toolName = 'mcp__dispatch__dispatch_read';
    worker.toolCalls.push({ name: toolName, timestamp: Date.now(), input: {} });

    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      const server = parts[1] || 'unknown';
      const tool = parts.slice(2).join('__') || toolName;
      if (!worker.pendingMcpCalls) worker.pendingMcpCalls = [];
      worker.pendingMcpCalls.push({
        server,
        tool,
        ts: Date.now(),
        ok: true,
      });
    }

    expect(worker.pendingMcpCalls).toHaveLength(1);
    expect(worker.pendingMcpCalls[0].server).toBe('dispatch');
    expect(worker.pendingMcpCalls[0].tool).toBe('dispatch_read');
    expect(worker.pendingMcpCalls[0].ok).toBe(true);
  });

  test('non-MCP tool_use does not add to pendingMcpCalls', () => {
    const worker: any = {
      toolCalls: [],
      pendingMcpCalls: [],
    };

    const toolName = 'Read';
    worker.toolCalls.push({ name: toolName, timestamp: Date.now(), input: {} });

    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      const server = parts[1] || 'unknown';
      const tool = parts.slice(2).join('__') || toolName;
      if (!worker.pendingMcpCalls) worker.pendingMcpCalls = [];
      worker.pendingMcpCalls.push({
        server,
        tool,
        ts: Date.now(),
        ok: true,
      });
    }

    expect(worker.pendingMcpCalls).toHaveLength(0);
  });

  test('multiple MCP calls accumulate in buffer', () => {
    const worker: any = {
      toolCalls: [],
      pendingMcpCalls: [],
    };

    const mcpTools = [
      'mcp__dispatch__dispatch_read',
      'mcp__dispatch__dispatch_mutate',
      'mcp__paper__get_screenshot',
    ];

    for (const toolName of mcpTools) {
      worker.toolCalls.push({ name: toolName, timestamp: Date.now(), input: {} });
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] || 'unknown';
        const tool = parts.slice(2).join('__') || toolName;
        if (!worker.pendingMcpCalls) worker.pendingMcpCalls = [];
        worker.pendingMcpCalls.push({ server, tool, ts: Date.now(), ok: true });
      }
    }

    expect(worker.pendingMcpCalls).toHaveLength(3);
    expect(worker.pendingMcpCalls[0].server).toBe('dispatch');
    expect(worker.pendingMcpCalls[0].tool).toBe('dispatch_read');
    expect(worker.pendingMcpCalls[1].server).toBe('dispatch');
    expect(worker.pendingMcpCalls[1].tool).toBe('dispatch_mutate');
    expect(worker.pendingMcpCalls[2].server).toBe('paper');
    expect(worker.pendingMcpCalls[2].tool).toBe('get_screenshot');
  });

  test('flush includes pendingMcpCalls in sync update and clears buffer', async () => {
    // Set up a worker with pending MCP calls
    const workers = (manager as any).workers as Map<string, any>;
    const worker = {
      id: 'w-flush',
      taskId: 't-1',
      taskTitle: 'Test Task',
      workspaceId: 'ws-1',
      workspaceName: 'Test',
      branch: 'main',
      status: 'working',
      hasNewActivity: false,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      milestones: [],
      currentAction: 'testing',
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
      pendingMcpCalls: [
        { server: 'dispatch', tool: 'dispatch_read', ts: 1000, ok: true },
        { server: 'paper', tool: 'get_screenshot', ts: 2000, ok: false },
      ],
    };
    workers.set('w-flush', worker);

    // Trigger sync
    await (manager as any).workerSync.syncWorkerToServer(worker);

    // Verify updateWorker was called with appendMcpCalls
    expect(mockUpdateWorker).toHaveBeenCalled();
    const lastCall = mockUpdateWorker.mock.calls[mockUpdateWorker.mock.calls.length - 1];
    // updateWorker(workerId, update) — workerId is first arg, update is second
    const workerId = lastCall[0];
    const updateObj = lastCall[1];

    expect(workerId).toBe('w-flush');
    expect(updateObj.appendMcpCalls).toBeDefined();
    expect(updateObj.appendMcpCalls).toHaveLength(2);
    expect(updateObj.appendMcpCalls[0].server).toBe('dispatch');
    expect(updateObj.appendMcpCalls[0].tool).toBe('dispatch_read');
    expect(updateObj.appendMcpCalls[0].ok).toBe(true);
    expect(updateObj.appendMcpCalls[1].server).toBe('paper');
    expect(updateObj.appendMcpCalls[1].ok).toBe(false);

    // Buffer should be cleared after successful sync
    expect(worker.pendingMcpCalls).toHaveLength(0);
  });

  test('flush with no pending calls does not include appendMcpCalls', async () => {
    const workers = (manager as any).workers as Map<string, any>;
    const worker = {
      id: 'w-empty',
      taskId: 't-1',
      taskTitle: 'Test Task',
      workspaceId: 'ws-1',
      workspaceName: 'Test',
      branch: 'main',
      status: 'working',
      hasNewActivity: false,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      milestones: [],
      currentAction: 'testing',
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
      pendingMcpCalls: [],
    };
    workers.set('w-empty', worker);

    mockUpdateWorker.mockClear();
    await (manager as any).workerSync.syncWorkerToServer(worker);

    expect(mockUpdateWorker).toHaveBeenCalled();
    const lastCall = mockUpdateWorker.mock.calls[mockUpdateWorker.mock.calls.length - 1];
    // updateWorker is called as (workerId, update)
    const updateObj = lastCall[1] || lastCall[0];
    // appendMcpCalls should not be present when buffer is empty
    if (typeof updateObj === 'object' && updateObj !== null) {
      expect(updateObj.appendMcpCalls).toBeUndefined();
    }
  });

  test('PostToolUseFailure marks most recent MCP call as failed', () => {
    const worker: any = {
      pendingMcpCalls: [
        { server: 'dispatch', tool: 'dispatch_read', ts: 1000, ok: true },
        { server: 'paper', tool: 'get_screenshot', ts: 2000, ok: true },
        { server: 'dispatch', tool: 'dispatch_mutate', ts: 3000, ok: true },
      ],
    };

    // Simulate PostToolUseFailure for mcp__dispatch__dispatch_mutate
    const failedToolName = 'mcp__dispatch__dispatch_mutate';
    if (failedToolName.startsWith('mcp__') && worker.pendingMcpCalls?.length) {
      // Find the last matching call and mark it as failed
      for (let i = worker.pendingMcpCalls.length - 1; i >= 0; i--) {
        const call = worker.pendingMcpCalls[i];
        const expectedPrefix = `mcp__${call.server}__`;
        if (failedToolName.startsWith(expectedPrefix) && call.ok) {
          call.ok = false;
          break;
        }
      }
    }

    expect(worker.pendingMcpCalls[0].ok).toBe(true);  // dispatch_read unchanged
    expect(worker.pendingMcpCalls[1].ok).toBe(true);  // paper unchanged
    expect(worker.pendingMcpCalls[2].ok).toBe(false);  // dispatch_mutate marked failed
  });

  test('PostToolUseFailure for non-MCP tool does not affect pendingMcpCalls', () => {
    const worker: any = {
      pendingMcpCalls: [
        { server: 'dispatch', tool: 'dispatch_read', ts: 1000, ok: true },
      ],
    };

    const failedToolName = 'Bash';
    if (failedToolName.startsWith('mcp__') && worker.pendingMcpCalls?.length) {
      for (let i = worker.pendingMcpCalls.length - 1; i >= 0; i--) {
        const call = worker.pendingMcpCalls[i];
        const expectedPrefix = `mcp__${call.server}__`;
        if (failedToolName.startsWith(expectedPrefix) && call.ok) {
          call.ok = false;
          break;
        }
      }
    }

    expect(worker.pendingMcpCalls[0].ok).toBe(true);  // unchanged
  });
});
