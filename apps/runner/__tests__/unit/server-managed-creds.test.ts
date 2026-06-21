/**
 * Tests for the "server-managed credentials" runner behaviour:
 *
 *   (a) A runner with NO local credentials still polls/claims — server-managed
 *       creds arrive inline on the claim response and bootstrap it. (Previously
 *       `claimPendingTasks` hard-returned [] when `!hasCredentials`.)
 *   (b) An auth failure pauses claims with EXPONENTIAL backoff and resumes after
 *       the backoff window; the cached server credential for the failing team is
 *       invalidated so a rotated/fixed credential is picked up promptly.
 *
 * The per-team credential cache + backoff math are covered as pure units in
 * credential-cache.test.ts; this file covers the WorkerManager wiring.
 */

import { describe, test, expect, mock, setDefaultTimeout } from 'bun:test';
import type { LocalUIConfig } from '../../src/types';

// CI runners are slower than local; give construction + async claim headroom.
setDefaultTimeout(30_000);

// ─── Mocks (must precede importing workers.ts) ──────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

// Controllable claim mock — tests set what the next claim returns.
let claimResult: any = { workers: [] };
const mockClaimTask = mock(async () => claimResult);
const mockUpdateWorker = mock(async () => ({}));
const mockSendHeartbeat = mock(async () => ({}));

mock.module('../../src/buildd', () => ({
  BuilddClient: class {
    claimTask = mockClaimTask;
    updateWorker = mockUpdateWorker;
    sendHeartbeat = mockSendHeartbeat;
    getWorkspaceConfig = async () => ({ configStatus: 'unconfigured' });
    getCompactObservations = async () => ({ markdown: '', count: 0 });
    searchObservations = async () => [];
    getBatchObservations = async () => [];
    createObservation = async () => ({});
    listWorkspaces = async () => [];
    runCleanup = async () => ({});
    searchFeedbackMemories = async () => [];
    getWorkerRemote = async () => null;
  },
}));

mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => null, // Force startFromClaim to bail early — we only test the gate.
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

// Complete fs mock (includes copyFileSync/rmSync so workers.ts's imports resolve).
mock.module('fs', () => ({
  existsSync: () => false,
  readFileSync: () => '{}',
  writeFileSync: () => {},
  mkdirSync: () => {},
  unlinkSync: () => {},
  renameSync: () => {},
  readdirSync: () => [],
  appendFileSync: () => {},
  copyFileSync: () => {},
  rmSync: () => {},
  statSync: () => ({ size: 0, mtimeMs: 0 }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadWorker: () => null,
  deleteWorker: () => {},
}));

mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));

// Stub the environment scan — the real one shells out to discover installed
// CLIs/tools (~1.5s) which is pure construction overhead irrelevant to these
// tests and a source of CI timeout flakiness.
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [], mcpServers: [] }),
  checkMcpPreFlight: async () => ({}),
}));

const { WorkerManager, teamKeyOf } = await import('../../src/workers');

function makeConfig(overrides?: Partial<LocalUIConfig>): LocalUIConfig {
  return {
    projectsRoot: '/tmp',
    builddServer: 'http://localhost:3000',
    apiKey: 'test-key',
    maxConcurrent: 2,
    model: 'claude-sonnet-4-5-20250929',
    serverless: false,
    ...overrides,
  } as LocalUIConfig;
}

describe('teamKeyOf', () => {
  test('prefers workspace.teamId, falls back to workspaceId, then "default"', () => {
    expect(teamKeyOf({ workspaceId: 'ws1', workspace: { name: 'x', teamId: 'team_9' } } as any)).toBe('team_9');
    expect(teamKeyOf({ workspaceId: 'ws1', workspace: { name: 'x' } } as any)).toBe('ws1');
    expect(teamKeyOf({ workspaceId: 'ws2' } as any)).toBe('ws2');
    expect(teamKeyOf(null)).toBe('default');
  });
});

describe('gate: poll even with no local credentials', () => {
  test('claimPendingTasks calls the claim endpoint when the runner has no local creds', async () => {
    const mgr: any = new WorkerManager(makeConfig());
    // Simulate a runner with zero local credentials.
    mgr.hasCredentials = false;
    claimResult = { workers: [] };
    mockClaimTask.mockClear();

    const result = await mgr.claimPendingTasks();

    // Gate must NOT short-circuit: the claim endpoint is hit so server-managed
    // creds can bootstrap the runner.
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  test('still respects acceptRemoteTasks=false', async () => {
    const mgr: any = new WorkerManager(makeConfig({ acceptRemoteTasks: false } as any));
    mgr.hasCredentials = false;
    mockClaimTask.mockClear();
    const result = await mgr.claimPendingTasks();
    expect(mockClaimTask).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('burn-loop guard: auth failure pauses + backs off + resumes', () => {
  test('handleAuthFailure pauses claims, escalates backoff, invalidates cache, then resumes', async () => {
    const mgr: any = new WorkerManager(makeConfig());
    mgr.hasCredentials = false;

    const teamKey = 'team_burn';
    // Seed a cached (now-known-bad) credential + worker bookkeeping.
    mgr.credCache.set(teamKey, { oauthToken: 'bad-token' });
    mgr.workerTeamKeys.set('w-1', teamKey);
    mgr.workerAuthContexts.set('w-1', 'account');
    expect(mgr.credCache.has(teamKey)).toBe(true);

    // First auth failure → paused, ~1 min backoff, cached cred invalidated.
    mgr.handleAuthFailure('w-1');
    expect(mgr.claimsPaused).toBe(true);
    expect(mgr.credCache.has(teamKey)).toBe(false); // invalidated on 401
    const firstUntil = mgr.claimsPausedUntil;
    const firstDelta = firstUntil - Date.now();
    expect(firstDelta).toBeGreaterThan(50_000);
    expect(firstDelta).toBeLessThanOrEqual(60_000 + 1000);

    // Paused → claims are skipped without hitting the endpoint.
    mockClaimTask.mockClear();
    const whilePaused = await mgr.claimPendingTasks();
    expect(whilePaused).toEqual([]);
    expect(mockClaimTask).not.toHaveBeenCalled();

    // Second consecutive auth failure → backoff escalates (~2 min).
    mgr.workerTeamKeys.set('w-2', teamKey);
    mgr.workerAuthContexts.set('w-2', 'account');
    mgr.handleAuthFailure('w-2');
    const secondDelta = mgr.claimsPausedUntil - Date.now();
    expect(secondDelta).toBeGreaterThan(firstDelta);

    // After the backoff window elapses, the breaker resets and claims resume.
    mgr.claimsPausedUntil = Date.now() - 1; // simulate window elapsed
    mockClaimTask.mockClear();
    claimResult = { workers: [] };
    const afterWindow = await mgr.claimPendingTasks();
    expect(mockClaimTask).toHaveBeenCalledTimes(1);
    expect(afterWindow).toEqual([]);
    expect(mgr.claimsPaused).toBe(false);
    expect(mgr.consecutiveAuthFailures).toBe(0); // reset on resume
  });
});
