/**
 * `buildd top --frame`: one frame of the view on stdout, then exit. Hidden; for
 * checking what `top` draws against a live runner without a terminal, keys or
 * any action. It only reads the socket (the same GETs `top` makes, and the
 * first `init` frame of /api/events), so it never changes the runner.
 */
import { hostname as osHostname } from 'os';
import { createPalette, type Palette } from '../terminal-palette';
import { probeRunnerSocket } from '../runner-socket';
import { socketClient, type SocketClient } from './client';
import { renderFrame } from './render';
import { initialState, reduce, type TopEvent, type TopState } from './state';
import { EXIT_NO_RUNNER, noRunnerMessage } from './run';

export interface FrameOnceOptions {
  socketPath: string;
  client?: SocketClient;
  view?: 'missions' | 'queue';
  cols?: number;
  rows?: number;
  missionId?: string | null;
  workspace?: string | null;
  team?: string | null;
  hostname?: string;
  palette?: Palette;
  now?: number;
  /** How long to wait for the runner's `init` frame (ms). */
  initTimeoutMs?: number;
}

/** The first `init` frame of /api/events, or null if none comes in time. */
async function firstInit(client: SocketClient, timeoutMs: number): Promise<any | null> {
  const abort = new AbortController();
  let init: any = null;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await client.events((event) => {
      if (!init && event?.type === 'init') {
        init = event;
        abort.abort();
      }
    }, abort.signal);
  } catch { /* aborted, or the stream ended */ } finally {
    clearTimeout(timer);
  }
  return init;
}

/** Build the state `top` would have after its first reads, then draw one frame. */
export async function frameOnce(opts: FrameOnceOptions): Promise<string[]> {
  const client = opts.client ?? socketClient(opts.socketPath);
  let state: TopState = initialState({ hostname: opts.hostname ?? osHostname(), missionId: opts.missionId, workspace: opts.workspace, team: opts.team });
  const apply = (e: TopEvent) => { state = reduce(state, e); };
  const get = (path: string) => client.get(path).catch(() => null);
  const [runner, config, workers, workspaces, tasks, missions, queue, init] = await Promise.all([
    get('/api/runner'), get('/api/config'), get('/api/workers?view=top'), get('/api/workspaces'),
    get('/api/tasks'), get('/api/missions/recent'), get('/api/queue'),
    firstInit(client, opts.initTimeoutMs ?? 5_000),
  ]);
  if (workspaces?.status === 200 && Array.isArray(workspaces.body?.workspaces)) apply({ type: 'workspaces', workspaces: workspaces.body.workspaces });
  if (runner?.body) apply({ type: 'runner', pid: runner.body.pid, version: runner.body.version });
  if (config?.body) apply({ type: 'config', maxConcurrent: config.body.maxConcurrent, builddServer: config.body.builddServer, routes: config.body.routes, routeProblems: config.body.routeProblems });
  if (tasks?.status === 200 && Array.isArray(tasks.body?.tasks)) apply({ type: 'tasks', tasks: tasks.body.tasks });
  if (missions?.status === 200 && Array.isArray(missions.body?.missions)) apply({ type: 'missions', missions: missions.body.missions });
  // init carries what held the last claims and the hold; its own worker list is the long form, so the top view's list wins.
  if (init) apply({ ...init, workers: [] });
  if (workers?.status === 200 && Array.isArray(workers.body?.workers)) apply({ type: 'workers', workers: workers.body.workers });
  if (queue?.status === 200 && Array.isArray(queue.body?.teams)) apply({ type: 'queue', queue: { teams: queue.body.teams, truncated: !!queue.body.truncated } });
  apply({ type: 'connection', online: init !== null });
  if (opts.view === 'queue') state = { ...state, view: 'queue' };
  const palette = opts.palette ?? createPalette('night', 'none');
  return renderFrame(state, { cols: opts.cols ?? 120, rows: opts.rows ?? 40, now: opts.now ?? Date.now(), palette });
}

/** `buildd top --frame [--queue] [--cols N] [--rows N]`: print one frame and exit. */
export async function runFrameOnce(opts: FrameOnceOptions & { write?: (s: string) => void }): Promise<number> {
  if (!opts.client) {
    const probe = await probeRunnerSocket(opts.socketPath);
    if (probe.state !== 'live') {
      process.stderr.write(noRunnerMessage() + '\n');
      return EXIT_NO_RUNNER;
    }
  }
  const lines = await frameOnce(opts);
  (opts.write ?? ((s: string) => process.stdout.write(s)))(lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n');
  return 0;
}
