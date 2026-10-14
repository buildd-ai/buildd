/**
 * `buildd top` end to end over a real (temp) runner socket: it draws what the
 * socket says, shows a pushed change without a key press (AC-2), relays an
 * answer to the socket's answer endpoint (AC-3's terminal half), and leaves the
 * terminal as it found it on q (R-7). Never touches ~/.buildd.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { EXIT_NOT_A_TERMINAL, EXIT_NO_RUNNER, LEAVE_SCREEN, runTop, type TopTerminal } from '../../src/top/run';
import { TASKS, WORKERS } from './top-fixture';

let dir: string;
let sock: string;
let server: RunnerSocketServer | null = null;
let sse: ReadableStreamDefaultController<Uint8Array> | null = null;
const posts: Array<{ path: string; body: any }> = [];

function push(event: unknown) {
  sse?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'top-'));
  sock = join(dir, 'runner.sock');
  posts.length = 0;
  sse = null;
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function serveFakeRunner() {
  server = serveRunnerSocket(sock, async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      posts.push({ path, body });
      if (path === '/api/workers/w-hint/answer') return Response.json({ ok: true });
      return Response.json({ error: 'Worker is not running' }, { status: 409 });
    }
    switch (path) {
      case '/api/runner': return Response.json({ pid: 4242, version: '0.340.0' });
      case '/api/config': return Response.json({ maxConcurrent: 3, builddServer: 'http://127.0.0.1:1' });
      case '/api/workers': return Response.json({ workers: WORKERS });
      case '/api/tasks': return Response.json({ tasks: TASKS });
      case '/api/events':
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            sse = c;
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'init', workers: [] })}\n\n`));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('Not found', { status: 404 });
  });
}

function fakeTerminal(tty = true) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  let onData: ((d: string) => void) | null = null;
  const term: TopTerminal = {
    stdin: {
      isTTY: tty,
      setRawMode: (on: boolean) => { raw.push(on); },
      on: (_ev: 'data', cb: (d: any) => void) => { onData = cb; },
      off: () => { onData = null; },
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
    },
    stdout: { isTTY: tty, columns: 80, rows: 24, write: (s: string) => { writes.push(s); } },
  };
  return {
    term,
    writes,
    raw,
    type: (s: string) => onData?.(s),
    /** The last full frame drawn, as plain text. */
    screen: () => {
      const last = [...writes].reverse().find(w => w.startsWith('\x1b[H'));
      return last ? stripAnsi(last).replace(/\x1b\[K/g, '') : '';
    },
  };
}

async function until(cond: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

describe('runTop', () => {
  test('draws, takes a pushed change within 2 s, relays an answer, restores the terminal on q', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'test-host', palette: createPalette('night', 'none'), processHooks: false, openUrl: () => {} });

    await until(() => t.screen().includes('name override') && t.screen().includes('● online'));
    expect(t.raw).toEqual([true]);
    expect(t.writes[0]).toContain('\x1b[?1049h');

    // AC-2: a claim on the runner shows up without a key press.
    const pushedAt = Date.now();
    push({ type: 'worker_update', worker: { id: 'w-new', taskId: 't-top', taskTitle: 'buildd top', status: 'working', startedAt: Date.now(), currentAction: 'Read run.ts' } });
    await until(() => t.screen().includes('Read run.ts'));
    expect(Date.now() - pushedAt).toBeLessThan(2_000);

    // a on the asking row: rows are name override, installer hint, ...
    t.type('\x1b[B');
    t.type('a');
    t.type('Print the URL');
    t.type('\r');
    await until(() => posts.length === 1);
    expect(posts[0]).toEqual({ path: '/api/workers/w-hint/answer', body: { message: 'Print the URL' } });
    await until(() => t.screen().includes('Answer sent to "installer hint"'));

    // A refusal shows the runner/server reason.
    t.type('\x1b[A');
    t.type('p');
    await until(() => t.screen().includes('Pause refused: Worker is not running (HTTP 409)'));

    t.type('q');
    expect(await done).toBe(0);
    expect(t.writes.at(-1)).toBe(LEAVE_SCREEN);
    expect(LEAVE_SCREEN).toContain('\x1b[?25h');
    expect(LEAVE_SCREEN).toContain('\x1b[?1049l');
    expect(t.raw).toEqual([true, false]);
  });

  test('ctrl-c restores the terminal too', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false });
    await until(() => t.screen().includes('MISSIONS'));
    t.type('\x03');
    expect(await done).toBe(0);
    expect(t.writes.at(-1)).toBe(LEAVE_SCREEN);
    expect(t.raw.at(-1)).toBe(false);
  });

  test('the R-12 notice is shown in the status line', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false, notice: 'The background runner is already running (pid 4242).' });
    await until(() => t.screen().includes('The background runner is already running (pid 4242).'));
    t.type('q');
    await done;
  });

  test('no runner: one line naming the command, non-zero, terminal untouched (R-1)', async () => {
    const t = fakeTerminal();
    expect(await runTop({ socketPath: sock, terminal: t.term, processHooks: false })).toBe(EXIT_NO_RUNNER);
    expect(t.writes).toEqual([]);
    expect(t.raw).toEqual([]);
  });

  test('not a terminal: refused', async () => {
    const t = fakeTerminal(false);
    expect(await runTop({ socketPath: sock, terminal: t.term, processHooks: false })).toBe(EXIT_NOT_A_TERMINAL);
  });
});
