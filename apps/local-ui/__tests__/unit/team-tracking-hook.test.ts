/**
 * Unit tests for PostToolUse team tracking hook and team state management.
 *
 * Simulates realistic SDK message sequences where an agent:
 * 1. Creates a team (TeamCreate)
 * 2. Spawns subagents (Task)
 * 3. Sends inter-agent messages (SendMessage)
 * 4. Does actual work (Read, Edit, Bash)
 *
 * Verifies that worker.teamState is populated correctly and
 * milestones are emitted for team events.
 *
 * Run: bun test apps/local-ui/__tests__/unit/team-tracking-hook.test.ts
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
const mockClaimTask = mock(async () => []);
const mockGetWorkspaceConfig = mock(async () => ({ configStatus: 'unconfigured' }));
const mockGetCompactObservations = mock(async () => ({ markdown: '', count: 0 }));
const mockSearchObservations = mock(async () => []);
const mockGetBatchObservations = mock(async () => []);
const mockCreateObservation = mock(async () => ({}));
const mockListWorkspaces = mock(async () => []);
const mockSendHeartbeat = mock(async () => ({}));
const mockRunCleanup = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    getWorkspaceConfig = mockGetWorkspaceConfig;
    getCompactObservations = mockGetCompactObservations;
    searchObservations = mockSearchObservations;
    getBatchObservations = mockGetBatchObservations;
    createObservation = mockCreateObservation;
    listWorkspaces = mockListWorkspaces;
    sendHeartbeat = mockSendHeartbeat;
    runCleanup = mockRunCleanup;
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
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: mock(async () => {}),
}));

const { WorkerManager } = await import('../../src/workers');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    ...overrides,
  };
}

function makeTask(overrides?: Record<string, any>) {
  return {
    id: 'task-team-1',
    title: 'Team tracking test',
    description: 'Test team event tracking',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...overrides,
  };
}

// Helper to build a tool_use block (mimics SDK assistant message format)
function toolUse(name: string, input: Record<string, unknown>, id?: string) {
  return {
    type: 'tool_use',
    id: id || `toolu_${name}_${Date.now()}`,
    name,
    input,
  };
}

// Helper to build an assistant message with tool_use blocks
function assistantMsg(...blocks: any[]) {
  return {
    type: 'assistant',
    message: { content: blocks },
  };
}

// Helper to build a text block
function textBlock(text: string) {
  return { type: 'text', text };
}

async function startWorkerWithMessages(
  manager: InstanceType<typeof WorkerManager>,
  messages: any[],
  taskOverrides?: Record<string, any>,
  workerId = 'w-team-1',
) {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    ...messages,
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];

  const task = makeTask(taskOverrides);

  mockClaimTask.mockImplementation(async () => [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task,
  }]);

  await manager.claimAndStart(task);
  // Wait for async session to process all messages
  await new Promise(r => setTimeout(r, 300));
  return manager.getWorker(workerId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PostToolUse team tracking hook', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    lastQueryOpts = null;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
    mockStreamInputFn.mockClear();
  });

  test('PostToolUse hook is registered alongside PreToolUse', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Done.')),
    ]);

    expect(lastQueryOpts.options.hooks).toBeDefined();
    expect(lastQueryOpts.options.hooks.PreToolUse).toBeDefined();
    expect(lastQueryOpts.options.hooks.PostToolUse).toBeDefined();
    expect(lastQueryOpts.options.hooks.PostToolUse[0].hooks).toHaveLength(1);
  });

  test('TeamCreate initializes teamState on worker', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(
        textBlock('I will create a team to handle this.'),
        toolUse('TeamCreate', { team_name: 'my-project' }),
      ),
      assistantMsg(textBlock('Team created.')),
    ]);

    // teamState is populated by the PostToolUse hook which fires after tool execution.
    // In our mock, the hook fires when handleMessage processes the tool_use block.
    // But the hook is a PostToolUse hook — it fires after the SDK processes the tool,
    // not when we see the tool_use in the assistant message.
    // In this mock setup, handleMessage only processes assistant messages (tool_use blocks
    // are tracked for phase/currentAction), but the actual hook is called by the SDK.
    //
    // We need to directly invoke the hook to test it.
    // Let's extract the hook and call it manually.

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // Simulate TeamCreate PostToolUse event
    const result = await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'research-team' },
    });

    expect(result).toEqual({});
    expect(worker?.teamState).toBeDefined();
    expect(worker?.teamState?.teamName).toBe('research-team');
    expect(worker?.teamState?.members).toEqual([]);
    expect(worker?.teamState?.messages).toEqual([]);
    expect(worker?.teamState?.createdAt).toBeGreaterThan(0);
  });

  test('Task tool adds member to teamState', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Setting up team.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // First create the team
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'dev-team' },
    });

    // Then spawn a subagent
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_input: {
        name: 'researcher',
        description: 'Research the codebase',
        subagent_type: 'Explore',
      },
    });

    expect(worker?.teamState?.members).toHaveLength(1);
    expect(worker?.teamState?.members[0]).toEqual({
      name: 'researcher',
      role: 'Explore',
      status: 'active',
      spawnedAt: expect.any(Number),
    });
  });

  test('SendMessage appends to teamState messages', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Setting up team.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // Create team first
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'msg-team' },
    });

    // Send a DM
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'researcher',
        content: 'Please check the auth module',
        summary: 'Check auth module',
      },
    });

    expect(worker?.teamState?.messages).toHaveLength(1);
    expect(worker?.teamState?.messages[0]).toEqual({
      from: 'leader',
      to: 'researcher',
      content: 'Please check the auth module',
      summary: 'Check auth module',
      timestamp: expect.any(Number),
    });
  });

  test('broadcast messages emit milestone', async () => {
    manager = new WorkerManager(makeConfig());
    const events: any[] = [];
    manager.onEvent((e: any) => events.push(e));

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'broadcast-team' },
    });

    // Clear events from team creation
    events.length = 0;

    // Send broadcast
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'broadcast',
        content: 'Everyone stop, critical bug found',
        summary: 'Critical bug found',
      },
    });

    // Should have emitted milestone for broadcast
    const milestoneEvents = events.filter((e: any) => e.type === 'milestone');
    const broadcastMilestone = milestoneEvents.find(
      (e: any) => e.milestone?.label?.includes('Broadcast')
    );
    expect(broadcastMilestone).toBeDefined();
    expect(broadcastMilestone.milestone.label).toContain('Critical bug found');
  });

  test('DM messages do NOT emit milestone (avoids noise)', async () => {
    manager = new WorkerManager(makeConfig());
    const events: any[] = [];
    manager.onEvent((e: any) => events.push(e));

    await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'dm-team' },
    });

    events.length = 0;

    // Send DM (not broadcast)
    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'SendMessage',
      tool_input: {
        type: 'message',
        recipient: 'researcher',
        content: 'Check this file',
        summary: 'Check file',
      },
    });

    // Should NOT have a milestone for the DM
    const milestoneEvents = events.filter((e: any) => e.type === 'milestone');
    const dmMilestone = milestoneEvents.find(
      (e: any) => e.milestone?.label?.includes('Broadcast') || e.milestone?.label?.includes('Check file')
    );
    expect(dmMilestone).toBeUndefined();
  });

  test('messages are capped at 200', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'cap-team' },
    });

    // Send 210 messages
    for (let i = 0; i < 210; i++) {
      await teamHook({
        hook_event_name: 'PostToolUse',
        tool_name: 'SendMessage',
        tool_input: {
          type: 'message',
          recipient: 'agent',
          content: `Message ${i}`,
        },
      });
    }

    expect(worker?.teamState?.messages).toHaveLength(200);
    // First messages should have been evicted
    expect(worker?.teamState?.messages[0].content).toBe('Message 10');
    expect(worker?.teamState?.messages[199].content).toBe('Message 209');
  });

  test('hook ignores non-PostToolUse events', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // Call with PreToolUse event — should be ignored
    const result = await teamHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'TeamCreate',
      tool_input: { team_name: 'ignored-team' },
    });

    expect(result).toEqual({});
    expect(worker?.teamState).toBeUndefined();
  });

  test('SendMessage without teamState is ignored (no crash)', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // SendMessage without TeamCreate — should not crash
    const result = await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'SendMessage',
      tool_input: { type: 'message', recipient: 'nobody', content: 'hello' },
    });

    expect(result).toEqual({});
    expect(worker?.teamState).toBeUndefined();
  });

  test('Task without teamState is ignored (no crash)', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithMessages(manager, [
      assistantMsg(textBlock('Starting.')),
    ]);

    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // Task spawn without TeamCreate — should not crash
    const result = await teamHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_input: { name: 'orphan-agent', subagent_type: 'Explore' },
    });

    expect(result).toEqual({});
    expect(worker?.teamState).toBeUndefined();
  });
});

describe('Full team session simulation', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  beforeEach(() => {
    lastQueryOpts = null;
    mockMessages = [];
    mockUpdateWorker.mockClear();
    mockClaimTask.mockClear();
    mockStreamInputFn.mockClear();
  });

  test('realistic multi-agent session: create team, spawn agents, exchange messages, do work', async () => {
    manager = new WorkerManager(makeConfig());
    const events: any[] = [];
    manager.onEvent((e: any) => events.push(e));

    // Simulate a realistic session where the agent:
    // 1. Analyzes the task
    // 2. Creates a team
    // 3. Spawns researcher and implementer
    // 4. Exchanges messages
    // 5. Does file operations
    // 6. Completes
    const worker = await startWorkerWithMessages(manager, [
      // Phase 1: Analysis
      assistantMsg(
        textBlock('Let me analyze this task and create a team to handle it efficiently.'),
        toolUse('Read', { file_path: '/tmp/test-workspace/src/index.ts' }),
      ),
      // Phase 2: Team setup
      assistantMsg(
        textBlock('I will create a team with a researcher and implementer.'),
        toolUse('TeamCreate', { team_name: 'feature-team' }),
      ),
      assistantMsg(
        textBlock('Now spawning the team members.'),
        toolUse('Task', {
          name: 'researcher',
          description: 'Explore the codebase',
          subagent_type: 'Explore',
          prompt: 'Find all authentication-related files',
        }),
        toolUse('Task', {
          name: 'implementer',
          description: 'Implement changes',
          subagent_type: 'general-purpose',
          prompt: 'Add OAuth support to the login flow',
        }),
      ),
      // Phase 3: Coordination
      assistantMsg(
        textBlock('Sending instructions to the team.'),
        toolUse('SendMessage', {
          type: 'message',
          recipient: 'researcher',
          content: 'Focus on the auth middleware in src/middleware/',
          summary: 'Focus on auth middleware',
        }),
        toolUse('SendMessage', {
          type: 'broadcast',
          content: 'Remember to follow conventional commits',
          summary: 'Use conventional commits',
        }),
      ),
      // Phase 4: Work
      assistantMsg(
        textBlock('Now implementing the changes based on team findings.'),
        toolUse('Edit', {
          file_path: '/tmp/test-workspace/src/auth.ts',
          old_string: 'const auth = basic',
          new_string: 'const auth = oauth',
        }),
        toolUse('Bash', { command: 'npm test' }),
      ),
      // Phase 5: More messages
      assistantMsg(
        textBlock('Checking in with the team.'),
        toolUse('SendMessage', {
          type: 'message',
          recipient: 'implementer',
          content: 'Tests are passing, please review the changes',
          summary: 'Tests passing, review needed',
        }),
      ),
      assistantMsg(textBlock('All done. The team completed the task successfully.')),
    ]);

    // Now invoke the PostToolUse hook for team events
    // (In the real SDK, this happens automatically. In our mock, we call it directly.)
    const postToolHooks = lastQueryOpts.options.hooks.PostToolUse[0].hooks;
    const teamHook = postToolHooks[0];

    // Replay team events
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'TeamCreate', tool_input: { team_name: 'feature-team' } });
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: { name: 'researcher', subagent_type: 'Explore' } });
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: { name: 'implementer', subagent_type: 'general-purpose' } });
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { type: 'message', recipient: 'researcher', content: 'Focus on auth middleware', summary: 'Focus on auth middleware' } });
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { type: 'broadcast', content: 'Remember conventional commits', summary: 'Use conventional commits' } });
    await teamHook({ hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_input: { type: 'message', recipient: 'implementer', content: 'Tests passing, review needed', summary: 'Tests passing' } });

    // Verify team state
    expect(worker?.teamState).toBeDefined();
    expect(worker?.teamState?.teamName).toBe('feature-team');

    // 2 members spawned
    expect(worker?.teamState?.members).toHaveLength(2);
    expect(worker?.teamState?.members[0].name).toBe('researcher');
    expect(worker?.teamState?.members[0].role).toBe('Explore');
    expect(worker?.teamState?.members[1].name).toBe('implementer');
    expect(worker?.teamState?.members[1].role).toBe('general-purpose');

    // 3 messages (1 DM + 1 broadcast + 1 DM)
    expect(worker?.teamState?.messages).toHaveLength(3);
    expect(worker?.teamState?.messages[0].to).toBe('researcher');
    expect(worker?.teamState?.messages[1].to).toBe('broadcast');
    expect(worker?.teamState?.messages[2].to).toBe('implementer');

    // Verify milestones were emitted for team events
    const milestoneLabels = events
      .filter((e: any) => e.type === 'milestone')
      .map((e: any) => e.milestone.label);

    expect(milestoneLabels).toContain('Team created: feature-team');
    expect(milestoneLabels).toContain('Subagent: researcher');
    expect(milestoneLabels).toContain('Subagent: implementer');
    expect(milestoneLabels).toContain('Broadcast: Use conventional commits');

    // DM milestones should NOT be present
    const dmMilestones = milestoneLabels.filter(
      (l: string) => l.includes('Focus on auth') || l.includes('Tests passing')
    );
    expect(dmMilestones).toHaveLength(0);

    // Worker should have tool calls tracked
    expect(worker?.toolCalls.length).toBeGreaterThan(0);
    const toolNames = worker?.toolCalls.map(tc => tc.name) || [];
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('TeamCreate');
    expect(toolNames).toContain('Task');
    expect(toolNames).toContain('SendMessage');
    expect(toolNames).toContain('Edit');
    expect(toolNames).toContain('Bash');

    // Worker completed successfully
    expect(worker?.status).toBe('done');
  });
});
