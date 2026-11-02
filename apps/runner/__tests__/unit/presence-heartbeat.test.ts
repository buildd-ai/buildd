/**
 * A presence-connected runner beats on change and on the slow fallback ping,
 * not every minute (docs/specs/runner-heartbeat.md, "Presence channel").
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/presence-heartbeat.test.ts
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { tmpdir } from 'os';
import { initTestWorkspace, getTestWorkspace, cleanupTestWorkspace } from '../test-workspace';
import {
  LIVENESS_PING_INTERVAL_MS, RUNNER_FALLBACK_PING_MS, RUNNER_FALLBACK_PING_MIN_MS, fallbackPingDelayMs,
} from '@buildd/shared';
import type { LocalUIConfig } from '../../src/types';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() { return { async next() { return { value: undefined, done: true }; } }; },
  }),
}));

// A Pusher whose presence channel reports the join outcome the test sets.
let joinOutcome: 'pusher:subscription_succeeded' | 'pusher:subscription_error' = 'pusher:subscription_succeeded';
const subscribed: string[] = [];
const bound: Array<{ channel: string; event: string }> = [];
mock.module('pusher-js', () => ({
  default: class {
    connection = { state: 'connected', bind: () => {} };
    subscribe = (name: string) => {
      subscribed.push(name);
      return {
        bind: (event: string, cb: () => void) => {
          bound.push({ channel: name, event });
          if (name.includes('presence-') && event === joinOutcome) queueMicrotask(cb);
        },
        unbind_all: () => {}, unbind: () => {},
      };
    };
    unsubscribe = () => {}; disconnect = () => {};
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
    cachedGitRepos: () => [],
    getProjectRoots: () => [tmpdir()],
  }),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {}, loadAllWorkers: () => [], loadTerminalWorkersCached: () => [],
  __resetDiskWorkersCache: () => {}, loadWorker: () => null, deleteWorker: () => {}, activityAt: () => 0,
}));
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
process.env.KNOWLEDGE_INGEST_JOBS = '0';
process.env.BUILDD_SCOUT_HOST = '0';
process.env.BUILDD_MODEL_PROBE = '0';

const { WorkerManager } = await import('../../src/workers');
const { getPresenceState, __resetPresenceForTests } = await import('../../src/pusher-manager');

const realFetch = globalThis.fetch;
function fakeServer() {
  const reqs: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    reqs.push(u.pathname);
    let reply: unknown = {};
    if (u.pathname === '/api/workers/heartbeat') reply = { ok: true, viewerToken: 'v', pendingTaskCount: 0 };
    else if (u.pathname === '/api/accounts/me') reply = { id: 'acct1', name: 'a' };
    else if (u.pathname === '/api/workers/claim') reply = { workers: [], diagnostics: { reason: 'no_pending_tasks' } };
    else if (u.pathname === '/api/workspaces') reply = { workspaces: [] };
    const text = JSON.stringify(reply);
    return { ok: true, status: 200, headers: new Headers(), text: async () => text, json: async () => JSON.parse(text) };
  }) as any;
  return reqs;
}

describe('fallbackPingDelayMs', () => {
  test('is jittered inside the 10-15 minute window', () => {
    expect(fallbackPingDelayMs(() => 0)).toBe(RUNNER_FALLBACK_PING_MIN_MS);
    expect(fallbackPingDelayMs(() => 1)).toBe(RUNNER_FALLBACK_PING_MS);
    expect(fallbackPingDelayMs(() => 0.5)).toBeGreaterThan(RUNNER_FALLBACK_PING_MIN_MS);
    expect(RUNNER_FALLBACK_PING_MIN_MS).toBe(10 * 60_000);
    expect(RUNNER_FALLBACK_PING_MS).toBe(15 * 60_000);
  });
});

describe('liveness tick of a presence-connected runner', () => {
  let manager: any;
  let now = 1_000_000_000_000;
  afterEach(() => { manager?.destroy?.(); globalThis.fetch = realFetch; __resetPresenceForTests(); joinOutcome = 'pusher:subscription_succeeded'; });
  afterAll(() => cleanupTestWorkspace());

  async function start() {
    initTestWorkspace();
    const reqs = fakeServer();
    const intervals: Array<{ callback: () => void; ms: number }> = [];
    const realInterval = globalThis.setInterval;
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return realInterval(() => {}, 1_000_000);
    }) as typeof setInterval);
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const rnd = spyOn(Math, 'random').mockReturnValue(0.5); // a 12.5 minute fallback delay
    const restoreClock = { mockRestore: () => { clock.mockRestore(); rnd.mockRestore(); } };
    manager = new WorkerManager({
      projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 2,
      localUiUrl: 'http://localhost:8766', serverless: false, acceptRemoteTasks: true,
      pusherKey: 'key', pusherCluster: 'us2',
    } as LocalUIConfig);
    await Bun.sleep(50);
    timer.mockRestore();
    const tick = intervals.find(i => i.ms === LIVENESS_PING_INTERVAL_MS)!.callback;
    const beats = () => reqs.filter(p => p === '/api/workers/heartbeat').length;
    return { reqs, tick, beats, clock: restoreClock };
  }

  async function ticks(tick: () => void, minutes: number) {
    for (let i = 0; i < minutes; i++) { now += LIVENESS_PING_INTERVAL_MS; tick(); await Bun.sleep(3); }
  }

  test('joins its account presence channel and binds nothing else on it', async () => {
    const { clock } = await start();
    try {
      expect(subscribed).toContain('presence-runner-acct1');
      const presenceEvents = bound.filter(b => b.channel === 'presence-runner-acct1').map(b => b.event).sort();
      expect(presenceEvents).toEqual(['pusher:subscription_error', 'pusher:subscription_succeeded']);
      expect(getPresenceState()).toBe('subscribed');
    } finally { clock.mockRestore(); }
  });

  test('idle: no heartbeat between ticks until the fallback ping, then one per 10-15 minutes', async () => {
    const { tick, beats, clock } = await start();
    try {
      const atStart = beats();
      expect(atStart).toBe(1);
      await ticks(tick, 9);
      expect(beats()).toBe(atStart); // under the 10 minute minimum
      await ticks(tick, 4);
      expect(beats()).toBe(atStart + 1); // the fallback ping fell due at 12.5 minutes
      await ticks(tick, 9);
      expect(beats()).toBe(atStart + 1);
      await ticks(tick, 4);
      expect(beats()).toBe(atStart + 2); // and again 12.5 minutes after that
    } finally { clock.mockRestore(); }
  });

  test('a change in beat content sends at the next tick', async () => {
    const { tick, beats, clock } = await start();
    try {
      const before = beats();
      await ticks(tick, 2);
      expect(beats()).toBe(before);
      manager.config.maxConcurrent = 3; // slots are beat content
      await ticks(tick, 1);
      expect(beats()).toBe(before + 1);
      await ticks(tick, 2);
      expect(beats()).toBe(before + 1);
    } finally { clock.mockRestore(); }
  });

  test('a runner holding a worker keeps the 60s beat so its lease renews', async () => {
    const { tick, beats, clock } = await start();
    try {
      manager.workers.set('w1', { id: 'w1', status: 'working' });
      const before = beats();
      await ticks(tick, 3);
      expect(beats()).toBe(before + 3);
    } finally { manager.workers.delete('w1'); clock.mockRestore(); }
  });

  test('a refused presence join (older server) keeps the legacy 60s ping', async () => {
    joinOutcome = 'pusher:subscription_error';
    const { tick, beats, clock } = await start();
    try {
      expect(getPresenceState()).toBe('failed');
      const before = beats();
      await ticks(tick, 3);
      expect(beats()).toBe(before + 3);
    } finally { clock.mockRestore(); }
  });
});
