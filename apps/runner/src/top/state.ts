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
 *              title, hold, executor and done/total over all its tasks,
 *              plus prMergedAt on a finished task). Refetched when the runner learns of a
 *              queue change (task_assigned, claim_rejected, a worker finishing),
 *              and at most once a minute otherwise.
 *   - capacity: maxConcurrent from GET /api/config.
 *   - workspaces: GET /api/workspaces, the workspaces this runner's key reaches
 *     (the `w` switcher and the header count, R-19).
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
  mode?: string | null;
  kind?: string | null;
  workspace?: { id: string; name: string } | null;
  updatedAt?: string | null;
  /** Set by the server on a finished task whose PR has merged. */
  prMergedAt?: string | null;
  mission?: {
    id: string;
    title: string;
    isHeld?: boolean;
    executor?: string;
    /** The server's count over every task of the mission (the list itself is windowed). */
    taskCounts?: { done: number; total: number };
  } | null;
}

export interface TopWorkspace {
  id: string;
  name: string;
  teamId?: string | null;
  /** Only when the server sends it; the count stands without it. */
  teamName?: string | null;
}

export type Mode =
  | { kind: 'list' }
  | { kind: 'help' }
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
  workspaces: TopWorkspace[];
  /** A workspace id, or the name / id prefix `--workspace` was given; null = all. */
  selectedWorkspace: string | null;
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

export function initialState(opts: { hostname: string; missionId?: string | null; workspace?: string | null }): TopState {
  return {
    runner: { hostname: opts.hostname, version: null, pid: null, maxConcurrent: 1, builddServer: null, online: false },
    workers: {},
    tasks: [],
    workspaces: [],
    selectedWorkspace: opts.workspace ?? null,
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
  | { type: 'workspaces'; workspaces: TopWorkspace[] }
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
    case 'workspaces': {
      const list = (event as any).workspaces;
      if (!Array.isArray(list)) return state;
      const workspaces: TopWorkspace[] = list
        .filter((w: any) => w && typeof w.id === 'string')
        .map((w: any) => ({
          id: w.id,
          name: typeof w.name === 'string' && w.name ? w.name : w.id.slice(0, 8),
          teamId: w.teamId ?? null,
          teamName: w.teamName ?? w.team?.name ?? null,
        }));
      const next = { ...state, workspaces };
      // `--workspace` naming nothing this runner serves: open on all, and say so (R-19).
      const sel = state.selectedWorkspace?.trim();
      if (sel && workspaces.length > 0 && !currentWorkspace(next)) {
        return { ...next, selectedWorkspace: null, status: { text: `No workspace matches "${sel}", so this shows all ${workspaces.length}.`, tone: 'error' } };
      }
      return next;
    }
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
  const ws = currentWorkspace(state);
  const inWorkspace = (id: string | undefined) => !ws || id === ws.id;
  for (const t of state.tasks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.mission?.executor === 'local' && !workers.has(t.id)) continue;
    if (isOrganizerTask(t)) continue;
    if (!inWorkspace(taskWorkspaceId(t))) continue;
    out.push(t);
  }
  // A worker whose task is not in the list (list not loaded yet, or older than
  // the server's window) still shows, under its own title.
  for (const w of workers.values()) {
    if (seen.has(w.taskId)) continue;
    seen.add(w.taskId);
    const t: TopTask = { id: w.taskId, title: w.taskTitle, status: workerTaskStatus(w), workspaceId: w.workspaceId, missionId: null };
    if (isOrganizerTask(t) || !inWorkspace(w.workspaceId)) continue;
    out.push(t);
  }
  return out;
}

const ORGANIZER_TITLE_PREFIXES = ['Mission:', 'Aggregate results:', 'Evaluate mission completion:', 'Close mission'];

/**
 * The mission's own planning and check-in runs (R-22): the organizer role, or
 * one of the titles the server gives them (the same prefixes the mission page
 * leaves out of its work list). A coordination-kind or planning-mode task that
 * someone filed is real work and stays listed.
 */
export function isOrganizerTask(t: Pick<TopTask, 'title' | 'roleSlug'>): boolean {
  if (t.roleSlug === 'organizer') return true;
  const title = t.title ?? '';
  return ORGANIZER_TITLE_PREFIXES.some(p => title.startsWith(p));
}

function taskWorkspaceId(t: TopTask): string | undefined {
  return t.workspaceId ?? t.workspace?.id ?? undefined;
}

// ── Workspaces (R-19) ───────────────────────────────────────────────────────

/**
 * The workspaces this runner serves: the server's list, else the ones its tasks
 * name. When they span several teams they come grouped by team (R-7), teams in
 * the order the list first names them, so `w` steps through one team's
 * workspaces before the next. Without team ids it is one group, in list order.
 */
export function workspaceList(state: TopState): TopWorkspace[] {
  if (state.workspaces.length > 0) return groupByTeam(state.workspaces);
  const seen = new Map<string, TopWorkspace>();
  for (const t of state.tasks) {
    const id = taskWorkspaceId(t);
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, name: t.workspace?.name || id.slice(0, 8) });
  }
  return [...seen.values()];
}

/** The team a workspace is grouped under, or null when the server did not say. */
function teamKey(w: TopWorkspace): string | null {
  return w.teamId || w.teamName || null;
}

/** Stable grouping by team; a list with fewer than two teams is returned as is. */
export function groupByTeam(list: TopWorkspace[]): TopWorkspace[] {
  const groups = new Map<string | null, TopWorkspace[]>();
  for (const w of list) {
    const k = teamKey(w);
    const g = groups.get(k);
    if (g) g.push(w); else groups.set(k, [w]);
  }
  if ([...groups.keys()].filter(k => k !== null).length < 2) return list;
  return [...groups.values()].flat();
}

/** How many teams the runner's workspaces span (0 when the server sends no team ids). */
export function teamCount(state: TopState): number {
  return new Set(workspaceList(state).map(teamKey).filter(Boolean)).size;
}

/** The workspace the view is narrowed to, or null for all of them. */
export function currentWorkspace(state: TopState): TopWorkspace | null {
  const sel = state.selectedWorkspace?.trim();
  if (!sel) return null;
  const list = workspaceList(state);
  const lower = sel.toLowerCase();
  return list.find(w => w.id === sel)
    ?? list.find(w => w.name.toLowerCase() === lower)
    ?? list.find(w => w.id.startsWith(sel))
    ?? null;
}

/** `w`: the next workspace, and after the last one, all of them again. */
export function cycleWorkspace(state: TopState): TopState {
  const list = workspaceList(state);
  const cur = currentWorkspace(state);
  const idx = cur ? list.findIndex(w => w.id === cur.id) : -1;
  const next = idx + 1 < list.length ? list[idx + 1] : null;
  return { ...state, selectedWorkspace: next?.id ?? null, selectedMission: null, missionCursor: 0, rowCursor: 0 };
}

/** "5 workspaces · TWC" with one team, "5 workspaces · 2 teams" with more. */
export function workspaceSummary(state: TopState): string {
  const list = workspaceList(state);
  if (list.length === 0) return '';
  const count = `${list.length} workspace${list.length === 1 ? '' : 's'}`;
  const teams = teamCount(state);
  if (teams > 1) return `${count} · ${teams} teams`;
  const teamName = list.find(w => w.teamName)?.teamName;
  return teamName ? `${count} · ${teamName}` : count;
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
  /** The mission's organizer is running (R-22): it plans, it is not work. */
  planning: boolean;
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
  const serverCounts = new Map<string, { done: number; total: number }>();
  for (const t of relevantTasks(state, workers)) {
    const key = t.missionId || NO_MISSION;
    let row = map.get(key);
    if (!row) {
      row = { key, title: key === NO_MISSION ? '(no mission)' : t.mission?.title || `mission ${key.slice(0, 8)}`, done: 0, total: 0, running: 0, planning: false };
      map.set(key, row);
    }
    row.total++;
    if (t.status === 'completed') row.done++;
    const w = workers.get(t.id);
    if (w && (BUSY.includes(w.status) || w.status === 'waiting')) row.running++;
    if (t.mission?.taskCounts) serverCounts.set(key, t.mission.taskCounts);
  }
  // The list holds active tasks and only a day of finished ones, so the local
  // tally undercounts a long mission; the server's count wins when it sent one.
  for (const [key, c] of serverCounts) {
    const row = map.get(key)!;
    row.done = c.done;
    row.total = Math.max(c.total, row.total);
  }
  // An organizer run in progress marks its mission as planning.
  for (const t of state.tasks) {
    if (!t.missionId || !isOrganizerTask(t)) continue;
    const row = map.get(t.missionId);
    if (!row) continue;
    const w = workers.get(t.id);
    if ((w && BUSY.includes(w.status)) || (!w && t.status === 'in_progress')) row.planning = true;
  }
  const rows = [...map.values()].filter(r => r.key !== NO_MISSION);
  rows.sort((a, b) => (b.running > 0 ? 1 : 0) - (a.running > 0 ? 1 : 0) || a.title.localeCompare(b.title));
  // `(no mission)` is always there, last, so loose tasks have a home.
  rows.push(map.get(NO_MISSION) ?? { key: NO_MISSION, title: '(no mission)', done: 0, total: 0, running: 0, planning: false });
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
        const why = failureReason(w?.error);
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'failed', reason: why ? `failed: ${why}` : 'failed, no reason recorded' });
      } else if (t.status === 'cancelled') {
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'cancelled', reason: 'cancelled' });
      } else if (t.prMergedAt) {
        const pr = w?.prUrl ? ` ${w.prUrl.replace(/^https:\/\/github\.com\//, '')}` : '';
        done.push({ ...base, workerId: w?.id, group: 'done', kind: 'done', reason: `PR merged${pr}` });
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

/** Lines that say a task failed without saying why. */
const GENERIC_FAILURES = new Set(['task failed on server', 'failed', 'error', 'unknown error']);

/**
 * The reason a worker recorded for failing, in plain words: its first line,
 * without an `Error:` prefix or a stack. Null when there is none, or only a
 * line that says it failed without saying why.
 */
export function failureReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const first = error.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const text = first.replace(/^(?:uncaught\s+)?(?:[A-Z][A-Za-z]*)?Error:\s*/, '').trim();
  if (!text || GENERIC_FAILURES.has(text.toLowerCase())) return null;
  return text;
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
