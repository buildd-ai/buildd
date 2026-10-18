/**
 * `buildd top`: the live terminal view of the runner on this machine (Living
 * Spec "Runner on your terminal", R-1..R-7).
 *
 * This file is the only impure part: it owns the terminal (alternate screen,
 * raw mode, cursor), the socket connection and the timers. Everything it draws
 * comes from renderFrame(state), and every key goes through handleKey(state).
 *
 * Updates are pushed: /api/events streams worker changes the moment the runner
 * has them, and a queue change the runner learns of (a task assigned over
 * Pusher, a task claimed in one of its workspaces, a refused claim, a worker
 * starting or finishing) refetches the task list, at most once per
 * TASK_EVENT_MIN_MS, and the queue while the Queue view is open. Timers are
 * only the backstop: every 2 minutes for tasks, 5 for missions. Left without a
 * key for IDLE_PAUSE_MS, top stops asking the server at all (each task-list
 * and missions read is a database read on the server) and says so; the next
 * key catches up. Pushed worker changes still draw meanwhile: they come from
 * the runner, not the server.
 */
import { hostname as osHostname } from 'os';
import { queryTerminalBackground, terminalPalette, type Palette } from '../terminal-palette';
import { probeRunnerSocket } from '../runner-socket';
import { socketClient, type SocketClient } from './client';
import { actionResultText, createKeyDecoder, handleKey, type Effect, type Key } from './keys';
import { renderFrame } from './render';
import { NOT_LOGGED_IN, buildTalkLaunch, claudeLoggedIn, runTalk, talkContext, talkWorkspaceId, type TalkLaunch, type TalkPayload } from './talk';
import { eventChangesQueue, initialState, reduce, type TopEvent, type TopState } from './state';

export const EXIT_NO_RUNNER = 1;
export const EXIT_NOT_A_TERMINAL = 64;

/** Never fetch the task list on a timer faster than this (R-4). */
export const TASK_REFRESH_MS = 120_000;
/** Never fetch the missions list faster than this (R-24). */
export const MISSION_REFRESH_MS = 300_000;
/** A queue event refetches the task list at most this often; a burst gets one trailing refetch. */
export const TASK_EVENT_MIN_MS = 10_000;
/** No key for this long and top stops reading from the server until the next key. */
export const IDLE_PAUSE_MS = 15 * 60_000;
const IDLE_STATUS = 'Updates paused while idle. Press any key to catch up.';
const RATE_LIMITED_PREFIX = 'The server is rate limiting reads;';
/** The Queue view's timer refresh (R-26); pushed queue events refetch it sooner. */
export const QUEUE_REFRESH_MS = 60_000;
/** Coalesce a burst of queue events into one refetch. */
const QUEUE_DEBOUNCE_MS = 250;
/** How long a lone ESC waits for the rest of a sequence before it counts as the escape key. */
const ESC_WAIT_MS = 50;

export const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J';
export const LEAVE_SCREEN = '\x1b[0m\x1b[?25h\x1b[?1049l';

export function noRunnerMessage(): string {
  return 'No buildd runner is running on this machine. Start one with: buildd service install (or buildd to run it in this terminal)';
}

export interface TopTerminal {
  stdin: NodeJS.ReadStream | { isTTY?: boolean; setRawMode?(on: boolean): unknown; on(ev: 'data', cb: (d: Buffer | string) => void): unknown; off?(ev: 'data', cb: (d: Buffer | string) => void): unknown; resume?(): unknown; pause?(): unknown; setEncoding?(e: string): unknown };
  stdout: { isTTY?: boolean; columns?: number; rows?: number; write(s: string): unknown; on?(ev: 'resize', cb: () => void): unknown; off?(ev: 'resize', cb: () => void): unknown };
}

export interface RunTopOptions {
  socketPath: string;
  missionId?: string | null;
  /** `--workspace <name or id>` (R-19). */
  workspace?: string | null;
  /** `--team <name>`: open on one team (R-23). */
  team?: string | null;
  /** Printed above nothing, before the view opens (the R-12 hand-off line). */
  notice?: string;
  terminal?: TopTerminal;
  client?: SocketClient;
  /** Fixed palette (tests). Without one, the terminal is asked for its background (R-17). */
  palette?: Palette;
  env?: Record<string, string | undefined>;
  hostname?: string;
  openUrl?: (url: string) => void;
  /** Seams for the talk session (tests): the login probe and the session itself. */
  talk?: {
    loggedIn?: () => Promise<boolean>;
    run?: (launch: Extract<TalkLaunch, { ok: true }>) => Promise<number>;
  };
  /** Register process-level exit hooks (off in tests). */
  processHooks?: boolean;
  /** Shorter floors (tests). */
  timing?: { taskEventMinMs?: number; idlePauseMs?: number };
}

function defaultOpenUrl(url: string) {
  const cmd = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch { /* the status line already shows the URL */ }
}

export async function runTop(opts: RunTopOptions): Promise<number> {
  const term: TopTerminal = opts.terminal ?? { stdin: process.stdin, stdout: process.stdout };
  if (!term.stdin.isTTY || !term.stdout.isTTY) {
    process.stderr.write('buildd top needs a terminal. For a script, read the runner socket directly (GET /api/workers).\n');
    return EXIT_NOT_A_TERMINAL;
  }

  if (!opts.client) {
    const probe = await probeRunnerSocket(opts.socketPath);
    if (probe.state !== 'live') {
      process.stderr.write(noRunnerMessage() + '\n');
      return EXIT_NO_RUNNER;
    }
  }
  const client = opts.client ?? socketClient(opts.socketPath);
  const openUrl = opts.openUrl ?? defaultOpenUrl;
  let palette: Palette = opts.palette ?? terminalPalette(opts.env ?? process.env, true);

  let state: TopState = initialState({ hostname: opts.hostname ?? osHostname(), missionId: opts.missionId, workspace: opts.workspace, team: opts.team });
  if (opts.notice) state = { ...state, status: { text: opts.notice, tone: 'info' } };
  let restored = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const abort = new AbortController();
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>(r => { resolveDone = r; });

  const restore = () => {
    if (restored) return;
    restored = true;
    try { term.stdin.setRawMode?.(false); } catch { /* not a tty any more */ }
    term.stdout.write(LEAVE_SCREEN);
  };

  // While a talk session owns the terminal, nothing is drawn or read here.
  let suspended = false;
  let talking = false;

  const draw = () => {
    renderTimer = null;
    if (restored || suspended) return;
    const cols = Math.max(40, term.stdout.columns ?? 80);
    const rows = Math.max(10, term.stdout.rows ?? 24);
    const lines = renderFrame(state, { cols, rows, now: Date.now(), palette });
    term.stdout.write('\x1b[H' + lines.map(l => l + palette.reset + '\x1b[K').join('\r\n'));
  };
  const scheduleDraw = () => { if (!renderTimer) renderTimer = setTimeout(draw, 16); };
  const dispatch = (event: TopEvent) => { state = reduce(state, event); scheduleDraw(); };

  // ── data ────────────────────────────────────────────────────────────────
  const taskEventMinMs = opts.timing?.taskEventMinMs ?? TASK_EVENT_MIN_MS;
  const idlePauseMs = opts.timing?.idlePauseMs ?? IDLE_PAUSE_MS;
  // Idle: no key for idlePauseMs. Server-backed reads stop until the next key.
  let lastInputAt = Date.now();
  let pausedIdle = false;
  const serverReadsAllowed = () => {
    if (Date.now() - lastInputAt < idlePauseMs) return true;
    if (!pausedIdle) {
      pausedIdle = true;
      dispatch({ type: 'status', status: { text: IDLE_STATUS, tone: 'info' } });
    }
    return false;
  };
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let tasksAt = 0;
  let tasksTrailing: ReturnType<typeof setTimeout> | null = null;
  // The server's read rate limit (a 429 the runner passes through with
  // retryAfterSec): no task-list read until then, and one catch-up read after.
  let tasksHeldUntil = 0;
  let tasksCatchUp: ReturnType<typeof setTimeout> | null = null;
  const refreshTasks = async () => {
    if (Date.now() < tasksHeldUntil) return;
    tasksAt = Date.now();
    try {
      const r = await client.get<{ tasks?: any[]; error?: string; retryAfterSec?: number }>('/api/tasks');
      if (r.status === 429) {
        const wait = Math.max(1, Number(r.body?.retryAfterSec) || 30);
        tasksHeldUntil = Date.now() + wait * 1000;
        dispatch({ type: 'status', status: { text: `${RATE_LIMITED_PREFIX} the task list refreshes in ${wait}s.`, tone: 'info' } });
        if (!tasksCatchUp) {
          tasksCatchUp = setTimeout(() => { tasksCatchUp = null; if (serverReadsAllowed()) void refreshTasks(); }, wait * 1000);
        }
        return;
      }
      if (r.status === 200 && state.status?.text.startsWith(RATE_LIMITED_PREFIX)) dispatch({ type: 'status', status: null });
      if (r.status === 200 && Array.isArray(r.body?.tasks)) dispatch({ type: 'tasks', tasks: r.body.tasks });
      else if (r.body?.error) dispatch({ type: 'status', status: { text: `Could not load the task list: ${r.body.error}`, tone: 'error' } });
    } catch { /* the stream's reconnect reports a dead socket */ }
  };
  // A queue event's refetch: at once when the last read is older than the
  // floor, else one trailing read when the floor passes.
  const refreshTasksSoon = () => {
    if (tasksTrailing || Date.now() < tasksHeldUntil) return;
    const wait = tasksAt + taskEventMinMs - Date.now();
    if (wait <= 0) { void refreshTasks(); return; }
    tasksTrailing = setTimeout(() => {
      tasksTrailing = null;
      if (serverReadsAllowed()) void refreshTasks();
    }, wait);
  };
  // The open and recently delivered missions of the runner's workspaces (R-24):
  // Event-triggered reads are throttled; the minute timer is its own cadence.
  let missionsAt = 0;
  const refreshMissions = async (timerTick = false) => {
    if (!timerTick && Date.now() - missionsAt < MISSION_REFRESH_MS) return;
    missionsAt = Date.now();
    try {
      const r = await client.get<{ missions?: any[] }>('/api/missions/recent');
      if (r.status === 200 && Array.isArray(r.body?.missions)) dispatch({ type: 'missions', missions: r.body.missions });
    } catch { /* the pane keeps the missions the task list names */ }
  };
  // The claim order for this runner (R-26): the Queue view, and the waiting
  // work the Missions view lists that the windowed task list leaves out.
  const refreshQueue = async () => {
    try {
      const r = await client.get<{ teams?: any[]; truncated?: boolean; error?: string }>('/api/queue');
      if (r.status === 200 && Array.isArray(r.body?.teams)) dispatch({ type: 'queue', queue: { teams: r.body.teams, truncated: !!r.body.truncated } });
      else if (state.view === 'queue' && r.body?.error) dispatch({ type: 'status', status: { text: `Could not load the queue: ${r.body.error}`, tone: 'error' } });
    } catch { /* the stream's reconnect reports a dead socket */ }
  };
  // Capacity, and the routes this machine's credentials give (R-39). Local
  // only (the runner answers from memory), so a finished run re-reads it: a
  // login that just failed shows as expired in the header.
  const configEvent = (body: any): TopEvent => ({
    type: 'config', maxConcurrent: body.maxConcurrent, builddServer: body.builddServer, routes: body.routes, routeProblems: body.routeProblems, loginMode: body.loginMode,
  });
  const refreshConfig = async () => {
    try {
      const r = await client.get('/api/config');
      if (r.status === 200 && r.body) dispatch(configEvent(r.body));
    } catch { /* the stream's reconnect reports a dead socket */ }
  };
  const queueChanged = () => {
    if (queueTimer) return;
    queueTimer = setTimeout(() => {
      queueTimer = null;
      void refreshConfig();
      if (!serverReadsAllowed()) return;
      if (state.view === 'missions') {
        refreshTasksSoon();
        void refreshMissions();
      } else if (state.view === 'queue') {
        void refreshQueue();
      }
    }, QUEUE_DEBOUNCE_MS);
  };

  // Workers the stream pushed since the running snapshot asked for its list:
  // the snapshot answer is older for those, so it keeps the pushed copy.
  let streamTouched: Set<string> | null = null;
  const loadSnapshot = async () => {
    const touched = new Set<string>();
    streamTouched = touched;
    const [runner, config, workers, workspaces] = await Promise.all([
      client.get('/api/runner').catch(() => null),
      client.get('/api/config').catch(() => null),
      // What top draws (live + recent, no output or tool payloads); an older
      // runner ignores the param and returns the full list, which still works.
      client.get('/api/workers?view=top').catch(() => null),
      client.get('/api/workspaces').catch(() => null),
    ]);
    if (workspaces?.status === 200 && Array.isArray(workspaces.body?.workspaces)) dispatch({ type: 'workspaces', workspaces: workspaces.body.workspaces });
    if (runner?.body) dispatch({ type: 'runner', pid: runner.body.pid, version: runner.body.version });
    if (config?.body) dispatch(configEvent(config.body));
    if (streamTouched === touched) streamTouched = null;
    if (workers?.status === 200 && Array.isArray(workers.body?.workers)) dispatch({ type: 'workers', workers: workers.body.workers, fresher: [...touched] });
    // The queue is not waited for: the first frame never holds for it.
    void refreshQueue();
    await Promise.all([refreshTasks(), refreshMissions()]);
  };

  const stream = async () => {
    let backoff = 1_000;
    while (!abort.signal.aborted) {
      try {
        await client.events((event) => {
          backoff = 1_000;
          if (eventChangesQueue(state, event)) queueChanged();
          if (streamTouched) {
            if (event.type === 'worker_update' && (event as any).worker?.id) streamTouched.add((event as any).worker.id);
            if (event.type === 'init') for (const w of (event as any).workers ?? []) if (w?.id) streamTouched.add(w.id);
          }
          dispatch(event);
        }, abort.signal);
      } catch { /* reconnect below */ }
      if (abort.signal.aborted) break;
      dispatch({ type: 'connection', online: false });
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10_000);
      // A restarted runner has new state: take a fresh snapshot, beside the reconnect.
      if (!abort.signal.aborted) void loadSnapshot().catch(() => {});
    }
  };

  // ── effects ─────────────────────────────────────────────────────────────
  const runEffect = async (effect: Effect) => {
    if (effect.type === 'quit') { finish(0); return; }
    if (effect.type === 'refreshQueue') { await refreshQueue(); return; }
    if (effect.type === 'talk') { await talk(effect); return; }
    if (effect.type === 'open' || effect.type === 'openMission' || effect.type === 'openRunner') {
      const server = state.runner.builddServer || 'https://buildd.dev';
      // The runner's page is where its workspaces are set (R-20).
      const path = effect.type === 'open' ? `/app/tasks/${effect.taskId}` : effect.type === 'openMission' ? `/app/missions/${effect.missionId}` : '/app/settings/runners';
      const url = `${server.replace(/\/$/, '')}${path}`;
      openUrl(url);
      dispatch({ type: 'status', status: { text: `Opened ${url}`, tone: 'ok' } });
      return;
    }
    let result: { status: number; body: unknown };
    try {
      if (effect.type === 'hold') {
        result = await client.post(effect.on ? '/api/hold' : '/api/resume', {});
        // The header changes now, not only when the runner's frame arrives (AC-17).
        const b = result.body as { hold?: unknown } | null;
        if (result.status >= 200 && result.status < 300 && b && typeof b === 'object' && 'hold' in b) {
          dispatch({ type: 'runner_hold', hold: (b.hold ?? null) as any });
        }
      } else if (effect.type === 'slots') {
        result = await client.post('/api/slots', effect.extras ? { slots: effect.slots, extras: effect.extras } : { slots: effect.slots });
        const b = result.body as { slots?: unknown } | null;
        if (result.status >= 200 && result.status < 300 && typeof b?.slots === 'number') dispatch({ type: 'slots', maxConcurrent: b.slots });
        // A lower that left extras running keeps its own line: it offers p (R-45).
        if (result.status >= 200 && result.status < 300 && !effect.extras && state.slotOffer?.slots === effect.slots) { queueChanged(); return; }
        if (result.status === 404) result = { status: 404, body: { error: 'the runner running now does not know slots yet (update it)' } };
      } else if (effect.type === 'logins') {
        result = await client.post('/api/logins', { mode: effect.mode });
        if (result.status === 404) result = { status: 404, body: { error: 'the runner running now does not know login modes yet (update it)' } };
      } else if (effect.type === 'claim') {
        result = await client.post('/api/claim', { taskId: effect.taskId });
      } else {
        const body = effect.message !== undefined ? { message: effect.message } : {};
        result = await client.post(`/api/workers/${encodeURIComponent(effect.workerId)}/${effect.action}`, body);
      }
    } catch (err: any) {
      result = { status: 0, body: { error: `the runner did not answer (${err?.message ?? err})` } };
    }
    dispatch({ type: 'status', status: actionResultText(effect, result) });
    if (effect.type === 'claim' || effect.type === 'hold' || effect.type === 'slots') queueChanged();
  };

  // `s`: an interactive claude session about a mission or task (talk.ts). It
  // runs on this machine's own claude login and shares its limits; a hold does
  // not stop it. With $TMUX set it opens beside top; otherwise top steps aside.
  const talk = async (effect: Extract<Effect, { type: 'talk' }>) => {
    const say = (text: string, tone: 'ok' | 'error' | 'info' = 'error') => dispatch({ type: 'status', status: { text, tone } });
    if (talking) { say('A Claude session is already open.'); return; }
    talking = true;
    try {
      if (!(await (opts.talk?.loggedIn ?? claudeLoggedIn)())) { say(NOT_LOGGED_IN); return; }
      const target = { kind: effect.kind, id: effect.id, title: effect.title };
      const r = await client.post('/api/talk-context', { kind: effect.kind, id: effect.id, workspaceId: talkWorkspaceId(state, target, Date.now()) });
      const payload = r.body as (TalkPayload & { error?: string }) | null;
      if (r.status !== 200 || !payload) { say(`Could not open Claude: ${payload?.error ?? 'the runner did not answer'}`); return; }
      const launch = buildTalkLaunch({
        context: talkContext(state, target, payload, Date.now()),
        loggedIn: true,
        cwd: payload.cwd,
        server: payload.server || state.runner.builddServer || 'https://buildd.dev',
        apiKey: payload.apiKey,
        mcpConfigPath: '',
        env: opts.env ?? process.env,
      });
      if (!launch.ok) { say(launch.message); return; }
      const run = opts.talk?.run ?? runTalk;
      if (launch.mode === 'tmux') {
        say('Claude is open in a split pane.', 'info');
        await run(launch);
        say('Claude closed.', 'info');
        return;
      }
      suspended = true;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      term.stdin.off?.('data', onData);
      try { term.stdin.setRawMode?.(false); } catch { /* not a tty any more */ }
      term.stdin.pause?.();
      term.stdout.write(LEAVE_SCREEN);
      try {
        await run(launch);
      } finally {
        term.stdout.write(ENTER_SCREEN);
        term.stdin.setRawMode?.(true);
        term.stdin.on('data', onData);
        term.stdin.resume?.();
        suspended = false;
        say('Back from Claude.', 'info');
        void refreshTasks();
        void refreshMissions();
      }
    } catch (err: any) {
      suspended = false;
      say(`Could not open Claude: ${err?.message ?? err}`);
    } finally {
      talking = false;
    }
  };

  // ── terminal ────────────────────────────────────────────────────────────
  // One decoder for the whole session: a terminal reply split across reads
  // (a late OSC 11 answer) is swallowed whole, never typed as keys.
  const decoder = createKeyDecoder();
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  const applyKeys = (keys: Key[]) => {
    for (const key of keys) {
      const r = handleKey(state, key, Date.now());
      state = r.state;
      for (const e of r.effects) void runEffect(e);
    }
    scheduleDraw();
  };
  const onData = (d: Buffer | string) => {
    lastInputAt = Date.now();
    if (pausedIdle) {
      pausedIdle = false;
      if (state.status?.text === IDLE_STATUS) dispatch({ type: 'status', status: null });
      void refreshTasks();
      void refreshMissions(true);
      if (state.view === 'queue') void refreshQueue();
    }
    if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    applyKeys(decoder.feed(typeof d === 'string' ? d : d.toString('utf8')));
    // A lone ESC is the escape key only once nothing follows it.
    if (decoder.pendingEscape()) escTimer = setTimeout(() => { escTimer = null; applyKeys(decoder.flush()); }, ESC_WAIT_MS);
  };
  const onResize = () => scheduleDraw();
  const onSignal = () => finish(0);
  const onCrash = (err: unknown) => {
    restore();
    process.stderr.write(`buildd top stopped: ${(err as any)?.stack ?? err}\n`);
    finish(1);
  };

  function finish(code: number) {
    if (abort.signal.aborted) return;
    abort.abort();
    for (const t of timers) clearInterval(t);
    if (renderTimer) clearTimeout(renderTimer);
    if (queueTimer) clearTimeout(queueTimer);
    if (tasksTrailing) clearTimeout(tasksTrailing);
    if (tasksCatchUp) clearTimeout(tasksCatchUp);
    if (escTimer) clearTimeout(escTimer);
    term.stdin.off?.('data', onData);
    term.stdin.pause?.();
    term.stdout.off?.('resize', onResize);
    if (opts.processHooks !== false) {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
      process.off('exit', restore);
    }
    restore();
    resolveDone(code);
  }

  if (opts.notice) term.stdout.write(opts.notice + '\n');
  term.stdout.write(ENTER_SCREEN);
  term.stdin.setEncoding?.('utf8');
  // R-17: ask the terminal for its background before the first frame, at most
  // 150 ms, so a light terminal with no COLORFGBG (VS Code) gets Day. The reply
  // is consumed there; keys typed meanwhile, and the start of a reply that came
  // too late, go through the session decoder below.
  let typedEarly = '';
  if (!opts.palette) {
    const { background, rest } = await queryTerminalBackground(term as any, undefined, { leaveRaw: true });
    palette = terminalPalette(opts.env ?? process.env, true, background);
    typedEarly = rest;
  }
  term.stdin.setRawMode?.(true);
  term.stdin.on('data', onData);
  term.stdin.resume?.();
  term.stdout.on?.('resize', onResize);
  if (opts.processHooks !== false) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    process.on('exit', restore);
  }

  if (typedEarly) onData(typedEarly);
  scheduleDraw();
  // Elapsed times move without any event; redraw (no fetch) once a second.
  timers.push(setInterval(scheduleDraw, 1_000));
  timers.push(setInterval(() => { if (serverReadsAllowed()) void refreshTasks(); }, TASK_REFRESH_MS));
  timers.push(setInterval(() => { if (serverReadsAllowed()) void refreshMissions(true); }, MISSION_REFRESH_MS));
  timers.push(setInterval(() => { if (state.view === 'queue' && serverReadsAllowed()) void refreshQueue(); }, QUEUE_REFRESH_MS));
  // The stream opens beside the snapshot, not after it: its init frame fills
  // the header (online, slots) while the slower task and mission reads load.
  void loadSnapshot().catch(() => {});
  void stream();

  return done;
}
