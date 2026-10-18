/**
 * `buildd top` end to end over a real (temp) runner socket: it draws what the
 * socket says, shows a pushed change without a key press (AC-2), relays an
 * answer to the socket's answer endpoint (AC-3's terminal half), and leaves the
 * terminal as it found it on q (R-7). Never touches ~/.buildd.
 */
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { serveRunnerSocket, type RunnerSocketServer } from '../../src/runner-socket';
import { OSC11_QUERY, createPalette, stripAnsi } from '../../src/terminal-palette';
import { EXIT_NOT_A_TERMINAL, EXIT_NO_RUNNER, IDLE_PAUSE_MS, LEAVE_SCREEN, MISSION_REFRESH_MS, TASK_EVENT_MIN_MS, TASK_REFRESH_MS, runTop, type TopTerminal } from '../../src/top/run';
import { TASKS, WORKERS } from './top-fixture';

let dir: string;
let sock: string;
let server: RunnerSocketServer | null = null;
let sse: ReadableStreamDefaultController<Uint8Array> | null = null;
const posts: Array<{ path: string; body: any }> = [];
let missionFetches = 0;
let taskFetches = 0;
let tasksServed = 0;
let serveMissions = false;
/** Hold /api/tasks and /api/missions/recent until this resolves (a slow server read). */
let slowReads: Promise<void> | null = null;
/** The next N task-list reads answer 429 (the server's read rate limit, passed through). */
let rateLimitTasks = 0;

function push(event: unknown) {
  sse?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'top-'));
  sock = join(dir, 'runner.sock');
  posts.length = 0;
  missionFetches = 0;
  taskFetches = 0;
  tasksServed = 0;
  serveMissions = false;
  slowReads = null;
  rateLimitTasks = 0;
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
      if (path === '/api/talk-context') return Response.json({ cwd: '/work/repo', server: 'https://buildd.example', apiKey: 'bld_secret', explain: null, mission: null });
      return Response.json({ error: 'Worker is not running' }, { status: 409 });
    }
    switch (path) {
      case '/api/runner': return Response.json({ pid: 4242, version: '0.340.0' });
      case '/api/config': return Response.json({ maxConcurrent: 3, builddServer: 'http://127.0.0.1:1' });
      case '/api/workers': return Response.json({ workers: WORKERS });
      case '/api/tasks':
        taskFetches++; if (slowReads) await slowReads;
        if (rateLimitTasks > 0) {
          rateLimitTasks--;
          return Response.json({ error: 'The server is rate limiting reads; retrying after 1s.', retryAfterSec: 1, tasks: [] }, { status: 429, headers: { 'Retry-After': '1' } });
        }
        tasksServed++; return Response.json({ tasks: TASKS });
      case '/api/workspaces': return Response.json({ workspaces: [
        { id: 'ws-a', name: 'alpha', teamId: 'team-1', teamName: 'Team One' },
        { id: 'ws-b', name: 'bravo', teamId: 'team-2', teamName: 'Team Two' },
      ] });
      case '/api/missions/recent':
        missionFetches++;
        if (slowReads) await slowReads;
        return Response.json({ missions: !serveMissions ? [] : [
          { id: 'm-quiet', title: 'Quiet mission', workspaceId: 'ws-b', status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: { step: 'building', waitingOn: null } },
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
  const deadline = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error('timed out');
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

  test('s hands the terminal to claude and takes it back (talk session)', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const ran: any[] = [];
    const done = runTop({
      socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false, openUrl: () => {}, env: {},
      talk: { loggedIn: async () => true, run: async (l) => { ran.push(l); t.writes.push('<<claude>>'); return 0; } },
    });
    await until(() => t.screen().includes('name override'));
    t.type('s');
    await until(() => ran.length === 1);
    expect(posts.at(-1)?.path).toBe('/api/talk-context');
    expect(ran[0].cwd).toBe('/work/repo');
    expect(ran[0].mode).toBe('suspend');
    // top left its screen before claude and came back after it.
    const i = t.writes.indexOf('<<claude>>');
    expect(t.writes.slice(0, i).some(w => w.includes('\x1b[?1049l'))).toBe(true);
    await until(() => t.writes.slice(i).some(w => w.includes('\x1b[?1049h')));
    expect(t.raw).toEqual([true, false, true]);
    await until(() => t.screen().includes('Back from Claude'));
    t.type('q');
    expect(await done).toBe(0);
  });

  test('s without a claude login says so in one line and opens nothing', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    let ran = 0;
    const done = runTop({
      socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false, openUrl: () => {}, env: {},
      talk: { loggedIn: async () => false, run: async () => { ran++; return 0; } },
    });
    await until(() => t.screen().includes('name override'));
    t.type('s');
    await until(() => t.screen().includes("Claude isn't logged in on this machine: run claude login"));
    expect(ran).toBe(0);
    expect(posts.some(p => p.path === '/api/talk-context')).toBe(false);
    t.type('q');
    await done;
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
    await until(() => t.screen().includes('Showing alpha (Team One).'));
    t.type('q');
    await done;
  });

  test('each mission timer refreshes missions even when its clock is slightly early', async () => {
    serveFakeRunner();
    const intervals: Array<{ callback: () => void; ms: number }> = [];
    const realInterval = globalThis.setInterval;
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return realInterval(() => {}, 1_000_000);
    }) as typeof setInterval);
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, palette: createPalette('night', 'none'), processHooks: false });
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      await until(() => intervals.length === 4 && missionFetches === 1);
      const now = Date.now();
      // The keyboard stays busy, so the idle pause never applies here.
      t.type('j');
      clock = spyOn(Date, 'now').mockReturnValue(now + MISSION_REFRESH_MS - 100);
      t.type('k');
      intervals[2].callback();
      await until(() => missionFetches === 2);
      clock.mockReturnValue(now + 2 * MISSION_REFRESH_MS - 200);
      t.type('j');
      intervals[2].callback();
      await until(() => missionFetches === 3);
    } finally {
      clock?.mockRestore();
      timer.mockRestore();
      t.type('q');
      await done;
    }
  });

  test('timers poll the server no faster than every 2 minutes (tasks) and 5 (missions)', () => {
    // Pushed events refetch sooner; the timers are only the backstop.
    expect(TASK_REFRESH_MS).toBeGreaterThanOrEqual(120_000);
    expect(MISSION_REFRESH_MS).toBeGreaterThanOrEqual(300_000);
    expect(TASK_EVENT_MIN_MS).toBeGreaterThanOrEqual(10_000);
    expect(IDLE_PAUSE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test('a burst of queue events refetches the task list once, after the event floor', async () => {
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, palette: createPalette('night', 'none'), processHooks: false, timing: { taskEventMinMs: 1_500 } });
    await until(() => taskFetches === 1 && sse !== null);
    for (let i = 0; i < 3; i++) { push({ type: 'task_assigned' }); await Bun.sleep(300); }
    // Without the floor each event would have refetched: 1 + 3.
    expect(taskFetches).toBe(1);
    await until(() => taskFetches === 2, 2_500);
    await Bun.sleep(400);
    expect(taskFetches).toBe(2);
    t.type('q');
    await done;
  });

  test('a 429 from the server holds task-list reads for Retry-After, says so, then catches up once', async () => {
    serveFakeRunner();
    rateLimitTasks = 1;
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, palette: createPalette('night', 'none'), processHooks: false, timing: { taskEventMinMs: 50 } });
    await until(() => taskFetches === 1 && sse !== null);
    await until(() => /rate limit/i.test(t.screen()));
    // Queue events during the hold do not ask again (no hot retry).
    for (let i = 0; i < 3; i++) { push({ type: 'task_assigned' }); await Bun.sleep(100); }
    expect(taskFetches).toBe(1);
    // After Retry-After, one catch-up read.
    await until(() => taskFetches === 2, 2_500);
    await until(() => t.screen().includes('name override'));
    t.type('q');
    await done;
  });

  test('left idle, top stops asking the server, says so, and catches up on the next key', async () => {
    serveFakeRunner();
    const intervals: Array<{ callback: () => void; ms: number }> = [];
    const realInterval = globalThis.setInterval;
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => {
      intervals.push({ callback, ms });
      return realInterval(() => {}, 1_000_000);
    }) as typeof setInterval);
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, palette: createPalette('night', 'none'), processHooks: false, timing: { idlePauseMs: 200 } });
    try {
      await until(() => intervals.length === 4 && taskFetches === 1 && missionFetches === 1 && sse !== null);
      await Bun.sleep(300);
      intervals[1].callback();
      intervals[2].callback();
      push({ type: 'task_assigned' });
      await Bun.sleep(400);
      intervals[0].callback();
      await until(() => /paused/i.test(t.screen()));
      expect(taskFetches).toBe(1);
      expect(missionFetches).toBe(1);
      t.type('j');
      await until(() => taskFetches === 2 && missionFetches === 2);
      await until(() => !/paused/i.test(t.screen()));
    } finally {
      timer.mockRestore();
      t.type('q');
      await done;
    }
  });

  test('lists the missions the server names, and never fetches them faster than the mission timer (R-24)', async () => {
    serveMissions = true;
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false });
    await until(() => t.screen().includes('Quiet mission'));
    expect(t.screen()).toContain('Team Two');
    expect(missionFetches).toBe(1);
    // A burst of queue events refetches the task list, not the missions.
    for (let i = 0; i < 3; i++) { push({ type: 'task_assigned' }); await Bun.sleep(300); }
    expect(missionFetches).toBe(1);
    t.type('q');
    await done;
  });

  test('t narrows to a team, and --team opens on one (R-23)', async () => {
    serveMissions = true;
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'h', palette: createPalette('night', 'none'), processHooks: false });
    await until(() => t.screen().includes('t team: all · w workspace: all'));
    t.type('t');
    await until(() => t.screen().includes('t team: Team One · w workspace: all'));
    t.type('q');
    await done;

    server?.stop();
    serveFakeRunner();
    const t2 = fakeTerminal();
    const done2 = runTop({ socketPath: sock, terminal: t2.term, hostname: 'h', team: 'team two', palette: createPalette('night', 'none'), processHooks: false });
    await until(() => t2.screen().includes('t team: Team Two · w workspace: all'));
    // The header draws before the first missions fetch lands; wait for it.
    await until(() => t2.screen().includes('Quiet mission'));
    expect(t2.screen()).toContain('Quiet mission');
    t2.type('q');
    await done2;
  });

  test('first load: says loading, then the stream fills the header while the task list is still loading', async () => {
    let release!: () => void;
    slowReads = new Promise<void>(r => { release = r; });
    serveFakeRunner();
    const t = fakeTerminal();
    const done = runTop({ socketPath: sock, terminal: t.term, hostname: 'test-host', palette: createPalette('night', 'none'), processHooks: false, openUrl: () => {} });

    await until(() => t.screen().length > 0);
    const first = t.screen().split('\n')[0];
    expect(first).not.toContain('reconnecting');
    // The event stream opens beside the snapshot: online with the real slots before the slow reads answer.
    await until(() => t.screen().split('\n')[0].includes('of 3 slots in use · ● online'));
    // Nothing has answered the task list yet: the header did not wait for it.
    expect(tasksServed).toBe(0);

    release();
    await until(() => tasksServed > 0);
    t.type('q');
    expect(await done).toBe(0);
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
