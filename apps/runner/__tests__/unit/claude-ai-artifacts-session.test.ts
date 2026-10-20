/**
 * claude.ai artifact access through the runner's production entrypoint.
 *
 * claude-ai-artifacts.test.ts covers the policy functions one by one. This file
 * drives the path a real claim takes: `WorkerManager.claimAndStart` with a
 * claimed worker carrying (or not carrying) `claudeAiArtifacts`, through env
 * assembly and hook registration, to the options handed to the Agent SDK. It
 * then calls the PreToolUse hooks the session actually registered with the
 * tool inputs a worker would send for a Design canvas.
 *
 * Mocked: only the boundaries — the Agent SDK `query` (no CLI, no model, no
 * claude.ai), the buildd server client, and disk writes. No delete or publish
 * ever reaches anything: the "attempts" are hook calls with synthetic inputs.
 *
 * The --once image's CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and a machine
 * login (CLAUDE_CODE_OAUTH_TOKEN) are set on the runner's env for the whole
 * file, so the swap and the no-leak checks run against both.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { tmpdir } from 'os';
import type { LocalUIConfig } from '../../src/types';
import * as realSessionLogger from '../../src/session-logger';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import { CLAUDE_AI_ARTIFACT_TOOLS, NONESSENTIAL_TRAFFIC_PARTS } from '@buildd/shared';

const RUNNER_KEY = 'bld_runnerkey_artifacts_abcdefghijklmnop';
const HOST_TOKEN = 'sk-ant-oat01-machine-login-artifact-smoke-0123456789';
// Fixture URL in the shape designSourceFromContext accepts. Not a real artifact.
const CANVAS_URL = 'https://claude.ai/artifact/fixture-canvas-0001';

let lastQueryOpts: any = null;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    const msgs = [
      { type: 'system', subtype: 'init', session_id: 'sess-artifacts' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-artifacts' },
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

const mockUpdateWorker = mock(async (..._a: any[]) => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    mintTaskToken = async () => { throw new Error('no mint in this test'); };
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

/** Everything written to disk — scanned for the machine login token. */
const diskWrites: string[] = [];
mock.module('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: (_p: any, data: any) => { diskWrites.push(String(data)); },
  mkdirSync: () => {},
  chmodSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: (_p: any, data: any) => { diskWrites.push(String(data)); },
  statSync: () => ({ size: 0, mtimeMs: 0 }),
  copyFileSync: () => {},
  rmSync: () => {},
}));

const sessionLogs: string[] = [];
mock.module('../../src/session-logger', () => ({
  ...realSessionLogger,
  sessionLog: (...a: any[]) => { sessionLogs.push(JSON.stringify(a)); },
}));

const savedWorkers: string[] = [];
mock.module('../../src/worker-store', () => ({
  saveWorker: (w: any) => { savedWorkers.push(JSON.stringify(w)); },
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

function makeConfig(): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: RUNNER_KEY,
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as LocalUIConfig;
}

async function waitForSessionEnd(manager: InstanceType<typeof WorkerManager>, workerId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.getWorker(workerId)?.status;
    if (status === 'done' || status === 'error' || status === 'waiting_input') return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`worker ${workerId} did not finish within ${timeoutMs}ms (status: ${manager.getWorker(workerId)?.status})`);
}

/** Claim one task whose claimed worker carries `claimed`, and run it to the end. */
async function runClaim(manager: InstanceType<typeof WorkerManager>, workerId: string, claimed: Record<string, unknown>, context: Record<string, unknown> = {}) {
  const task = {
    id: `task-${workerId}`,
    title: 'Read the design canvas',
    description: 'Implement the board from the design source.',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    outputRequirement: 'none',
    context: { designSource: { sourceUrl: CANVAS_URL }, ...context },
  };
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    worktreePath: getTestWorkspace(),
    task,
    ...claimed,
  }] }));
  await manager.claimAndStart(task as any);
  await waitForSessionEnd(manager, workerId);
  expect(lastQueryOpts).not.toBeNull();
}

function sessionEnv(): Record<string, string> {
  return lastQueryOpts.options.env as Record<string, string>;
}

/**
 * Run a tool call through every PreToolUse hook the session registered, as the
 * CLI would. Returns the first deny reason, or null when every hook allows it.
 */
async function preToolUse(toolName: string, toolInput: Record<string, unknown>): Promise<string | null> {
  const groups = lastQueryOpts.options.hooks?.PreToolUse ?? [];
  for (const g of groups) {
    if (g.matcher && !new RegExp(`^(?:${g.matcher})$`).test(toolName)) continue;
    for (const hook of g.hooks) {
      const out = await hook(
        { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, session_id: 'sess-artifacts', transcript_path: '', cwd: getTestWorkspace() },
        `toolu_${toolName}`,
        { signal: new AbortController().signal },
      );
      const decision = out?.hookSpecificOutput?.permissionDecision;
      if (decision === 'deny') return String(out.hookSpecificOutput.permissionDecisionReason ?? 'denied');
    }
  }
  return null;
}

/** The read a design-consuming worker makes, per the design-source prompt section. */
const CANVAS_READS: Array<[string, Record<string, unknown>]> = [
  ['Artifact', { action: 'list', url: CANVAS_URL, scope: 'files' }],
  ['Artifact', { action: 'read', url: CANVAS_URL, path: 'project/canvas.json' }],
  ['Artifact', { action: 'read', url: CANVAS_URL, path: 'project/Board.dc.html' }],
  ['Artifact', { action: 'get', url: CANVAS_URL }],
];

/** Writes. Hook calls only: nothing here reaches claude.ai. */
const PUBLISHES: Array<[string, Record<string, unknown>]> = [
  ['Artifact', { action: 'publish', file_path: '/tmp/x.html' }],
  ['Artifact', { file_path: '/tmp/x.html' }], // no action = publish, the tool's default
  ['ArtifactData', { action: 'upload', url: CANVAS_URL }],
  ['DesignSync', { action: 'write_files', url: CANVAS_URL }],
];
const DELETES: Array<[string, Record<string, unknown>]> = [
  ['Artifact', { action: 'delete', url: CANVAS_URL }],
  ['ArtifactData', { action: 'delete_asset', url: CANVAS_URL }],
];

let logged: string[] = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
const savedEnv = {
  traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  artifact: process.env.CLAUDE_CODE_ARTIFACT,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('claude.ai artifact access: claim → session', () => {
  let manager: InstanceType<typeof WorkerManager>;

  afterAll(() => {
    cleanupTestWorkspace();
    restore('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', savedEnv.traffic);
    restore('CLAUDE_CODE_OAUTH_TOKEN', savedEnv.oauth);
    restore('CLAUDE_CODE_ARTIFACT', savedEnv.artifact);
  });

  beforeEach(() => {
    initTestWorkspace();
    // As in the --once image, with a machine login. A runner-host
    // CLAUDE_CODE_ARTIFACT must not leak through either way.
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = HOST_TOKEN;
    process.env.CLAUDE_CODE_ARTIFACT = '1';
    lastQueryOpts = null;
    diskWrites.length = 0;
    sessionLogs.length = 0;
    savedWorkers.length = 0;
    mockUpdateWorker.mockClear();
    logged = [];
    const capture = (orig: (...a: any[]) => void) => (...a: any[]) => { logged.push(a.map(String).join(' ')); orig(...a); };
    console.log = capture(realConsole.log);
    console.warn = capture(realConsole.warn);
    console.error = capture(realConsole.error);
    manager = new WorkerManager(makeConfig());
  });

  afterEach(() => {
    manager?.destroy?.();
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  });

  function expectNoTokenLeak() {
    for (const s of savedWorkers) expect(s).not.toContain(HOST_TOKEN);
    for (const call of mockUpdateWorker.mock.calls) expect(JSON.stringify(call)).not.toContain(HOST_TOKEN);
    for (const w of diskWrites) expect(w).not.toContain(HOST_TOKEN);
    for (const l of logged) expect(l).not.toContain(HOST_TOKEN);
    for (const l of sessionLogs) expect(l).not.toContain(HOST_TOKEN);
  }

  test('opted in at read: env on, umbrella swapped for its parts, canvas reads allowed', async () => {
    await runClaim(manager, 'w-art-read', { claudeAiArtifacts: 'read' });
    const env = sessionEnv();
    expect(env.CLAUDE_CODE_ARTIFACT).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    for (const k of NONESSENTIAL_TRAFFIC_PARTS) expect(env[k]).toBe('1');

    for (const [tool, input] of CANVAS_READS) {
      expect(await preToolUse(tool, input)).toBeNull();
    }
    expect(logged.some(l => l.includes('claude.ai artifact access: read'))).toBe(true);
    expectNoTokenLeak();
  });

  test('opted in at read: publish and delete are refused by the registered hook', async () => {
    await runClaim(manager, 'w-art-read-writes', { claudeAiArtifacts: 'read' });
    for (const [tool, input] of PUBLISHES) {
      expect(await preToolUse(tool, input)).toContain('may only read');
    }
    for (const [tool, input] of DELETES) {
      expect(await preToolUse(tool, input)).toContain('never allowed');
    }
    expectNoTokenLeak();
  });

  test('producer role (publish): publish allowed, delete still refused', async () => {
    await runClaim(manager, 'w-art-publish', { claudeAiArtifacts: 'publish' });
    expect(sessionEnv().CLAUDE_CODE_ARTIFACT).toBe('1');
    for (const [tool, input] of PUBLISHES) expect(await preToolUse(tool, input)).toBeNull();
    for (const [tool, input] of DELETES) expect(await preToolUse(tool, input)).toContain('never allowed');
  });

  test('control (no opt-in): env unset, umbrella kept, every artifact tool refused', async () => {
    await runClaim(manager, 'w-art-control', {});
    const env = sessionEnv();
    expect(env.CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');

    for (const [tool, input] of CANVAS_READS) {
      expect(await preToolUse(tool, input)).toContain('not enabled');
    }
    // A tool that shows up without the opt-in (DesignSync is listed by newer
    // CLIs regardless of CLAUDE_CODE_ARTIFACT) is still refused.
    for (const tool of CLAUDE_AI_ARTIFACT_TOOLS) {
      expect(await preToolUse(tool, { action: 'read', url: CANVAS_URL })).not.toBeNull();
    }
    for (const [tool, input] of DELETES) expect(await preToolUse(tool, input)).toContain('never allowed');
    expectNoTokenLeak();
  });

  test('a role env secret cannot opt a session in', async () => {
    await runClaim(manager, 'w-art-roleenv', { roleEnvSecrets: { CLAUDE_CODE_ARTIFACT: '1' } });
    expect(sessionEnv().CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(await preToolUse('Artifact', CANVAS_READS[1][1])).toContain('not enabled');
  });

  test('explicit off on the claim behaves as the control', async () => {
    await runClaim(manager, 'w-art-off', { claudeAiArtifacts: 'off' });
    expect(sessionEnv().CLAUDE_CODE_ARTIFACT).toBeUndefined();
    expect(await preToolUse('Artifact', CANVAS_READS[0][1])).toContain('not enabled');
  });

  test('the machine login reaches the agent as-is and the claim adds no Claude credential', async () => {
    await runClaim(manager, 'w-art-login', { claudeAiArtifacts: 'read' });
    const env = sessionEnv();
    // The Artifact tool runs on the runner's own login; nothing server-side
    // stands in for it (claims carry API keys only).
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(HOST_TOKEN);
    expectNoTokenLeak();
  });
});
