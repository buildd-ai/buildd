/**
 * A Claude session on this machine's local model (Ollama), assembled by the
 * real WorkerManager: the Ollama tag is the session model, Claude Code is told
 * which model the tag stands in for (so it never flags the tag
 * `[claude-code:unrecognized_model]`), tool search is off, and model traffic
 * goes to the loopback endpoint with the placeholder token. A runner without
 * a local model gets none of it: the cloud route is unchanged.
 *
 * local-model-cli.test.ts runs the bundled CLI against these settings.
 * Harness mirrors primary-clone-exposure.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { resolve } from 'path';
import type { LocalUIConfig } from '../../src/types';
import * as realRoles from '../../src/roles';
import * as realGitOps from '../../src/git-operations';
import { cleanupTestWorkspace } from '../test-workspace';
import { resolveLocalModelEndpoint, LOCAL_CLAUDE_REFERENCE_MODEL } from '../../src/local-model-endpoint';

const PRIMARY = resolve('/tmp/test-local-model-clone').replace(/\\/g, '/');
const WORKTREE = `${PRIMARY}/.buildd-worktrees/buildd-w-local`;

let lastQueryOpts: any = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [
      { type: 'system', subtype: 'init', session_id: 'sess-local' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-local' },
    ];
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

const mockClaimTask = mock(async () => ({ workers: [] as any[] }));
mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mock(async () => ({}));
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
    resolve: () => PRIMARY,
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
  existsSync: (p: string) => String(p).endsWith('/.git'),
  readFileSync: () => '{}',
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
  realpathSync: (p: string) => p,
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
  setupWorktree: async (_repo: string, branch: string) => ({ path: WORKTREE, branch, base: 'origin/main' }),
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

const { WorkerManager, __setModelAuthPreflightForTest, __setIsolationHostForTest } = await import('../../src/workers');
__setIsolationHostForTest('linux');
__setModelAuthPreflightForTest(() => null);

const LOCAL_TAG = 'mistral-nemo:buildd-local';
const local = resolveLocalModelEndpoint({ BUILDD_LOCAL_MODEL_URL: 'http://localhost:11434', BUILDD_LOCAL_MODEL: LOCAL_TAG, BUILDD_LOCAL_MODEL_CONTEXT: '65536' })!;

async function sessionOptions(localModel: typeof local | undefined, id: string): Promise<any> {
  lastQueryOpts = null;
  const manager = new WorkerManager({
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
    ...(localModel ? { localModel } : {}),
  } as LocalUIConfig);
  const task = {
    id: `task-${id}`,
    title: 'Local model task',
    description: 'do a small change',
    workspaceId: 'ws-1',
    workspace: { name: 'demo', repo: 'acme/widgets' },
    status: 'waiting',
    priority: 1,
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{ id: `w-${id}`, branch: `buildd/w-${id}`, task }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  manager.destroy?.();
  return lastQueryOpts?.options;
}

describe('Claude session options on a local model', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let localOpts: any;
  let cloudOpts: any;

  beforeAll(async () => {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ENABLE_TOOL_SEARCH']) savedEnv[k] = process.env[k];
    process.env.ANTHROPIC_API_KEY = 'sk-machine-real';
    delete process.env.ANTHROPIC_BASE_URL;
    localOpts = await sessionOptions(local, 'local');
    cloudOpts = await sessionOptions(undefined, 'cloud');
  });

  afterAll(() => {
    cleanupTestWorkspace();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('the Ollama tag is the session model, with no Claude fallback', () => {
    expect(localOpts?.model).toBe(LOCAL_TAG);
    expect(localOpts?.fallbackModel).toBeUndefined();
  });

  test('Claude Code is told the tag stands in for a model it knows', () => {
    expect(localOpts?.settings?.modelOverrides).toEqual({ [LOCAL_CLAUDE_REFERENCE_MODEL]: LOCAL_TAG });
    // Merged with, not replacing, the runner's own settings.
    expect(Array.isArray(localOpts?.settings?.claudeMdExcludes)).toBe(true);
  });

  test('model traffic goes to the local endpoint with the placeholder token and tools undeferred', () => {
    const env = localOpts?.env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('65536');
  });

  test('a runner without a local model is unchanged', () => {
    expect(cloudOpts).toBeTruthy();
    expect(cloudOpts.model).not.toBe(LOCAL_TAG);
    expect(cloudOpts.settings?.modelOverrides).toBeUndefined();
    const env = cloudOpts.env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});
