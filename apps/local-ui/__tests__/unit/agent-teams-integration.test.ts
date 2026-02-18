/**
 * Integration tests for Agent Teams & Skills-as-Subagents.
 *
 * Tests the full flow:
 * 1. Skill bundles with description flow through claim → worker session
 * 2. useSkillAgents context propagates correctly end-to-end
 * 3. Multiple skill bundles produce correct agent definitions
 * 4. Mixed scenarios (some skills with desc, some without)
 *
 * Run: bun test apps/local-ui/__tests__/unit/agent-teams-integration.test.ts
 */

import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';
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
    id: 'task-int-1',
    title: 'Integration test task',
    description: 'Test the full flow',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    ...overrides,
  };
}

async function startWorkerWithTask(
  manager: InstanceType<typeof WorkerManager>,
  taskOverrides?: Record<string, any>,
  workerId = 'w-int-1',
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

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Integration: skill bundle description propagation', () => {
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

  test('description from skill bundle flows into agent definition', async () => {
    manager = new WorkerManager(makeConfig());

    const bundles: SkillBundle[] = [
      {
        slug: 'security-audit',
        name: 'Security Audit',
        description: 'Performs thorough security analysis of code changes',
        content: 'Analyze code for OWASP top 10 vulnerabilities...',
        contentHash: 'sec123',
      },
    ];

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['security-audit'],
        skillBundles: bundles,
        useSkillAgents: true,
      },
    });

    const agents = lastQueryOpts.options.agents;
    expect(agents['security-audit'].description).toBe(
      'Performs thorough security analysis of code changes'
    );
    expect(agents['security-audit'].prompt).toBe(
      'Analyze code for OWASP top 10 vulnerabilities...'
    );
  });

  test('mixed bundles: some with description, some without', async () => {
    manager = new WorkerManager(makeConfig());

    const bundles: SkillBundle[] = [
      {
        slug: 'with-desc',
        name: 'Has Description',
        description: 'This skill has a description',
        content: 'instructions A',
      },
      {
        slug: 'no-desc',
        name: 'No Description',
        // no description field
        content: 'instructions B',
      },
    ];

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['with-desc', 'no-desc'],
        skillBundles: bundles,
        useSkillAgents: true,
      },
    });

    const agents = lastQueryOpts.options.agents;
    expect(agents['with-desc'].description).toBe('This skill has a description');
    expect(agents['no-desc'].description).toBe('No Description'); // Falls back to name
  });
});

describe('Integration: full claim → session flow', () => {
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

  test('claim response with skillBundles + useSkillAgents creates agents', async () => {
    manager = new WorkerManager(makeConfig());

    // Simulate what the claim API returns
    const claimBundles: SkillBundle[] = [
      {
        slug: 'deploy',
        name: 'Deploy Workflow',
        description: 'Manages deployment pipelines',
        content: '# Deploy\n\nFollow these steps...',
        contentHash: 'h1',
      },
      {
        slug: 'test-runner',
        name: 'Test Runner',
        description: 'Runs and validates test suites',
        content: '# Testing\n\nRun all tests...',
        contentHash: 'h2',
      },
    ];

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy', 'test-runner'],
        skillBundles: claimBundles,
        useSkillAgents: true,
      },
    });

    // Verify the full query configuration
    const opts = lastQueryOpts.options;

    // Teams env is set
    expect(opts.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');

    // Agents are defined
    expect(Object.keys(opts.agents)).toEqual(['deploy', 'test-runner']);

    // Each agent has correct structure
    for (const slug of ['deploy', 'test-runner']) {
      const agent = opts.agents[slug];
      expect(agent.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
      expect(agent.model).toBe('inherit');
      expect(typeof agent.description).toBe('string');
      expect(typeof agent.prompt).toBe('string');
      expect(agent.prompt.length).toBeGreaterThan(0);
    }

    // No Skill tool scoping
    expect(opts.allowedTools).toBeUndefined();

    // No system prompt append for skill invocation
    expect(opts.systemPrompt.append).toBeUndefined();

    // Skills were synced to disk
    expect(mockSyncSkillToLocal.mock.calls.length).toBe(2);
  });

  test('claim response without useSkillAgents uses traditional skill flow', async () => {
    manager = new WorkerManager(makeConfig());

    const claimBundles: SkillBundle[] = [
      {
        slug: 'deploy',
        name: 'Deploy',
        description: 'Deploy stuff',
        content: 'Deploy instructions',
        contentHash: 'h1',
      },
    ];

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: claimBundles,
        // useSkillAgents NOT set
      },
    });

    const opts = lastQueryOpts.options;

    // Teams env still set (always on)
    expect(opts.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');

    // No agents
    expect(opts.agents).toBeUndefined();

    // Skill tool scoping active
    expect(opts.allowedTools).toEqual(['Skill(deploy)']);

    // System prompt instructs Skill tool usage
    expect(opts.systemPrompt.append).toContain('MUST use the deploy skill');

    // Skills still synced to disk
    expect(mockSyncSkillToLocal.mock.calls.length).toBe(1);
  });

  test('worker completes successfully with subagent config', async () => {
    manager = new WorkerManager(makeConfig());

    const worker = await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [{
          slug: 'deploy',
          name: 'Deploy',
          description: 'Deploy workflow',
          content: 'Deploy...',
        }],
        useSkillAgents: true,
      },
    });

    // Worker should complete successfully
    expect(worker?.status).toBe('done');
    expect(worker?.currentAction).toBe('Completed');
  });

  test('worker status updates flow correctly with agent teams enabled', async () => {
    manager = new WorkerManager(makeConfig());
    const events: any[] = [];
    manager.onEvent((e: any) => events.push(e));

    await startWorkerWithTask(manager, {
      context: {
        skillSlugs: ['deploy'],
        skillBundles: [{
          slug: 'deploy',
          name: 'Deploy',
          content: 'Deploy...',
        }],
        useSkillAgents: true,
      },
    });

    // Should have emitted worker_update events
    const workerUpdates = events.filter((e: any) => e.type === 'worker_update');
    expect(workerUpdates.length).toBeGreaterThan(0);

    // Should have emitted milestone for skill sync
    const milestoneEvents = events.filter((e: any) => e.type === 'milestone');
    const syncMilestone = milestoneEvents.find(
      (e: any) => e.milestone?.label?.includes('Skill synced')
    );
    expect(syncMilestone).toBeDefined();
  });

  test('multiple workers with different subagent configs run independently', async () => {
    manager = new WorkerManager(makeConfig({ maxConcurrent: 3 }));

    // Worker 1: with subagents
    await startWorkerWithTask(
      manager,
      {
        id: 'task-a',
        context: {
          skillSlugs: ['deploy'],
          skillBundles: [{ slug: 'deploy', name: 'Deploy', content: 'Deploy...', description: 'Deploy things' }],
          useSkillAgents: true,
        },
      },
      'w-multi-1',
    );
    const opts1 = { ...lastQueryOpts.options };

    // Worker 2: without subagents
    await startWorkerWithTask(
      manager,
      {
        id: 'task-b',
        context: {
          skillSlugs: ['review'],
          skillBundles: [{ slug: 'review', name: 'Review', content: 'Review...' }],
        },
      },
      'w-multi-2',
    );
    const opts2 = { ...lastQueryOpts.options };

    // Worker 1 should have agents
    expect(opts1.agents).toBeDefined();
    expect(opts1.agents.deploy).toBeDefined();
    expect(opts1.allowedTools).toBeUndefined();

    // Worker 2 should use Skill tool
    expect(opts2.agents).toBeUndefined();
    expect(opts2.allowedTools).toEqual(['Skill(review)']);
  });
});

describe('Integration: SkillBundle type with description', () => {
  test('SkillBundle type accepts description field', () => {
    const bundle: SkillBundle = {
      slug: 'test',
      name: 'Test Skill',
      description: 'A test skill with description',
      content: 'Do testing',
      contentHash: 'hash123',
    };

    expect(bundle.description).toBe('A test skill with description');
  });

  test('SkillBundle type allows omitting description', () => {
    const bundle: SkillBundle = {
      slug: 'test',
      name: 'Test Skill',
      content: 'Do testing',
    };

    expect(bundle.description).toBeUndefined();
  });

  test('SkillBundle description is optional alongside other optional fields', () => {
    const bundle: SkillBundle = {
      slug: 'full',
      name: 'Full Skill',
      description: 'Has everything',
      content: 'Instructions',
      contentHash: 'hash',
      referenceFiles: { 'ref.md': 'content' },
      files: [{ path: 'script.sh', content: '#!/bin/bash', executable: true }],
    };

    expect(bundle.description).toBe('Has everything');
    expect(bundle.referenceFiles).toBeDefined();
    expect(bundle.files).toHaveLength(1);
  });
});
