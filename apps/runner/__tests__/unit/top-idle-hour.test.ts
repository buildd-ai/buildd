/**
 * An hour of `buildd top` with nothing changing, counted at the server
 * (spec 3ef37387 AC-5): top's reads go through the runner's own BuilddClient,
 * as the runner's local routes do, and every request that reaches the server
 * is counted with whether it carried If-None-Match.
 *
 *   - Someone at the keyboard the whole hour: at most one server read a
 *     minute after the first load, and every repeat of a list read is
 *     conditional (answered 304 here, the server reading no rows).
 *   - Nobody at the keyboard: no server read at all once the idle pause starts.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/top-idle-hour.test.ts
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { BuilddClient } from '../../src/buildd';
import { readTaskListWithStages } from '../../src/mission-stages';
import { createPalette } from '../../src/terminal-palette';
import type { SocketClient } from '../../src/top/client';
import { FALLBACK_TICK_MS, IDLE_PAUSE_MS, runTop, type TopTerminal } from '../../src/top/run';
import type { LocalUIConfig } from '../../src/types';
import { TASKS } from './top-fixture';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface ServerRead { path: string; conditional: boolean; status: number }

/** The buildd server: a fixed ETag per list path, 304 when the reader sends it back. */
function fakeServer() {
  const reads: ServerRead[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname + u.search;
    const inm = new Headers(init?.headers as Record<string, string>).get('if-none-match');
    const etag = `W/"cv1-${u.pathname}"`;
    const listed = u.pathname !== '/api/workspaces';
    const status = listed && inm === etag ? 304 : 200;
    reads.push({ path: u.pathname, conditional: !!inm, status });
    let body: unknown = {};
    if (u.pathname === '/api/tasks') body = { tasks: TASKS, missionStages: {} };
    else if (u.pathname === '/api/missions/recent') body = { missions: [] };
    else if (u.pathname === '/api/workers/queue') body = { teams: [], truncated: false };
    else if (u.pathname === '/api/workspaces') body = { workspaces: [{ id: 'ws-a', name: 'alpha', teamId: 'team-1', teamName: 'Team One' }] };
    const text = status === 304 ? '' : JSON.stringify(body);
    return {
      ok: status === 200, status,
      headers: new Headers(listed ? { ETag: etag } : {}),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }) as any;
  return reads;
}

/** The runner's socket, answered as index.ts answers it, through a real BuilddClient. */
function runnerSocket(buildd: BuilddClient): SocketClient {
  return {
    async get(path: string) {
      const p = path.split('?')[0];
      switch (p) {
        case '/api/runner': return { status: 200, body: { pid: 1, version: 'test' } };
        case '/api/config': return { status: 200, body: { maxConcurrent: 1, builddServer: 'http://server.invalid' } };
        case '/api/workers': return { status: 200, body: { workers: [] } };
        case '/api/workspaces': return { status: 200, body: { workspaces: await buildd.listWorkspaces() } };
        case '/api/tasks': return { status: 200, body: { tasks: await readTaskListWithStages(buildd) } };
        case '/api/missions/recent': return { status: 200, body: { missions: await buildd.listRecentMissions() } };
        case '/api/queue': return { status: 200, body: await buildd.listQueue({}) };
      }
      return { status: 404, body: { error: 'not found' } };
    },
    async post() { return { status: 404, body: {} }; },
    events(onEvent, signal) {
      onEvent({ type: 'init', workers: [] });
      return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()));
    },
  };
}

function fakeTerminal() {
  let onData: ((d: string) => void) | null = null;
  const term: TopTerminal = {
    stdin: { isTTY: true, setRawMode: () => {}, on: (_e: 'data', cb: (d: any) => void) => { onData = cb; }, off: () => { onData = null; }, resume: () => {}, pause: () => {}, setEncoding: () => {} },
    stdout: { isTTY: true, columns: 100, rows: 30, write: () => {} },
  };
  return { term, type: (s: string) => onData?.(s) };
}

async function until(cond: () => boolean, ms = 2_000) {
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error('timed out');
    await Bun.sleep(5);
  }
}

/** Run top for an hour of fallback ticks; `typing` presses a key before each one. */
async function idleHour(typing: boolean) {
  const reads = fakeServer();
  const buildd = new BuilddClient({ projectsRoot: '/tmp', builddServer: 'http://server.invalid', apiKey: 'k', maxConcurrent: 1 } as LocalUIConfig);
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const realInterval = globalThis.setInterval;
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
    intervals.push({ callback, ms });
    return realInterval(() => {}, 1_000_000);
  }) as typeof setInterval);
  const start = Date.now();
  let now = start;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const t = fakeTerminal();
  const done = runTop({ socketPath: '/nonexistent', client: runnerSocket(buildd), terminal: t.term, palette: createPalette('night', 'none'), processHooks: false });
  try {
    await until(() => intervals.length === 2 && reads.some(r => r.path === '/api/tasks') && reads.some(r => r.path === '/api/missions/recent'));
    await Bun.sleep(20);
    const firstLoad = reads.length;
    const tick = intervals.find(i => i.ms === FALLBACK_TICK_MS)!;
    for (let minute = 1; minute <= 60; minute++) {
      now = start + minute * FALLBACK_TICK_MS;
      if (typing) t.type(minute % 2 ? 'j' : 'k');
      tick.callback();
      await Bun.sleep(5);
    }
    await Bun.sleep(20);
    return { firstLoad, reads, after: reads.slice(firstLoad) };
  } finally {
    clock.mockRestore();
    timer.mockRestore();
    t.type('q');
    await done;
  }
}

describe('buildd top, an hour with nothing changing', () => {
  test('someone at the keyboard: at most one server read a minute, every repeat conditional', async () => {
    const { firstLoad, after } = await idleHour(true);
    // First load: the task list (with its stages), the missions, the queue, the workspaces.
    expect(firstLoad).toBeLessThanOrEqual(4);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThanOrEqual(60);
    // Every read after the first load is a list read the server already answered once: conditional, and 304.
    expect(after.every(r => r.conditional)).toBe(true);
    expect(after.every(r => r.status === 304)).toBe(true);
    // One read carries the task list and its stages: no separate stages read.
    expect(after.some(r => r.path === '/api/missions/stages')).toBe(false);
  });

  test('nobody at the keyboard: no server read once the idle pause starts', async () => {
    const { after } = await idleHour(false);
    const pauseTicks = Math.ceil(IDLE_PAUSE_MS / FALLBACK_TICK_MS);
    // Reads only in the minutes before the pause; none in the 45 after it.
    expect(after.length).toBeLessThanOrEqual(pauseTicks);
    expect(after.every(r => r.conditional)).toBe(true);
  });
});
