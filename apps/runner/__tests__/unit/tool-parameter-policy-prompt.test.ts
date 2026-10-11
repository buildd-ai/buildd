/**
 * The Tool Parameter Policy must reach a Claude session in headless (cloud runner) mode.
 *
 * Agents in non-interactive environments must not use run_in_background: true,
 * because there is no re-invocation mechanism to notify them when the background
 * task completes. This test ensures that the warning reaches the actual prompt
 * sent to Claude.
 */
import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import { join } from 'path';
import type { LocalUIConfig } from '../../src/types';

import * as realRoles from '../../src/roles';
import * as realGitOps from '../../src/git-operations';

let lastQueryOpts: any = null;
let mockMessages: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [...mockMessages];
    let idx = 0;
    return {
      streamInput: mock(() => {}),
      supportedModels: async () => [],
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (idx < msgs.length) return { value: msgs[idx++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  },
}));

const mockUpdateWorker = mock(async () => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
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
    resolve: () => getTestWorkspace(),
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    getProjectRoots: () => [tmpdir()],
  }),
}));

mock.module('pusher-js', () => ({
  default: class {
    subscribe() { return { bind: () => {} }; }
    unsubscribe() {}
    disconnect() {}
  },
}));

let claudeMdInCwd: string | null = null;
mock.module('fs', () => ({
  existsSync: (p: string) => {
    const path = String(p);
    if (path.endsWith('/CLAUDE.md')) return claudeMdInCwd !== null;
    return path.endsWith('/.git');
  },
  readFileSync: (p: string) => (String(p).endsWith('/CLAUDE.md') && claudeMdInCwd !== null ? claudeMdInCwd : '{}'),
  writeFileSync: () => {},
  mkdirSync: () => {},
  chmodSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
}));

mock.module('../../src/roles', () => ({
  ...realRoles,
  syncRoleToLocal: async () => ({ cwd: '/tmp/role-dir' }),
  overlayRoleFiles: async () => {},
  resolveRoleCwd: async (_rc: any, _t: any, workspacePath: string) => ({ cwd: workspacePath }),
  resolveRoleEnv: async () => ({ resolved: {}, missing: [] }),
}));

mock.module('../../src/git-operations', () => ({
  ...realGitOps,
  setupWorktree: async (_repo: string, branch: string) => ({ path: getTestWorkspace(), branch, base: 'origin/main' }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ platform: 'linux', arch: 'x64', tools: [], envKeys: [], mcp: [], mcpServers: [], labels: { type: 'local', os: 'linux', arch: 'x64', hostname: 'test' }, scannedAt: new Date(0).toISOString() }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

const { WorkerManager } = await import('../../src/workers');

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as LocalUIConfig;
}

/** Drives one claim→session and returns the assembled systemPrompt.append. */
async function runTask(
  manager: InstanceType<typeof WorkerManager>,
  claimExtra: Record<string, unknown>,
  workerId = 'w-tool-param-1',
): Promise<string> {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];
  const task = {
    id: 'task-tool-param-1',
    title: 'Tool parameter policy task',
    description: 'test the prompt',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace', repo: 'acme/widgets' },
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    worktreePath: getTestWorkspace(),
    task,
    ...claimExtra,
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  return (lastQueryOpts?.options?.systemPrompt?.append ?? '') as string;
}

describe('assembled system prompt: tool parameter policy', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterAll(() => {


    cleanupTestWorkspace();


  });


  beforeEach(() => {


    initTestWorkspace();
    lastQueryOpts = null;
    claudeMdInCwd = null;
    mockUpdateWorker.mockClear();
    manager = new WorkerManager(makeConfig());
  });

  afterEach(() => {
    manager?.destroy?.();
  });

  test('includes warning about run_in_background limitation', async () => {
    const append = await runTask(manager, {});

    expect(append).toContain('## Tool Parameter Policy');
    expect(append).toContain('run_in_background');
    expect(append).toContain('Do NOT use `run_in_background: true`');
  });

  test('explains that re-invocation does not exist in this environment', async () => {
    const append = await runTask(manager, {}, 'w-tool-param-2');

    expect(append).toContain('re-invoke');
    expect(append).toContain('execution environment');
  });

  test('offers polling as an alternative', async () => {
    const append = await runTask(manager, {}, 'w-tool-param-3');

    expect(append).toContain('poll');
    expect(append).toContain('synchronously');
  });

  test('advises reporting tool timeouts as blockers', async () => {
    const append = await runTask(manager, {}, 'w-tool-param-4');

    expect(append).toContain('blocker');
    expect(append).toContain('report to the user');
  });

  test('appears after the Tool Channel Policy in the prompt', async () => {
    const append = await runTask(manager, {}, 'w-tool-param-5');

    const toolChannelIndex = append.indexOf('## Tool Channel Policy');
    const toolParameterIndex = append.indexOf('## Tool Parameter Policy');

    expect(toolChannelIndex).toBeGreaterThanOrEqual(0);
    expect(toolParameterIndex).toBeGreaterThanOrEqual(0);
    expect(toolChannelIndex).toBeLessThan(toolParameterIndex);
  });

  test('tells the agent not to narrate imminent tool calls', async () => {
    const append = await runTask(manager, {}, 'w-tool-param-6');

    expect(append).toContain('## Narration Policy');
    expect(append).toContain('Call tools directly');
    expect(append).toContain('Let me…');
    // Findings, decisions, warnings and results are still worth writing.
    expect(append).toContain('finding, a decision, a warning or a result');
  });
});
