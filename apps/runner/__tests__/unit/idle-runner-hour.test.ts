/**
 * An hour of an idle runner (no tasks, no workers), counted at the server
 * (spec 3ef37387): heartbeats, its claim fallback on the task-poll tick and
 * nothing else. No list read, no worker read, and every heartbeat says the
 * same thing as the one before, so the server keeps the beat in Redis and
 * writes no row (apps/web/src/app/api/workers/heartbeat/route.ts). The
 * admin-only cleanup sweep, refused to this member key, is asked once.
 *
 * The runner itself reads no queue: `buildd top`'s Queue view does, through
 * the runner, conditionally (top-idle-hour.test.ts).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/idle-runner-hour.test.ts
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import { RUNNER_FALLBACK_PING_MIN_MS, RUNNER_HEARTBEAT_INTERVAL_MS } from '@buildd/shared';
import type { LocalUIConfig } from '../../src/types';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() { return { async next() { return { value: undefined, done: true }; } }; },
  }),
}));
mock.module('pusher-js', () => ({
  // The presence channel reports a successful join, as a healthy Pusher does.
  default: class { connection = { state: 'connected', bind: () => {} }; subscribe = () => ({ bind: (e: string, cb: () => void) => { if (e === 'pusher:subscription_succeeded') queueMicrotask(cb); }, unbind_all: () => {}, unbind: () => {} }); unsubscribe = () => {}; disconnect = () => {}; },
}));
mock.module('../../src/workspace', () => ({
  createWorkspaceResolver: () => ({
    resolve: () => getTestWorkspace(),
    debugResolve: () => ({}),
    listLocalDirectories: () => [],
    getPathOverrides: () => ({}),
    setPathOverride: () => {},
    scanGitRepos: () => [],
    cachedGitRepos: () => [],
    getProjectRoots: () => [tmpdir()],
  }),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadAllWorkers: () => [],
  loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {},
  loadWorker: () => null,
  deleteWorker: () => {},
  activityAt: () => 0,
}));
// No real browser launch probe: a browser found mid-hour is a real change (one row write), not this test's subject.
const realBrowser = await import('../../src/browser-capability');
mock.module('../../src/browser-capability', () => ({ ...realBrowser, rescanBrowserCapability: async (get: () => any) => get() }));
mock.module('../../src/skills.js', () => ({ syncSkillToLocal: async () => {} }));
mock.module('../../src/env-scan', () => ({
  scanEnvironment: () => ({ tools: [], envKeys: [], mcp: [] }),
  checkMcpPreFlight: () => ({ missing: [], warnings: [] }),
  parseMcpJson: () => [],
  scanMcpServersRich: () => [],
  checkBwrapSupport: () => true,
  checkBwrapMountIsolationSupport: () => true,
}));

// The idle-job pollers (knowledge ingest, Scout, model probe) are their own
// subjects; off here so the count is the runner loop's own.
process.env.KNOWLEDGE_INGEST_JOBS = '0';
process.env.BUILDD_SCOUT_HOST = '0';
process.env.BUILDD_MODEL_PROBE = '0';

const { WorkerManager } = await import('../../src/workers');

interface Req { method: string; path: string; body: any; conditional: boolean }
const realFetch = globalThis.fetch;

function fakeServer() {
  const reqs: Req[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    let body: any = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = init.body; }
    reqs.push({ method, path: u.pathname, body, conditional: new Headers(init.headers as Record<string, string>).has('if-none-match') });
    let status = 200;
    let reply: unknown = {};
    if (u.pathname === '/api/workers/heartbeat') reply = { ok: true, viewerToken: 'v', pendingTaskCount: 0, leasesRenewed: 0, claimsReleased: 0 };
    else if (u.pathname === '/api/accounts/me') reply = { id: 'acct1', name: 'a' };
    else if (u.pathname === '/api/workers/claim') reply = { workers: [], diagnostics: { reason: 'no_pending_tasks' } };
    else if (u.pathname === '/api/tasks/cleanup') { status = 401; reply = { error: 'Unauthorized - requires session auth or admin-level API token' }; }
    const text = JSON.stringify(reply);
    return { ok: status < 300, status, headers: new Headers(), text: async () => text, json: async () => JSON.parse(text) };
  }) as any;
  return reqs;
}

describe('an idle runner, for an hour', () => {
  let manager: any;
  afterEach(() => { manager?.destroy?.(); globalThis.fetch = realFetch; });
  afterAll(() => cleanupTestWorkspace());

  test('heartbeats and the claim fallback only; heartbeats unchanged beat to beat; cleanup asked once', async () => {
    initTestWorkspace();
    const reqs = fakeServer();
    const intervals: Array<{ callback: () => void; ms: number }> = [];
    const realInterval = globalThis.setInterval;
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return realInterval(() => {}, 1_000_000);
    }) as typeof setInterval);
    try {
      manager = new WorkerManager({
        projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 2,
        localUiUrl: 'http://localhost:8766', serverless: false, acceptRemoteTasks: true,
        pusherKey: 'key', pusherCluster: 'us2',
      } as LocalUIConfig);
      await Bun.sleep(50);

      // An hour of every timer the runner set, each fired as often as it would fire in an hour.
      const HOUR = 60 * 60_000;
      for (const { callback, ms } of intervals) {
        if (ms <= 0) continue;
        const times = Math.min(Math.floor(HOUR / ms), 720);
        // Let each slow timer's request settle before its next firing, as it would in an hour.
        for (let i = 0; i < times; i++) { callback(); if (ms >= 60_000) await Bun.sleep(2); }
        await Bun.sleep(5);
      }
      await Bun.sleep(100);
    } finally {
      timer.mockRestore();
    }

    const by = (path: string) => reqs.filter(r => r.path === path);
    const beats = by('/api/workers/heartbeat');
    const claims = by('/api/workers/claim');
    const cleanups = by('/api/tasks/cleanup');
    const other = reqs.filter(r => !['/api/workers/heartbeat', '/api/workers/claim', '/api/tasks/cleanup', '/api/accounts/me', '/api/workspaces'].includes(r.path));

    // Startup beat, the slow fallback ping (not a ping each minute), the task-poll tick.
    const expectedBeats = 1 + Math.ceil(3_600_000 / RUNNER_FALLBACK_PING_MIN_MS) + Math.floor(3_600_000 / RUNNER_HEARTBEAT_INTERVAL_MS);
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.length).toBeLessThanOrEqual(expectedBeats + 1);
    // Presence-connected and idle, the tick fires 60 times in the hour and sends none of them.
    expect(beats.length).toBeLessThanOrEqual(1 + Math.floor(3_600_000 / RUNNER_HEARTBEAT_INTERVAL_MS) + 1);
    // The claim fallback runs on the task-poll tick only (Pusher delivers work), plus the one startup claim.
    expect(claims.length).toBeLessThanOrEqual(1 + Math.max(1, Math.floor(3_600_000 / RUNNER_HEARTBEAT_INTERVAL_MS)));
    // Refused once (a member key), never asked again.
    expect(cleanups.length).toBeLessThanOrEqual(1);
    // Nothing else: no list read, no worker read, no memory read.
    expect(other.map(r => `${r.method} ${r.path}`)).toEqual([]);
    // Liveness only: every beat after the first says what the first said (the
    // claim handoff, which the server leaves out of its fingerprint, aside).
    const content = (b: any) => { const { claimHandoff: _h, ...rest } = b ?? {}; return JSON.stringify(rest); };
    const distinct = [...new Set(beats.map(b => content(b.body)))];
    if (distinct.length > 1) {
      const [a, b] = distinct.map(d => JSON.parse(d));
      const moved = Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      throw new Error(`heartbeat fields that moved between idle beats: ${moved.join(', ')} :: ${moved.map(k => JSON.stringify(a[k]) + ' -> ' + JSON.stringify(b[k])).join(' ; ')}`.slice(0, 2000));
    }
  });
});
