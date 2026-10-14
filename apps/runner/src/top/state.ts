/**
 * `buildd top` state: what the runner socket told us, and what the person is
 * doing in the view. Pure: the reducer folds socket events into state, and the
 * derive functions turn state into the missions pane and the row groups the
 * renderer draws. No I/O here (run.ts owns that).
 *
 * Data sources, all read through the runner's socket (runner-socket.ts):
 *   - workers: GET /api/workers, then `worker_update` frames on /api/events
 *   - tasks:   GET /api/tasks (the server's task list via the runner key; it
 *              carries missionId, dependsOn, startAt, roleSlug and the mission's
 *              title, hold and executor). Refetched when the runner learns of a
 *              queue change (task_assigned, claim_rejected, a worker finishing),
 *              and at most once a minute otherwise.
 *   - capacity: maxConcurrent from GET /api/config.
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';

export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale' | 'waiting';

export interface TopToolCall {
  name: string;
  timestamp: number;
  input?: any;
}

export interface TopMilestone {
  type: string;
  label: string;
  ts: number;
}

export interface TopWorker {
  id: string;
  taskId: string;
  taskTitle: string;
  workspaceId?: string;
  workspaceName?: string;
  status: WorkerStatus;
  startedAt: number;
  completedAt?: number;
  lastActivity?: number;
  currentAction?: string;
  milestones?: TopMilestone[];
  toolCalls?: TopToolCall[];
  prUrl?: string;
  error?: string | null;
  waitingFor?: { type: 'question' | 'permission' | 'pause'; prompt: string; options?: Array<{ label: string }> };
  tokenTally?: { inputTokens: number; outputTokens: number };
}

export interface TopTask {
  id: string;
  title: string;
  status: string;
  workspaceId?: string;
  missionId?: string | null;
  dependsOn?: string[] | null;
  startAt?: string | null;
  claimedBy?: string | null;
  roleSlug?: string | null;
  updatedAt?: string | null;
  mission?: { id: string; title: string; isHeld?: boolean; executor?: string } | null;
}

export type Mode =
  | { kind: 'list' }
  | { kind: 'detail'; taskId: string }
  | { kind: 'input'; purpose: 'answer' | 'message' | 'filter'; text: string; taskId?: string; workerId?: string; prompt?: string; from?: 'detail' }
  | { kind: 'confirm'; purpose: 'stop'; taskId: string; workerId: string; from?: 'detail' };

export interface StatusLine {
  text: string;
  tone: 'ok' | 'error' | 'info';
}

export interface TopState {
  runner: {
    hostname: string;
    version: string | null;
    pid: number | null;
    maxConcurrent: number;
    builddServer: string | null;
    online: boolean;
  };
  workers: Record<string, TopWorker>;
  tasks: TopTask[];
  /** taskId -> the server's reason this runner's claim was refused. */
  claimRefusals: Record<string, string>;
  /** Mission key: a mission id, or NO_MISSION. */
  selectedMission: string | null;
  focus: 'missions' | 'tasks';
  missionCursor: number;
  rowCursor: number;
  filter: string;
  mode: Mode;
  status: StatusLine | null;
}

export const NO_MISSION = '(none)';

export function initialState(opts: { hostname: string; missionId?: string | null }): TopState {
  return {
    runner: { hostname: opts.hostname, version: null, pid: null, maxConcurrent: 1, builddServer: null, online: false },
    workers: {},
    tasks: [],
    claimRefusals: {},
    selectedMission: opts.missionId ?? null,
    focus: 'tasks',
    missionCursor: 0,
    rowCursor: 0,
    filter: '',
    mode: { kind: 'list' },
    status: null,
  };
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export type TopEvent =
  | { type: 'runner'; pid?: number | null; version?: string | null }
  | { type: 'config'; maxConcurrent?: number; builddServer?: string | null }
  | { type: 'workers'; workers: TopWorker[] }
  | { type: 'tasks'; tasks: TopTask[] }
  | { type: 'connection'; online: boolean }
  | { type: 'status'; status: StatusLine | null }
  // Frames from the socket's /api/events, as the runner sends them.
  | { type: 'init'; workers?: TopWorker[]; config?: { maxConcurrent?: number; builddServer?: string } }
  | { type: 'worker_update'; worker: TopWorker }
  | { type: 'claim_rejected'; taskId?: string; status?: number; reason?: string }
  | { type: string; [k: string]: unknown };

function mergeWorkers(prev: Record<string, TopWorker>, list: TopWorker[]): Record<string, TopWorker> {
  const next = { ...prev };
  for (const w of list) if (w && w.id) next[w.id] = w;
  return next;
}

export function reduce(state: TopState, event: TopEvent): TopState {
  switch (event.type) {
    case 'runner': {
      const e = event as Extract<TopEvent, { type: 'runner' }>;
      return { ...state, runner: { ...state.runner, pid: e.pid ?? state.runner.pid, version: e.version ?? state.runner.version } };
    }
    case 'config': {
      const e = event as Extract<TopEvent, { type: 'config' }>;
      return {
        ...state,
        runner: {
          ...state.runner,
          maxConcurrent: typeof e.maxConcurrent === 'number' && e.maxConcurrent > 0 ? e.maxConcurrent : state.runner.maxConcurrent,
          builddServer: e.builddServer ?? state.runner.builddServer,
        },
      };
    }
    case 'workers':
      return { ...state, workers: mergeWorkers({}, (event as any).workers ?? []) };
    case 'tasks':
      return { ...state, tasks: Array.isArray((event as any).tasks) ? (event as any).tasks : state.tasks };
    case 'connection':
      return { ...state, runner: { ...state.runner, online: !!(event as any).online } };
    case 'status':
      return { ...state, status: (event as any).status ?? null };
    case 'init': {
      const e = event as Extract<TopEvent, { type: 'init' }>;
      let next: TopState = { ...state, workers: mergeWorkers(state.workers, e.workers ?? []) };
      if (e.config) next = reduce(next, { type: 'config', maxConcurrent: e.config.maxConcurrent, builddServer: e.config.builddServer });
      return { ...next, runner: { ...next.runner, online: true } };
    }
    case 'worker_update': {
      const w = (event as any).worker as TopWorker | undefined;
      if (!w?.id) return state;
      const claimRefusals = { ...state.claimRefusals };
      delete claimRefusals[w.taskId];
      return { ...state, workers: { ...state.workers, [w.id]: w }, claimRefusals };
    }
    case 'claim_rejected': {
      const e = event as Extract<TopEvent, { type: 'claim_rejected' }>;
      if (!e.taskId) return state;
      return { ...state, claimRefusals: { ...state.claimRefusals, [e.taskId]: e.reason || `HTTP ${e.status ?? '?'}` } };
    }
    default:
      return state;
  }
}

/**
 * Does this event mean the task list may have changed? The runner learns of
 * queue changes over Pusher (task_assigned), from its claim loop
 * (claim_rejected) and from its own workers starting or finishing.
 */
export function eventChangesQueue(state: TopState, event: TopEvent): boolean {
  if (event.type === 'task_assigned' || event.type === 'claim_rejected') return true;
  if (event.type === 'worker_update') {
    const w = (event as any).worker as TopWorker | undefined;
    if (!w?.id) return false;
    const prev = state.workers[w.id];
    if (!prev) return true;
    return prev.status !== w.status;
  }
  return false;
}

// ── Derive ──────────────────────────────────────────────────────────────────

const TERMINAL = new Set<string>(TERMINAL_TASK_STATUSES);
const BUSY: WorkerStatus[] = ['working', 'stale'];

export function busySlots(state: TopState): number {
  return Object.values(state.workers).filter(w => BUSY.includes(w.status)).length;
}

/** The newest worker this runner has for each task. */
function workerByTask(state: TopState): Map<string, TopWorker> {
  const m = new Map<string, TopWorker>();
  for (const w of Object.values(state.workers)) {
    const prev = m.get(w.taskId);
    if (!prev || (w.startedAt ?? 0) > (prev.startedAt ?? 0)) m.set(w.taskId, w);
  }
  return m;
}

/**
 * Tasks this runner has taken or could take. A mission a person runs from
 * their own session (executor=local) is never claimed by a runner, so it is
 * left out unless this runner already holds one of its tasks.
 */
function relevantTasks(state: TopState, workers: Map<string, TopWorker>): TopTask[] {
  const seen = new Set<string>();
  const out: TopTask[] = [];
  for (const t of state.tasks) {
    if (seen.has(t.id)) continue;
    if (t.mission?.executor === 'local' && !workers.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  // A worker whose task is not in the list (list not loaded yet, or older than
  // the server's window) still shows, under its own title.
  for (const w of workers.values()) {
    if (seen.has(w.taskId)) continue;
    seen.add(w.taskId);
    out.push({ id: w.taskId, title: w.taskTitle, status: workerTaskStatus(w), workspaceId: w.workspaceId, missionId: null });
  }
  return out;
}

function workerTaskStatus(w: TopWorker): string {
  if (w.status === 'done') return 'completed';
  if (w.status === 'error') return 'failed';
  return 'in_progress';
}

export interface MissionRow {
  key: string;
  title: string;
  done: number;
  total: number;
  running: number;
}

function sameLocalDay(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date(now).toDateString();
}

export function missionRows(state: TopState): MissionRow[] {
  const workers = workerByTask(state);
  const map = new Map<string, MissionRow>();
  for (const t of relevantTasks(state, workers)) {
    const key = t.missionId || NO_MISSION;
    let row = map.get(key);
    if (!row) {
      row = { key, title: key === NO_MISSION ? '(no mission)' : t.mission?.title || `mission ${key.slice(0, 8)}`, done: 0, total: 0, running: 0 };
      map.set(key, row);
    }
    row.total++;
    if (t.status === 'completed') row.done++;
    const w = workers.get(t.id);
    if (w && (BUSY.includes(w.status) || w.status === 'waiting')) row.running++;
  }
  const rows = [...map.values()].filter(r => r.key !== NO_MISSION);
  rows.sort((a, b) => (b.running > 0 ? 1 : 0) - (a.running > 0 ? 1 : 0) || a.title.localeCompare(b.title));
  // `(no mission)` is always there, last, so loose tasks have a home.
  rows.push(map.get(NO_MISSION) ?? { key: NO_MISSION, title: '(no mission)', done: 0, total: 0, running: 0 });
  return rows;
}

/** The mission the right pane shows: the selection if it still exists, else the first. */
export function currentMission(state: TopState): MissionRow {
  const rows = missionRows(state);
  if (state.selectedMission) {
    const hit = rows.find(r => r.key === state.selectedMission) ?? rows.find(r => r.key.startsWith(state.selectedMission!));
    if (hit) return hit;
  }
  return rows[Math.min(state.missionCursor, rows.length - 1)] ?? rows[0];
}

export type RowKind = 'running' | 'asking' | 'paused' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';

export interface TaskRow {
  taskId: string;
  workerId?: string;
  group: 'running' | 'waiting' | 'done';
  kind: RowKind;
  title: string;
  role?: string;
  /** Running rows: since the worker started. */
  elapsedMs?: number;
  /** Running rows: what the agent is doing now. */
  action?: string;
  /** Asking rows: the question itself. */
  question?: string;
  /** Waiting / done rows: why it waits, or how it ended, in words. */
  reason?: string;
  /** Running rows: tokens so far (cost on a seat is not money). */
  tokens?: number;
}

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

function untilWords(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function roleLabel(slug: string | null | undefined): string | undefined {
  if (!slug) return undefined;
  return slug.split(/[-_]/).map(p => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

/**
 * Why a task this runner does not hold is waiting, in words. Order matters:
 * the first true one is what a person would want to hear.
 */
export function waitingReason(task: TopTask, state: TopState, now: number): string {
  const refused = state.claimRefusals[task.id];
  if (refused) return `refused: ${refused}`;
  if (task.status === 'assigned' || task.status === 'in_progress') return 'another runner has it';
  if (task.mission?.isHeld) return 'mission is on hold';
  const deps = (task.dependsOn ?? [])
    .map(id => state.tasks.find(t => t.id === id))
    .filter((t): t is TopTask => !!t && !TERMINAL.has(t.status));
  if (deps.length > 0) {
    const more = deps.length > 1 ? ` and ${deps.length - 1} more` : '';
    return `waits on: ${deps[0].title}${more}`;
  }
  if (task.startAt) {
    const at = new Date(task.startAt).getTime();
    if (!Number.isNaN(at) && at > now) return `starts in ${untilWords(at - now)}`;
  }
  const busy = busySlots(state);
  if (busy >= state.runner.maxConcurrent) return `runner is full (${busy} of ${state.runner.maxConcurrent} busy)`;
  return 'ready, next claim picks it up';
}

function lastToolLabel(w: TopWorker): string | undefined {
  const t = w.toolCalls?.[w.toolCalls.length - 1];
  if (!t) return undefined;
  return describeToolCall(t);
}

export function describeToolCall(t: TopToolCall): string {
  const i = t.input ?? {};
  const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? '';
  const short = typeof arg === 'string' ? arg.replace(/\s+/g, ' ').trim() : '';
  const file = typeof i.file_path === 'string' ? i.file_path.split('/').pop() : null;
  return `${t.name} ${file ?? short}`.trim();
}

function matchesFilter(title: string, filter: string): boolean {
  return !filter || title.toLowerCase().includes(filter.toLowerCase());
}

export function taskRows(state: TopState, now: number): TaskRow[] {
  const workers = workerByTask(state);
  const mission = currentMission(state);
  const tasks = relevantTasks(state, workers).filter(t => (t.missionId || NO_MISSION) === mission.key);
  const running: TaskRow[] = [];
  const waiting: TaskRow[] = [];
  const done: TaskRow[] = [];

  for (const t of tasks) {
    if (!matchesFilter(t.title, state.filter)) continue;
    const w = workers.get(t.id);
    const role = roleLabel(t.roleSlug);
    const base = { taskId: t.id, title: t.title || w?.taskTitle || t.id.slice(0, 8), role };

    if (w && (BUSY.includes(w.status) || w.status === 'waiting' || w.status === 'idle')) {
      const elapsedMs = now - (w.startedAt || now);
      const tokens = w.tokenTally ? w.tokenTally.inputTokens + w.tokenTally.outputTokens : undefined;
      if (w.status === 'waiting' && w.waitingFor?.type === 'pause') {
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'paused', elapsedMs, reason: 'paused, a resumes it', tokens });
      } else if (w.status === 'waiting' && w.waitingFor) {
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'asking', elapsedMs, question: w.waitingFor.prompt, tokens });
      } else {
        const action = w.currentAction || lastToolLabel(w) || 'starting';
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'running', elapsedMs, action, tokens });
      }
      continue;
    }

    const terminal = TERMINAL.has(t.status) || w?.status === 'done' || w?.status === 'error';
    if (terminal) {
      const endedToday = sameLocalDay(t.updatedAt, now) || (w?.completedAt ? new Date(w.completedAt).toDateString() === new Date(now).toDateString() : false);
      if (!endedToday) continue;
      if (t.status === 'failed' || w?.status === 'error') {
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'failed', reason: w?.error ? `failed: ${w.error}` : 'failed' });
      } else if (t.status === 'cancelled') {
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'cancelled', reason: 'cancelled' });
      } else if (w?.prUrl) {
        done.push({ ...base, workerId: w.id, group: 'done', kind: 'review', reason: `PR open ${w.prUrl.replace(/^https:\/\/github\.com\//, '')}` });
      } else {
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'done', reason: 'done' });
      }
      continue;
    }

    waiting.push({ ...base, group: 'waiting', kind: 'waiting', reason: waitingReason(t, state, now) });
  }

  running.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));
  // Ready work first, then the rest in the order the server listed it.
  const ready = (r: TaskRow) => (r.reason?.startsWith('ready') ? 0 : 1);
  waiting.sort((a, b) => ready(a) - ready(b));
  return [...running, ...waiting, ...done];
}

export function selectedRow(state: TopState, now: number): TaskRow | null {
  const rows = taskRows(state, now);
  if (rows.length === 0) return null;
  return rows[Math.max(0, Math.min(state.rowCursor, rows.length - 1))];
}

/** The plan, from the agent's latest TodoWrite call. */
export function planOf(w: TopWorker | undefined): Array<{ content: string; status: string }> {
  if (!w?.toolCalls) return [];
  for (let i = w.toolCalls.length - 1; i >= 0; i--) {
    const t = w.toolCalls[i];
    if (t.name === 'TodoWrite' && Array.isArray(t.input?.todos)) {
      return t.input.todos
        .filter((x: any) => x && typeof x.content === 'string')
        .map((x: any) => ({ content: x.content, status: String(x.status ?? 'pending') }));
    }
  }
  return [];
}

export function workerForTask(state: TopState, taskId: string): TopWorker | undefined {
  return workerByTask(state).get(taskId);
}
