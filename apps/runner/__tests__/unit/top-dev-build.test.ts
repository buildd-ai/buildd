/**
 * The dev build of top (`buildd top --dev`) says so in its header, and it
 * works against a production runner that does not have every route the dev
 * top asks for: an older runner answers those with a plain-text 404, and top
 * must draw what it has without an error line. Never touches ~/.buildd.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { initialState, reduce } from '../../src/top/state';
import { frameOnce } from '../../src/top/frame';
import { devBuildFromEnv, runTop, type TopTerminal } from '../../src/top/run';
import { socketClient } from '../../src/top/client';
import { NOW, WORKERS, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const DEV = { channel: 'dev' as const, sha: 'abc1234', stale: false, notice: null };

describe('devBuildFromEnv', () => {
  test('null for the production top', () => {
    expect(devBuildFromEnv({})).toBeNull();
    expect(devBuildFromEnv({ BUILDD_TOP_BUILD: 'abc1234' })).toBeNull();
  });
  test('the dev channel, its commit, and whether it is stale', () => {
    expect(devBuildFromEnv({ BUILDD_TOP_CHANNEL: 'dev', BUILDD_TOP_BUILD: 'abc1234' })).toEqual(DEV);
    expect(devBuildFromEnv({ BUILDD_TOP_CHANNEL: 'dev', BUILDD_TOP_BUILD: 'abc1234', BUILDD_TOP_STALE: '1', BUILDD_TOP_NOTICE: 'Could not update the dev build' }))
      .toEqual({ channel: 'dev', sha: 'abc1234', stale: true, notice: 'Could not update the dev build' });
  });
});

describe('the header names the dev build', () => {
  const withBuild = (build: typeof DEV | null) => ({ ...fixtureState(), build });

  test.each([120, 80, 50])('"buildd dev abc1234" at %i columns, every line still the terminal width', (cols) => {
    const lines = renderFrame(withBuild(DEV), { cols, rows: 24, now: NOW, palette: plain }).map(l => stripAnsi(l));
    expect(lines[0]).toStartWith(' buildd dev abc1234');
    for (const l of lines) expect(textWidth(l)).toBe(cols);
  });

  test('a stale dev build says stale', () => {
    const lines = renderFrame(withBuild({ ...DEV, stale: true }), { cols: 120, rows: 24, now: NOW, palette: plain });
    expect(stripAnsi(lines[0])).toStartWith(' buildd dev abc1234 (stale)');
  });

  test('the production top is unchanged', () => {
    const prod = renderFrame(fixtureState(), { cols: 120, rows: 24, now: NOW, palette: plain });
    expect(renderFrame(withBuild(null), { cols: 120, rows: 24, now: NOW, palette: plain })).toEqual(prod);
    expect(stripAnsi(prod[0])).not.toContain(' dev ');
  });

  test('initialState carries the build', () => {
    expect(initialState({ hostname: 'h', build: DEV }).build).toEqual(DEV);
    expect(initialState({ hostname: 'h' }).build).toBeNull();
    // A reducer step keeps it.
    expect(reduce(initialState({ hostname: 'h', build: DEV }), { type: 'connection', online: true }).build).toEqual(DEV);
  });
});

// A production runner older than the dev top: the reads every runner has, and
// a plain-text 404 for everything newer (the socket's catch-all).
let dir: string | null = null;
let server: RunnerSocketServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const OLD_RUNNER_ROUTES = new Set(['/api/runner', '/api/config', '/api/workers', '/api/events']);
const asked = new Set<string>();

function serveOlderRunner(): string {
  dir = mkdtempSync(join(tmpdir(), 'top-dev-old-'));
  const sock = join(dir, 'runner.sock');
  server = serveRunnerSocket(sock, (req) => {
    const path = new URL(req.url).pathname;
    asked.add(path);
    if (!OLD_RUNNER_ROUTES.has(path) || req.method !== 'GET') return new Response('Not found', { status: 404 });
    switch (path) {
      case '/api/runner': return Response.json({ pid: 4242, version: '0.300.0' });
      case '/api/config': return Response.json({ maxConcurrent: 3, builddServer: 'http://127.0.0.1:1' });
      case '/api/workers': return Response.json({ workers: WORKERS });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'init', workers: [] })}\n\n`)); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return sock;
}

describe('against a production runner without the newer routes', () => {
  test('one frame draws the workers and the dev label, with no error line', async () => {
    const sock = serveOlderRunner();
    const lines = (await frameOnce({ socketPath: sock, client: socketClient(sock), hostname: 'h', cols: 100, rows: 30, now: NOW, initTimeoutMs: 1_000, build: DEV })).map(l => stripAnsi(l));
    const screen = lines.join('\n');
    expect(lines[0]).toStartWith(' buildd dev abc1234');
    expect(screen).toContain('name override');
    expect(screen).not.toMatch(/Could not|Not found|HTTP 404/);
    // It did ask for the routes this runner lacks.
    for (const p of ['/api/tasks', '/api/missions/recent', '/api/queue', '/api/workspaces']) expect(asked.has(p)).toBe(true);
  });

  test('the live view draws, stays error-free on the queue view, and quits cleanly', async () => {
    const sock = serveOlderRunner();
    const writes: string[] = [];
    let onData: ((d: string) => void) | null = null;
    const term: TopTerminal = {
      stdin: { isTTY: true, setRawMode: () => {}, on: (_e: 'data', cb: (d: any) => void) => { onData = cb; }, off: () => { onData = null; }, resume: () => {}, pause: () => {}, setEncoding: () => {} },
      stdout: { isTTY: true, columns: 100, rows: 30, write: (s: string) => { writes.push(s); } },
    };
    const screen = () => {
      const last = [...writes].reverse().find(w => w.startsWith('\x1b[H'));
      return last ? stripAnsi(last).replace(/\x1b\[K/g, '') : '';
    };
    const until = async (cond: () => boolean, ms = 3_000) => {
      const end = performance.now() + ms;
      while (!cond()) { if (performance.now() > end) throw new Error(`timed out; screen:\n${screen()}`); await Bun.sleep(10); }
    };
    const done = runTop({ socketPath: sock, terminal: term, hostname: 'h', palette: plain, processHooks: false, openUrl: () => {}, env: {}, build: DEV });
    await until(() => screen().includes('name override') && screen().includes('● online'));
    expect(screen()).toContain('buildd dev abc1234');
    expect(screen()).not.toMatch(/Could not|Not found|HTTP 404/);
    onData!('\t');
    await Bun.sleep(200);
    expect(screen()).not.toMatch(/Could not|Not found|HTTP 404/);
    onData!('q');
    expect(await done).toBe(0);
  });
});
