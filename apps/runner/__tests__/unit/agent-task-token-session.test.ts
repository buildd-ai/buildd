/**
 * The agent's buildd MCP auth at the WorkerManager call site.
 *
 * Each startSession mints a per-task token and uses it ONLY for the agent's
 * buildd MCP auth: the Claude `mcpServers.buildd` Authorization header and the
 * Codex `BUILDD_MCP_BEARER_TOKEN` env. The runner's own client keeps its key.
 * A failed mint falls back to the key, and the session still starts. The token
 * never reaches persisted worker state, worker PATCH bodies or logs.
 *
 * Harness after cbm-experiment-withheld.test.ts (SDK `query` stubbed, options
 * captured); the backend factory is wrapped to capture the Codex env.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';
import * as realBootstrap from '../../src/cbm-bootstrap';
import * as realBackends from '../../src/backends/index.js';
import * as realSessionLogger from '../../src/session-logger';
import * as realEvidenceWriter from '../../src/evidence-writer';

const RUNNER_KEY = 'bld_runnerkey_session_abcdefghijklmnop';
const TOKEN_A = 'bldt_sessionA.sigA_abcdefghijklmnopqrstu';
const TOKEN_B = 'bldt_sessionB.sigB_abcdefghijklmnopqrstu';

let lastQueryOpts: any = null;
const allQueryOpts: any[] = [];
let mockMessages: any[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => {
    lastQueryOpts = opts;
    allQueryOpts.push(opts);
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

const mockUpdateWorker = mock(async (..._a: any[]) => ({}));
const mockClaimTask = mock(async () => ({ workers: [] as any[] }));
/** What mintTaskToken does next; set per test. */
let mintImpl: (taskId: string, ttlMs: number) => Promise<unknown> = async () => ({});
const mintCalls: Array<{ taskId: string; ttlMs: number }> = [];
const clientConfigs: any[] = [];

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    constructor(config: any) { clientConfigs.push(config); }
    updateWorker = mockUpdateWorker;
    claimTask = mockClaimTask;
    mintTaskToken = async (taskId: string, ttlMs: number) => {
      mintCalls.push({ taskId, ttlMs });
      return mintImpl(taskId, ttlMs);
    };
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

/** Everything written to disk (session logs, config files) — scanned for the token. */
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

/** Every per-worker session log entry (the file write itself is home-gated in tests). */
const sessionLogs: string[] = [];
mock.module('../../src/session-logger', () => ({
  ...realSessionLogger,
  sessionLog: (...a: any[]) => { sessionLogs.push(JSON.stringify(a)); },
}));

/** The per-worker redactor's secret list for each session (same channel as the key). */
const redactorSecrets: Array<Array<{ label: string; value: string }>> = [];
const realBuildWorkerSecretValues = realEvidenceWriter.buildWorkerSecretValues;
mock.module('../../src/evidence-writer', () => ({
  ...realEvidenceWriter,
  buildWorkerSecretValues: (...a: Parameters<typeof realBuildWorkerSecretValues>) => {
    const v = realBuildWorkerSecretValues(...a);
    redactorSecrets.push(v);
    return v;
  },
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

mock.module('../../src/cbm-bootstrap.js', () => ({
  ...realBootstrap,
  runCbmBootstrap: async () => ({ ok: true, durationMs: 1 }),
}));

/** Captured runStreamed opts per backend. The Codex backend is faked (no CLI). */
const backendRuns: Array<{ backend: string; env: Record<string, string> | undefined }> = [];
const realCreateBackend = realBackends.createBackend;
mock.module('../../src/backends/index.js', () => ({
  ...realBackends,
  createBackend: (backend: 'claude' | 'codex', config: any) => {
    if (backend === 'claude') {
      const inner = realCreateBackend(backend, config);
      return {
        runStreamed: (opts: any) => {
          backendRuns.push({ backend, env: opts.env });
          return inner.runStreamed(opts);
        },
      };
    }
    return {
      async *runStreamed(opts: any) {
        backendRuns.push({ backend, env: opts.env });
        yield { type: 'complete', summary: 'Done.' };
      },
    };
  },
}));

const { WorkerManager } = await import('../../src/workers');

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

function okMint(token: string) {
  return async (taskId: string) => ({ token, taskId, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
}

function makeTask(workerId: string, backend?: 'codex') {
  return {
    id: `task-${workerId}`,
    title: 'Agent token task',
    description: 'do a thing',
    workspaceId: 'ws-1',
    workspace: { name: 'test-workspace' },
    status: 'waiting',
    priority: 1,
    // No PR/artifact obligation, so the run is one session (no closing turn).
    outputRequirement: 'none',
    ...(backend ? { backend } : {}),
  };
}

async function runTask(manager: InstanceType<typeof WorkerManager>, workerId: string, backend?: 'codex') {
  mockMessages = [
    { type: 'system', subtype: 'init', session_id: `sess-${workerId}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', session_id: `sess-${workerId}` },
  ];
  const task = makeTask(workerId, backend);
  mockClaimTask.mockImplementation(async () => ({ workers: [{
    id: workerId,
    branch: `buildd/${workerId}`,
    worktreePath: '/tmp/test-workspace',
    task,
    ...(backend === 'codex' ? { codexCredential: { credentialType: 'api_key', apiKey: 'sk-test-codex', expiresAt: null } } : {}),
  }] }));
  await manager.claimAndStart(task as any);
  await new Promise(r => setTimeout(r, 250));
  return task;
}

function builddAuthHeader(): string | undefined {
  return lastQueryOpts?.options?.mcpServers?.buildd?.headers?.Authorization;
}

/** Everything the runner logged during the test. */
let logged: string[] = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };

describe('agent buildd MCP auth uses a per-task token', () => {
  let manager: InstanceType<typeof WorkerManager>;
  const savedEnv = process.env.BUILDD_AGENT_TASK_TOKEN;

  beforeEach(() => {
    lastQueryOpts = null;
    allQueryOpts.length = 0;
    mintCalls.length = 0;
    backendRuns.length = 0;
    diskWrites.length = 0;
    sessionLogs.length = 0;
    redactorSecrets.length = 0;
    savedWorkers.length = 0;
    mockUpdateWorker.mockClear();
    mintImpl = okMint(TOKEN_A);
    delete process.env.BUILDD_AGENT_TASK_TOKEN;
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
    if (savedEnv === undefined) delete process.env.BUILDD_AGENT_TASK_TOKEN;
    else process.env.BUILDD_AGENT_TASK_TOKEN = savedEnv;
  });

  function expectTokenNowhere(token: string) {
    for (const s of savedWorkers) expect(s).not.toContain(token);
    for (const call of mockUpdateWorker.mock.calls) expect(JSON.stringify(call)).not.toContain(token);
    for (const w of diskWrites) expect(w).not.toContain(token);
    for (const l of logged) expect(l).not.toContain(token);
    for (const l of sessionLogs) expect(l).not.toContain(token);
  }

  test('Claude: mcpServers.buildd carries the token; the runner client keeps its key', async () => {
    const task = await runTask(manager, 'w-tt-claude');
    // One mint per session start (this harness's run ends with a closing turn,
    // which is a second session), each for this task at the 12h max.
    expect(mintCalls.length).toBeGreaterThan(0);
    for (const c of mintCalls) expect(c).toEqual({ taskId: task.id, ttlMs: 12 * 60 * 60 * 1000 });
    expect(builddAuthHeader()).toBe(`Bearer ${TOKEN_A}`);
    // The runner's own calls (claim, PATCH, heartbeat) go through the client
    // built from the runner key.
    expect(clientConfigs.length).toBeGreaterThan(0);
    for (const c of clientConfigs) expect(c.apiKey).toBe(RUNNER_KEY);
    expect(mockUpdateWorker.mock.calls.length).toBeGreaterThan(0);
    // The token is not also handed to the agent some other way.
    const env = backendRuns.at(-1)?.env ?? {};
    expect(Object.values(env)).not.toContain(TOKEN_A);
    expect(sessionLogs.some(l => l.includes('agent_buildd_auth') && l.includes('source=task-token'))).toBe(true);
    // Redacted like the runner key: the per-worker redactor (milestones,
    // error traces, evidence, history archive, transcript upload) knows it.
    expect(redactorSecrets.length).toBeGreaterThan(0);
    for (const list of redactorSecrets) {
      expect(list.map(v => v.value)).toContain(TOKEN_A);
      expect(list.map(v => v.value)).toContain(RUNNER_KEY);
    }
    expectTokenNowhere(TOKEN_A);
  });

  test('Codex: BUILDD_MCP_BEARER_TOKEN is the token', async () => {
    await runTask(manager, 'w-tt-codex', 'codex');
    const run = backendRuns.find(r => r.backend === 'codex');
    expect(run).toBeDefined();
    expect(run!.env?.BUILDD_MCP_BEARER_TOKEN).toBe(TOKEN_A);
    expect(run!.env?.BUILDD_API_KEY).toBeUndefined();
    expectTokenNowhere(TOKEN_A);
  });

  const failures: Array<[string, () => Promise<unknown>]> = [
    ['network error', async () => { throw new TypeError('fetch failed'); }],
    ['401', async () => { throw Object.assign(new Error('x'), { status: 401 }); }],
    ['403', async () => { throw Object.assign(new Error('x'), { status: 403 }); }],
    ['404', async () => { throw Object.assign(new Error('x'), { status: 404 }); }],
    ['503', async () => { throw Object.assign(new Error('x'), { status: 503 }); }],
    ['malformed body', async () => ({ token: 'nope' })],
  ];
  for (const [name, impl] of failures) {
    test(`mint ${name} → session starts on the runner key with one warning per session`, async () => {
      mintImpl = impl;
      await runTask(manager, `w-tt-fail-${name.replace(/\W+/g, '')}`);
      expect(lastQueryOpts).not.toBeNull();
      expect(builddAuthHeader()).toBe(`Bearer ${RUNNER_KEY}`);
      expect(mintCalls.length).toBeGreaterThan(0);
      expect(logged.filter(l => l.includes('[agent-task-token]'))).toHaveLength(mintCalls.length);
    });
  }

  test('mint failure on Codex → BUILDD_MCP_BEARER_TOKEN falls back to the key', async () => {
    mintImpl = async () => { throw Object.assign(new Error('x'), { status: 503 }); };
    await runTask(manager, 'w-tt-codex-fail', 'codex');
    expect(backendRuns.find(r => r.backend === 'codex')!.env?.BUILDD_MCP_BEARER_TOKEN).toBe(RUNNER_KEY);
  });

  test('BUILDD_AGENT_TASK_TOKEN=0 → runner key, no mint call, no warning', async () => {
    process.env.BUILDD_AGENT_TASK_TOKEN = '0';
    await runTask(manager, 'w-tt-off');
    expect(mintCalls).toHaveLength(0);
    expect(builddAuthHeader()).toBe(`Bearer ${RUNNER_KEY}`);
    expect(logged.filter(l => l.includes('[agent-task-token]'))).toHaveLength(0);
  });

  test('re-mints on every session start (resume / follow-up)', async () => {
    const task = await runTask(manager, 'w-tt-resume');
    expect(builddAuthHeader()).toBe(`Bearer ${TOKEN_A}`);

    mintImpl = okMint(TOKEN_B);
    const mintsBefore = mintCalls.length;
    const queriesBefore = allQueryOpts.length;
    const worker = (manager as any).workers.get('w-tt-resume');
    expect(worker).toBeDefined();
    // Resume and follow-up both go through startSession with a resume id.
    await (manager as any).startSession(worker, '/tmp/test-workspace', task, 'sess-w-tt-resume');
    expect(mintCalls.length).toBeGreaterThan(mintsBefore);
    const resumed = allQueryOpts[queriesBefore];
    expect(resumed?.options?.resume).toBe('sess-w-tt-resume');
    expect(resumed.options.mcpServers.buildd.headers.Authorization).toBe(`Bearer ${TOKEN_B}`);
    expectTokenNowhere(TOKEN_A);
    expectTokenNowhere(TOKEN_B);
  });
});
