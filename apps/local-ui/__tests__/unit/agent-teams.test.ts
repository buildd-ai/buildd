/**
 * Unit tests for Agent Teams and Skills-as-Subagents features.
 *
 * Tests:
 * 1. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var is set
 * 2. useSkillAgents flag converts skill bundles to agent definitions
 * 3. useSkillAgents disables Skill tool scoping and system prompt append
 * 4. Stale timeout is 300s (not 120s)
 * 5. Backwards compatibility: tasks without useSkillAgents behave as before
 *
 * Run: bun test apps/local-ui/__tests__/unit/agent-teams.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalWorker, LocalUIConfig } from '../../src/types';
import type { SkillBundle } from '@buildd/shared';

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
}));

const mockSyncSkillToLocal = mock(async () => {});
mock.module('../../src/skills.js', () => ({
  syncSkillToLocal: mockSyncSkillToLocal,
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
    id: 'task-1',
    title: 'Test task',
    description: 'Do something',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...overrides,
  };
}

const SKILL_BUNDLES: SkillBundle[] = [
  {
    slug: 'deploy',
    name: 'Deploy',
    description: 'Handles deployment workflows',
    content: 'Deploy instructions here',
    contentHash: 'abc123',
  },
  {
    slug: 'review',
    name: 'Code Review',
    description: 'Reviews code for quality',
    content: 'Review instructions here',
    contentHash: 'def456',
  },
];

async function startWorkerWithTask(
  manager: InstanceType<typeof WorkerManager>,
  taskOverrides?: Record<string, any>,
  workerId = 'w-at-1',
) {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];

  const task = makeTask(taskOverrides);

  mockClaimTask.mockImplementation(async () => [{
    id: workerId,
    branch: `buildd/${workerId}`,
    task,
  }]);

  await manager.claimAndStart(task);
  await new Promise(r => setTimeout(r, 200));
  return manager.getWorker(workerId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Agent Teams — env configuration', () => {
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
    mockSyncSkillToLocal.mockClear();
  });

  test('sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in query env', async () => {
    manager = new WorkerManager(makeConfig());
    await startWorkerWithTask(manager);

    expect(lastQueryOpts).toBeDefined();
    const env = lastQueryOpts.options.env;
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  test('sets teams env even when no skills assigned', async () => {
    manager = new WorkerManager(makeConfig());
    await startWorkerWithTask(manager, { context: {} });

    const env = lastQueryOpts.options.env;
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  test('sets teams env alongside OpenRouter provider config', async () => {
    manager = new WorkerManager(makeConfig({
      llmProvider: { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api', apiKey: 'or-key' },
    }));
    await startWorkerWithTask(manager);

    const env = lastQueryOpts.options.env;
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
  });
});

describe('Stale timeout', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterEach(() => {
    manager?.destroy();
  });

  test('does not mark worker stale before 300s', () => {
    manager = new WorkerManager(makeConfig());

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    workers.set('w-not-stale', {
      id: 'w-not-stale',
      taskId: 'task-1',
      taskTitle: 'Test',
      workspaceId: 'ws-1',
      workspaceName: 'test',
      branch: 'buildd/test',
      status: 'working',
      hasNewActivity: false,
      lastActivity: Date.now() - 200_000, // 200s — under 300s threshold
      milestones: [],
      currentAction: 'Coordinating team...',
      commits: [],
      output: [],
      toolCalls: [],
      messages: [],
      phaseText: null,
      phaseStart: null,
      phaseToolCount: 0,
      phaseTools: [],
    } as LocalWorker);

    (manager as any).checkStale();
    expect(workers.get('w-not-stale')?.status).toBe('working');
  });

  test('marks worker stale after 300s', () => {
    manager = new WorkerManager(makeConfig());

    const workers = (manager as any).workers as Map<string, LocalWorker>;
    workers.set('w-stale', {
      id: 'w-stale',
      taskId: 'task-1',
      taskTitle: 'Test',
      workspaceId: 'ws-1',
      workspaceName: 'test',
      branch: 'buildd/test',
      status: 'working',
      hasNewActivity: false,
      lastActivity: Date.now() - 310_000, // 310s — over 300s threshold
      milestones: [],
      currentAction: 'Thinking...',
      commits: [],
      output: [],
      toolCalls: [],
      messages: [],
      phaseText: null,
      phaseStart: null,
      phaseToolCount: 0,
      phaseTools: [],
    } as LocalWorker);

    (manager as any).checkStale();
    expect(workers.get('w-stale')?.status).toBe('stale');
  });
});

describe('Skills as subagents (useSkillAgents)', () => {
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
    mockSyncSkillToLocal.mockClear();
  });

  test('converts skill bundles to agent definitions when useSkillAgents is true', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy', 'review'],
        skillBundles: SKILL_BUNDLES,
        useSkillAgents: true,
      },
    });

    expect(lastQueryOpts.options.agents).toBeDefined();

    const agents = lastQueryOpts.options.agents;
    expect(Object.keys(agents)).toEqual(['deploy', 'review']);

    // Check deploy agent
    expect(agents.deploy.description).toBe('Handles deployment workflows');
    expect(agents.deploy.prompt).toBe('Deploy instructions here');
    expect(agents.deploy.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
    expect(agents.deploy.model).toBe('inherit');

    // Check review agent
    expect(agents.review.description).toBe('Reviews code for quality');
    expect(agents.review.prompt).toBe('Review instructions here');
  });

  test('uses name as fallback description when description is missing', async () => {
    manager = new WorkerManager(makeConfig());

    const bundlesNoDesc: SkillBundle[] = [
      { slug: 'lint', name: 'Linter', content: 'Lint instructions' },
    ];

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['lint'],
        skillBundles: bundlesNoDesc,
        useSkillAgents: true,
      },
    });

    expect(lastQueryOpts.options.agents.lint.description).toBe('Linter');
  });

  test('does NOT scope allowedTools when useSkillAgents is true', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy', 'review'],
        skillBundles: SKILL_BUNDLES,
        useSkillAgents: true,
      },
    });

    // allowedTools should not be set (or should not contain Skill(...))
    const allowedTools = lastQueryOpts.options.allowedTools;
    expect(allowedTools).toBeUndefined();
  });

  test('does NOT add system prompt append when useSkillAgents is true', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [SKILL_BUNDLES[0]],
        useSkillAgents: true,
      },
    });

    const systemPrompt = lastQueryOpts.options.systemPrompt;
    expect(systemPrompt.append).toBeUndefined();
  });

  test('does NOT create agents when useSkillAgents is false', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [SKILL_BUNDLES[0]],
        // useSkillAgents NOT set
      },
    });

    expect(lastQueryOpts.options.agents).toBeUndefined();
  });

  test('scopes allowedTools normally when useSkillAgents is false', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy', 'review'],
        skillBundles: SKILL_BUNDLES,
      },
    });

    const allowedTools = lastQueryOpts.options.allowedTools;
    expect(allowedTools).toEqual(['Skill(deploy)', 'Skill(review)']);
  });

  test('adds system prompt append normally when useSkillAgents is false', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [SKILL_BUNDLES[0]],
      },
    });

    const systemPrompt = lastQueryOpts.options.systemPrompt;
    expect(systemPrompt.append).toContain('MUST use the deploy skill');
  });

  test('does NOT create agents when no skill bundles exist', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        useSkillAgents: true,
        // no skillBundles
      },
    });

    expect(lastQueryOpts.options.agents).toBeUndefined();
  });

  test('does NOT create agents when skill bundles is empty array', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: [],
        skillBundles: [],
        useSkillAgents: true,
      },
    });

    expect(lastQueryOpts.options.agents).toBeUndefined();
  });
});

describe('Backwards compatibility', () => {
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
    mockSyncSkillToLocal.mockClear();
  });

  test('task with no skills or context works as before', async () => {
    manager = new WorkerManager(makeConfig());
    await startWorkerWithTask(manager, { context: {} });

    expect(lastQueryOpts.options.agents).toBeUndefined();
    expect(lastQueryOpts.options.allowedTools).toBeUndefined();
    expect(lastQueryOpts.options.systemPrompt.append).toBeUndefined();
  });

  test('task with no context at all works', async () => {
    manager = new WorkerManager(makeConfig());
    await startWorkerWithTask(manager);

    expect(lastQueryOpts.options.agents).toBeUndefined();
    expect(lastQueryOpts.options.allowedTools).toBeUndefined();
  });

  test('task with skills but no useSkillAgents uses Skill tool', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [SKILL_BUNDLES[0]],
      },
    });

    // Should scope to Skill tool
    expect(lastQueryOpts.options.allowedTools).toEqual(['Skill(deploy)']);
    // Should have system prompt append
    expect(lastQueryOpts.options.systemPrompt.append).toContain('deploy');
    // Should NOT have agents
    expect(lastQueryOpts.options.agents).toBeUndefined();
  });

  test('multiple skills without useSkillAgents lists all Skill tools', async () => {
    manager = new WorkerManager(makeConfig());

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy', 'review'],
        skillBundles: SKILL_BUNDLES,
      },
    });

    expect(lastQueryOpts.options.allowedTools).toEqual(['Skill(deploy)', 'Skill(review)']);
    expect(lastQueryOpts.options.systemPrompt.append).toContain('deploy, review');
  });
});
