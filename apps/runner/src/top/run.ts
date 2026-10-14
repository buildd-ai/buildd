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
 * Pusher, a refused claim, a worker starting or finishing) refetches the task
 * list. The only timer that fetches is the once-a-minute task list refresh.
 */
import { hostname as osHostname } from 'os';
import { queryTerminalBackground, terminalPalette, type Palette } from '../terminal-palette';
import { probeRunnerSocket } from '../runner-socket';
import { socketClient, type SocketClient } from './client';
import { actionResultText, handleKey, parseKeys, type Effect } from './keys';
import { renderFrame } from './render';
import { eventChangesQueue, initialState, reduce, type TopEvent, type TopState } from './state';

export const EXIT_NO_RUNNER = 1;
export const EXIT_NOT_A_TERMINAL = 64;

/** Never fetch the task list on a timer faster than this (R-4). */
export const TASK_REFRESH_MS = 60_000;
/** Coalesce a burst of queue events into one refetch. */
const QUEUE_DEBOUNCE_MS = 250;

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
  /** Printed above nothing, before the view opens (the R-12 hand-off line). */
  notice?: string;
  terminal?: TopTerminal;
  client?: SocketClient;
  /** Fixed palette (tests). Without one, the terminal is asked for its background (R-17). */
  palette?: Palette;
  env?: Record<string, string | undefined>;
  hostname?: string;
  openUrl?: (url: string) => void;
  /** Register process-level exit hooks (off in tests). */
  processHooks?: boolean;
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

  let state: TopState = initialState({ hostname: opts.hostname ?? osHostname(), missionId: opts.missionId, workspace: opts.workspace });
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

  const draw = () => {
    renderTimer = null;
    if (restored) return;
    const cols = Math.max(40, term.stdout.columns ?? 80);
    const rows = Math.max(10, term.stdout.rows ?? 24);
    const lines = renderFrame(state, { cols, rows, now: Date.now(), palette });
    term.stdout.write('\x1b[H' + lines.map(l => l + palette.reset + '\x1b[K').join('\r\n'));
  };
  const scheduleDraw = () => { if (!renderTimer) renderTimer = setTimeout(draw, 16); };
  const dispatch = (event: TopEvent) => { state = reduce(state, event); scheduleDraw(); };

  // ── data ────────────────────────────────────────────────────────────────
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshTasks = async () => {
    try {
      const r = await client.get<{ tasks?: any[]; error?: string }>('/api/tasks');
      if (r.status === 200 && Array.isArray(r.body?.tasks)) dispatch({ type: 'tasks', tasks: r.body.tasks });
      else if (r.body?.error) dispatch({ type: 'status', status: { text: `Could not load the task list: ${r.body.error}`, tone: 'error' } });
    } catch { /* the stream's reconnect reports a dead socket */ }
  };
  const queueChanged = () => {
    if (queueTimer) return;
    queueTimer = setTimeout(() => { queueTimer = null; void refreshTasks(); }, QUEUE_DEBOUNCE_MS);
  };

  const loadSnapshot = async () => {
    const [runner, config, workers, workspaces] = await Promise.all([
      client.get('/api/runner').catch(() => null),
      client.get('/api/config').catch(() => null),
      client.get('/api/workers').catch(() => null),
      client.get('/api/workspaces').catch(() => null),
    ]);
    if (workspaces?.status === 200 && Array.isArray(workspaces.body?.workspaces)) dispatch({ type: 'workspaces', workspaces: workspaces.body.workspaces });
    if (runner?.body) dispatch({ type: 'runner', pid: runner.body.pid, version: runner.body.version });
    if (config?.body) dispatch({ type: 'config', maxConcurrent: config.body.maxConcurrent, builddServer: config.body.builddServer });
    if (workers?.status === 200 && Array.isArray(workers.body?.workers)) dispatch({ type: 'workers', workers: workers.body.workers });
    await refreshTasks();
  };

  const stream = async () => {
    let backoff = 1_000;
    while (!abort.signal.aborted) {
      try {
        await client.events((event) => {
          backoff = 1_000;
          if (eventChangesQueue(state, event)) queueChanged();
          dispatch(event);
        }, abort.signal);
      } catch { /* reconnect below */ }
      if (abort.signal.aborted) break;
      dispatch({ type: 'connection', online: false });
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10_000);
      // A restarted runner has new state: take a fresh snapshot.
      if (!abort.signal.aborted) await loadSnapshot().catch(() => {});
    }
  };

  // ── effects ─────────────────────────────────────────────────────────────
  const runEffect = async (effect: Effect) => {
    if (effect.type === 'quit') { finish(0); return; }
    if (effect.type === 'open' || effect.type === 'openRunner') {
      const server = state.runner.builddServer || 'https://buildd.dev';
      // The runner's page is where its workspaces are set (R-20).
      const url = `${server.replace(/\/$/, '')}${effect.type === 'open' ? `/app/tasks/${effect.taskId}` : '/app/settings/runners'}`;
      openUrl(url);
      dispatch({ type: 'status', status: { text: `Opened ${url}`, tone: 'ok' } });
      return;
    }
    let result: { status: number; body: unknown };
    try {
      if (effect.type === 'claim') {
        result = await client.post('/api/claim', { taskId: effect.taskId });
      } else {
        const body = effect.message !== undefined ? { message: effect.message } : {};
        result = await client.post(`/api/workers/${encodeURIComponent(effect.workerId)}/${effect.action}`, body);
      }
    } catch (err: any) {
      result = { status: 0, body: { error: `the runner did not answer (${err?.message ?? err})` } };
    }
    dispatch({ type: 'status', status: actionResultText(effect, result) });
    if (effect.type === 'claim') queueChanged();
  };

  // ── terminal ────────────────────────────────────────────────────────────
  const onData = (d: Buffer | string) => {
    for (const key of parseKeys(typeof d === 'string' ? d : d.toString('utf8'))) {
      const r = handleKey(state, key, Date.now());
      state = r.state;
      for (const e of r.effects) void runEffect(e);
    }
    scheduleDraw();
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
  // is consumed there; keys typed meanwhile are replayed below.
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
  timers.push(setInterval(() => void refreshTasks(), TASK_REFRESH_MS));
  void loadSnapshot().then(() => stream());

  return done;
}
