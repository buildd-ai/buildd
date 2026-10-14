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
import { OSC11_QUERY, createPalette, stripAnsi } from '../../src/terminal-palette';
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
      case '/api/workspaces': return Response.json({ workspaces: [
        { id: 'ws-a', name: 'alpha', teamId: 'team-1' },
        { id: 'ws-b', name: 'bravo', teamId: 'team-1' },
      ] });
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

/** osc11Reply: the whole answer 5 ms after the query, or [delay ms, chunk] reads. */
function fakeTerminal(tty = true, osc11Reply: string | Array<[number, string]> | null = null) {
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
    stdout: {
      isTTY: tty, columns: 80, rows: 24,
      write: (s: string) => {
        writes.push(s);
        if (s === OSC11_QUERY && osc11Reply !== null) {
          const chunks: Array<[number, string]> = typeof osc11Reply === 'string' ? [[5, osc11Reply]] : osc11Reply;
          for (const [ms, chunk] of chunks) setTimeout(() => onData?.(chunk), ms);
        }
      },
    },
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

  test('asks the terminal for its background before the first frame: white means Day (R-17, AC-6)', async () => {
    serveFakeRunner();
    const t = fakeTerminal(true, '\x1b]11;rgb:ffff/ffff/ffff\x07');
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', env: { COLORTERM: 'truecolor' }, processHooks: false });
    await until(() => t.screen().includes('name override'));
    const q = t.writes.indexOf(OSC11_QUERY);
    const firstFrame = t.writes.findIndex(w => w.startsWith('\x1b[H'));
    expect(q).toBeGreaterThan(-1);
    expect(q).toBeLessThan(firstFrame);
    const frame = t.writes[firstFrame];
    expect(frame).toContain('\x1b[38;2;107;101;92m'); // Day muted
    expect(frame).not.toContain('\x1b[38;2;237;232;226m name override'); // never Night text
    // The reply never reached the key handler: no filter prompt, no status.
    expect(t.screen()).not.toContain('filter ›');
    t.type('q');
    expect(await done).toBe(0);
  });

  test('a terminal that never answers costs at most the timeout, then Night', async () => {
    serveFakeRunner();
    const t = fakeTerminal(true, null);
    const start = Date.now();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', env: { COLORTERM: 'truecolor' }, processHooks: false });
    await until(() => t.writes.some(w => w.startsWith('\x1b[H')));
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(t.writes.find(w => w.startsWith('\x1b[H'))).toContain('\x1b[38;2;168;159;150m'); // Night muted
    t.type('q');
    await done;
  });

  // A late reply, split over two reads, must never reach the key handler: the
  // c's of rgb:cccc would claim the waiting task, the / would open the filter.
  const LATE = '\x1b]11;rgb:cccc/cccc/cccc\x07';
  const splits: Array<[string, Array<[number, string]>]> = [
    ['both halves after the timeout', [[220, LATE.slice(0, 14)], [240, LATE.slice(14)]]],
    ['tail of c after the timeout', [[220, LATE.slice(0, LATE.length - 2)], [240, LATE.slice(-2)]]],
    ['first half inside the probe window, rest after it', [[5, LATE.slice(0, 9)], [220, LATE.slice(9)]]],
    ['split right after ESC, after the timeout', [[220, LATE.slice(0, 1)], [222, LATE.slice(1)]]],
  ];
  for (const [name, chunks] of splits) {
    test(`a late OSC 11 reply split over two reads fires no key: ${name}`, async () => {
      serveFakeRunner();
      const t = fakeTerminal(true, chunks);
      const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', env: {}, processHooks: false, openUrl: () => {} });
      await until(() => t.screen().includes('name override'));
      await Bun.sleep(320);
      expect(posts).toEqual([]);
      const screen = t.screen();
      expect(screen).not.toContain('filter ›');
      expect(screen).not.toContain('Claiming');
      expect(screen).not.toContain('nothing to claim');
      expect(screen).not.toContain('Pick a task first');
      t.type('q');
      expect(await done).toBe(0);
    });
  }

  test('the header names the workspaces, and w switches', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false });
    await until(() => t.screen().includes('2 workspaces'));
    t.type('w');
    await until(() => t.screen().includes('Showing alpha.'));
    t.type('q');
    await done;
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
