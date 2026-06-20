/**
 * R1 — worker.lastAssistantMessage must be populated for Codex.
 *
 * Codex has no Claude Stop hook (hook-factory.ts:381) — its assistant text
 * arrives only through the channel-2 adapter (mapCodexEventToSdkMessages →
 * handleMessage). Without setting worker.lastAssistantMessage there, the
 * review-loop DONE gate (workers.ts ~1567) and completion summary (~1758) are
 * dead for Codex.
 *
 * Strategy: drive the real handleMessage with the SAME Claude-shaped SDKMessages
 * the Codex adapter produces, then assert the field is populated and the DONE
 * sentinel check the gate uses can observe it.
 *
 * Run: bun test apps/runner/__tests__/unit/codex-last-assistant-message.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock, setDefaultTimeout } from 'bun:test';
import { mapCodexEventToSdkMessages } from '../../src/backends/codex-events';

// WorkerManager construction starts several background intervals; give setup/
// teardown headroom and destroy the manager after each test (mirrors
// worker-manager-state.test.ts). Without the afterEach teardown the intervals
// leak across tests and a CI hook eventually times out.
setDefaultTimeout(15_000);

// ─── Mocks (mirror worker-manager-state.test.ts) ───────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
    claimTask = mock(async () => ({ workers: [] }));
    getWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
    getCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
    searchObservations = mock(async () => []);
    getBatchObservations = mock(async () => []);
    createObservation = mock(async () => ({}));
    listWorkspaces = mock(async () => []);
    sendHeartbeat = mock(async () => ({}));
    runCleanup = mock(async () => ({}));
    searchFeedbackMemories = mock(async () => []);
    getWorkerRemote = mock(async () => null);
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => '/tmp/test-workspace',
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => ['/tmp'],
  }),
}));

mock.module('pusher-js', () => ({
  default: class {
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

mock.module('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: async () => {},
}));

const { WorkerManager } = await import('../../src/workers');

function makeConfig() {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as any;
}

function makeWorker(): any {
  return {
    id: 'w-codex-1',
    taskId: 'task-1',
    taskTitle: 'Test',
    status: 'running',
    output: [],
    toolCalls: [],
    commits: [],
    milestones: [],
    messages: [],
    chatMessages: [],
    subagentTasks: [],
    phaseTools: [],
    phaseToolCount: 0,
  };
}

// handleMessage is a private method; cast to reach it (same pattern as the
// state-machine suite, which drives it indirectly).
function feed(manager: any, worker: any, event: unknown) {
  for (const sdkMsg of mapCodexEventToSdkMessages(event, {})) {
    manager.handleMessage(worker, sdkMsg);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('R1 — Codex agent_message populates worker.lastAssistantMessage', () => {
  let manager: any;
  let worker: any;

  beforeEach(() => {
    manager = new WorkerManager(makeConfig());
    worker = makeWorker();
  });

  afterEach(() => {
    manager?.destroy();
  });

  test('lastAssistantMessage is set from a Codex agent_message item', () => {
    expect(worker.lastAssistantMessage).toBeUndefined();
    feed(manager, worker, {
      type: 'item.completed',
      item: { id: 'a1', type: 'agent_message', text: 'I finished the work.' },
    });
    expect(worker.lastAssistantMessage).toBe('I finished the work.');
  });

  test('the latest agent_message wins (last write)', () => {
    feed(manager, worker, { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'first' } });
    feed(manager, worker, { type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: 'second' } });
    expect(worker.lastAssistantMessage).toBe('second');
  });

  test('the DONE-gate substring check observes a DONE sentinel once emitted', () => {
    // Mirrors workers.ts ~1567: const lastMsg = worker.lastAssistantMessage || '';
    // if (lastMsg.includes('<promise>DONE</promise>')) break;
    feed(manager, worker, {
      type: 'item.completed',
      item: { id: 'a1', type: 'agent_message', text: 'Reviewed everything. <promise>DONE</promise>' },
    });
    const lastMsg = worker.lastAssistantMessage || '';
    expect(lastMsg.includes('<promise>DONE</promise>')).toBe(true);
  });

  test('without a DONE sentinel the gate does not trip', () => {
    feed(manager, worker, {
      type: 'item.completed',
      item: { id: 'a1', type: 'agent_message', text: 'Still working on it.' },
    });
    const lastMsg = worker.lastAssistantMessage || '';
    expect(lastMsg.includes('<promise>DONE</promise>')).toBe(false);
  });
});

describe('Phase 1C — Codex thread.started captured into codexThreadId (R5)', () => {
  let manager: any;

  beforeEach(() => {
    manager = new WorkerManager(makeConfig());
  });

  test('Codex worker: system:init session_id lands in codexThreadId, NOT sessionId', () => {
    const worker = { ...makeWorker(), taskBackend: 'codex' };
    feed(manager, worker, { type: 'thread.started', thread_id: 'thread-xyz' });
    expect(worker.codexThreadId).toBe('thread-xyz');
    expect(worker.sessionId).toBeUndefined();
  });

  test('Claude worker: system:init session_id lands in sessionId, NOT codexThreadId', () => {
    const worker = { ...makeWorker(), taskBackend: 'claude' };
    // The Claude SDK emits system:init directly (no Codex adapter needed).
    manager.handleMessage(worker, { type: 'system', subtype: 'init', session_id: 'claude-sess' });
    expect(worker.sessionId).toBe('claude-sess');
    expect(worker.codexThreadId).toBeUndefined();
  });
});
