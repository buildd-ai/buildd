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
 *              plus prMergedAt on a finished task, and the mission's stage, which
 *              the runner adds from GET /api/missions/stages). Refetched when the runner learns of a
 *              queue change (task_assigned, claim_rejected, a worker finishing),
 *              and at most once a minute otherwise.
 *   - capacity: maxConcurrent from GET /api/config.
 *   - workspaces: GET /api/workspaces, the workspaces this runner's key reaches
 *     (the `w` switcher and the header count, R-19).
 *   - missions: GET /api/missions/recent, the open missions of those workspaces
 *     and the ones delivered in the last 7 days (R-24), at most once a minute.
 *   - claim outcomes: what the server said about the runner's last claim of
 *     each task and its last broad claim (R-25), in the `init` frame, then
 *     `claim_outcome` frames. They say what really holds a waiting task.
 *   - queue: GET /api/queue, the claim route's own order for this runner per
 *     team (R-26), read while the Queue view is open (queue.ts derives it).
 */
import type { ProgressCell } from './progress';
import { rowDollars, runsOnLine, runWords, sameRoute, todayLine, todayTotals, workerSpend, type RouteProblem, type RunRoute, type RunSpend, type SpendResultMeta, type SpendTotals } from '../run-route';
import { TERMINAL_TASK_STATUSES, isRunnerHoldActive, parseRunnerHold, type RecentMission, type RunnerHold, type RunnerQueueResponse } from '@buildd/shared';

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
  /** Which route the run reached its model by (run-route.ts); absent from older runners. */
  route?: RunRoute | null;
  costBasis?: string | null;
  taskBackend?: string | null;
  /** The model the run asked for. */
  sessionModel?: string;
  /** The run's dollars, when the summary worked them out (else derived from resultMeta). */
  spend?: RunSpend | null;
  resultMeta?: SpendResultMeta | null;
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
  /** The agent provider that runs it (claude | codex); absent from older servers, read as claude. */
  backend?: string | null;
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
    /** The mission page rail's current step and what it waits on (R-18). Absent from older servers. */
    stage?: MissionStage;
  } | null;
}

export type MissionStageStep = 'building' | 'verifying' | 'delivering' | 'delivered' | 'on_hold' | 'planning';
export interface MissionStage {
  step: MissionStageStep;
  waitingOn: string | null;
  /** The mission page's Overview strip as cells, done first (R-29). Absent from older servers. */
  progress?: ProgressCell[];
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
    /** A person's hold (`buildd hold`, `h`): nothing new starts while set (R-33). */
    hold: RunnerHold | null;
    /** The routes this machine's own credentials give (R-39), from GET /api/config. */
    routes: RunRoute[];
    /** Routes that do not work right now, with where to fix them. */
    routeProblems: RouteProblem[];
  };
  workers: Record<string, TopWorker>;
  tasks: TopTask[];
  workspaces: TopWorkspace[];
  /** A workspace id, or the name / id prefix `--workspace` was given; null = all. */
  selectedWorkspace: string | null;
  /** A team name or id (`--team`, or `t`); null = every team (R-23). */
  selectedTeam: string | null;
  /** Open and recently delivered missions from the server; null until the first answer. */
  recentMissions: RecentMission[] | null;
  /**
   * What the server said about the runner's last claim of each task, and of its
   * last broad claim (R-25). Kept by the runner (claim-outcomes.ts) and sent
   * over the socket: in `init`, then one `claim_outcome` frame per claim.
   */
  claimOutcomes: { tasks: Record<string, ClaimOutcome>; broad: ClaimOutcome | null };
  /** Mission key: a mission id, or NO_MISSION. */
  selectedMission: string | null;
  /** `Tab` switches between the Missions view and the Queue view (R-26). */
  view: 'missions' | 'queue';
  /** The server's queue for this runner (GET /api/workers/queue via the socket); null until read. */
  queue: RunnerQueueResponse | null;
  /** The selected row in the Queue view, over its rows in drawn order. */
  queueCursor: number;
  focus: 'missions' | 'tasks';
  missionCursor: number;
  rowCursor: number;
  filter: string;
  mode: Mode;
  status: StatusLine | null;
}

/**
 * One claim outcome as the runner keeps it (apps/runner/src/claim-outcomes.ts):
 * the server's structured reason, exclusion code and lift times.
 */
export interface ClaimOutcome {
  at: number;
  reason: string;
  exclusion?: string;
  detail?: string;
  until?: string | null;
  walls?: Array<{ kind: string; backend: string; resetsAt: string | null }>;
  summary?: string;
  deferrals?: Record<string, number>;
  status?: number;
  refusal?: string;
  /**
   * The server's `updatedAt` for the task when top first saw it after this
   * outcome (for the broad claim: the newest `updatedAt` in the list), so
   * "has the task moved since" compares server time with server time, never
   * with this machine's clock.
   */
  seenUpdatedAt?: string;
}

export const NO_MISSION = '(none)';

export function initialState(opts: { hostname: string; missionId?: string | null; workspace?: string | null; team?: string | null }): TopState {
  return {
    runner: { hostname: opts.hostname, version: null, pid: null, maxConcurrent: 1, builddServer: null, online: false, hold: null, routes: [], routeProblems: [] },
    workers: {},
    tasks: [],
    workspaces: [],
    selectedWorkspace: opts.workspace ?? null,
    selectedTeam: opts.team ?? null,
    recentMissions: null,
    claimOutcomes: { tasks: {}, broad: null },
    selectedMission: opts.missionId ?? null,
    view: 'missions',
    queue: null,
    queueCursor: 0,
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
  | { type: 'config'; maxConcurrent?: number; builddServer?: string | null; routes?: RunRoute[]; routeProblems?: RouteProblem[] }
  | { type: 'workers'; workers: TopWorker[] }
  | { type: 'tasks'; tasks: TopTask[] }
  | { type: 'workspaces'; workspaces: TopWorkspace[] }
  | { type: 'missions'; missions: RecentMission[] }
  | { type: 'queue'; queue: RunnerQueueResponse }
  | { type: 'connection'; online: boolean }
  | { type: 'status'; status: StatusLine | null }
  // Frames from the socket's /api/events, as the runner sends them.
  | { type: 'init'; workers?: TopWorker[]; config?: { maxConcurrent?: number; builddServer?: string }; claimOutcomes?: { tasks?: Record<string, ClaimOutcome>; broad?: ClaimOutcome | null }; hold?: RunnerHold | null }
  /** The runner's hold changed (`buildd hold`, `h`, or its `until` passed). */
  | { type: 'runner_hold'; hold: RunnerHold | null }
  | { type: 'claim_outcome'; taskId?: string; outcome: ClaimOutcome }
  | { type: 'worker_update'; worker: TopWorker }
  | { type: 'claim_rejected'; taskId?: string; status?: number; reason?: string }
  | { type: string; [k: string]: unknown };

function isRoute(r: unknown): r is RunRoute {
  const x = r as RunRoute | null;
  return !!x && typeof x.bucket === 'string' && typeof x.backend === 'string' && typeof x.provider === 'string' && typeof x.owner === 'string';
}

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
          // An older runner sends neither: keep what we had.
          routes: Array.isArray(e.routes) ? e.routes.filter(isRoute) : state.runner.routes,
          routeProblems: Array.isArray(e.routeProblems)
            ? e.routeProblems.filter((p): p is RouteProblem => !!p && typeof p.text === 'string')
            : state.runner.routeProblems,
        },
      };
    }
    case 'workers':
      return { ...state, workers: mergeWorkers({}, (event as any).workers ?? []) };
    case 'tasks': {
      if (!Array.isArray((event as any).tasks)) return state;
      const tasks: TopTask[] = (event as any).tasks;
      return { ...state, tasks, claimOutcomes: { ...state.claimOutcomes, tasks: pruneMovedOutcomes(state.claimOutcomes.tasks, tasks) } };
    }
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
      let next = { ...state, workspaces };
      // `--team` naming no team this runner serves: open on all, and say so (R-23).
      const team = state.selectedTeam?.trim();
      if (team && workspaces.length > 0 && !currentTeam(next)) {
        next = { ...next, selectedTeam: null, status: { text: `No team matches "${team}", so this shows all ${teamList(next).length} teams.`, tone: 'error' } };
      }
      // `--workspace` naming nothing this runner serves: open on all, and say so (R-19).
      const sel = state.selectedWorkspace?.trim();
      if (sel && workspaces.length > 0 && !currentWorkspace(next)) {
        return { ...next, selectedWorkspace: null, status: { text: `No workspace matches "${sel}", so this shows all ${workspaces.length}.`, tone: 'error' } };
      }
      return next;
    }
    case 'missions': {
      const list = (event as any).missions;
      if (!Array.isArray(list)) return state;
      return { ...state, recentMissions: list.filter((m: any) => m && typeof m.id === 'string') };
    }
    case 'queue': {
      const q = (event as any).queue;
      if (!q || !Array.isArray(q.teams)) return state;
      return { ...state, queue: q };
    }
    case 'connection':
      return { ...state, runner: { ...state.runner, online: !!(event as any).online } };
    case 'status':
      return { ...state, status: (event as any).status ?? null };
    case 'init': {
      const e = event as Extract<TopEvent, { type: 'init' }>;
      let next: TopState = { ...state, workers: mergeWorkers(state.workers, e.workers ?? []) };
      if (e.claimOutcomes && typeof e.claimOutcomes === 'object') {
        const tasks = e.claimOutcomes.tasks && typeof e.claimOutcomes.tasks === 'object' ? e.claimOutcomes.tasks : {};
        next = { ...next, claimOutcomes: { tasks: pruneMovedOutcomes(tasks, next.tasks), broad: e.claimOutcomes.broad ? stampBroad(e.claimOutcomes.broad, next.tasks) : null } };
      }
      if (e.config) next = reduce(next, { type: 'config', maxConcurrent: e.config.maxConcurrent, builddServer: e.config.builddServer });
      // An older runner sends no `hold`: it cannot be held, so none.
      return { ...next, runner: { ...next.runner, online: true, hold: parseRunnerHold(e.hold) } };
    }
    case 'runner_hold': {
      return { ...state, runner: { ...state.runner, hold: parseRunnerHold((event as any).hold) } };
    }
    case 'worker_update': {
      const w = (event as any).worker as TopWorker | undefined;
      if (!w?.id) return state;
      if (!state.claimOutcomes.tasks[w.taskId]) return { ...state, workers: { ...state.workers, [w.id]: w } };
      const tasks = { ...state.claimOutcomes.tasks };
      delete tasks[w.taskId];
      return { ...state, workers: { ...state.workers, [w.id]: w }, claimOutcomes: { ...state.claimOutcomes, tasks } };
    }
    case 'claim_rejected': {
      // The refusal as text. A current runner also sends claim_outcome.
      const e = event as Extract<TopEvent, { type: 'claim_rejected' }>;
      if (!e.taskId) return state;
      const outcome: ClaimOutcome = { at: Date.now(), reason: 'refused', status: e.status, refusal: e.reason || `HTTP ${e.status ?? '?'}` };
      return { ...state, claimOutcomes: { ...state.claimOutcomes, tasks: { ...state.claimOutcomes.tasks, [e.taskId]: outcome } } };
    }
    case 'claim_outcome': {
      const e = event as Extract<TopEvent, { type: 'claim_outcome' }>;
      if (!e.outcome || typeof e.outcome.reason !== 'string') return state;
      if (!e.taskId) return { ...state, claimOutcomes: { ...state.claimOutcomes, broad: stampBroad(carryWalls(state.claimOutcomes.broad, e.outcome), state.tasks) } };
      const tasks = { ...state.claimOutcomes.tasks };
      if (e.outcome.reason === 'claimed') delete tasks[e.taskId];
      else tasks[e.taskId] = e.outcome;
      return { ...state, claimOutcomes: { ...state.claimOutcomes, tasks } };
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
  // task_claimed: a task in one of its workspaces was claimed, by this runner or another (AC-12).
  if (event.type === 'task_assigned' || event.type === 'task_claimed' || event.type === 'claim_rejected' || event.type === 'claim_outcome') return true;
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
  const inWorkspace = inView(state);
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

// ── Teams (R-23) ────────────────────────────────────────────────────────────

export interface TopTeam {
  key: string;
  name: string;
}

function teamName(w: TopWorkspace): string | null {
  return w.teamName || (w.teamId ? w.teamId.slice(0, 8) : null);
}

/** The teams the runner's workspaces span, in the order the list first names them. */
export function teamList(state: TopState): TopTeam[] {
  const seen = new Map<string, TopTeam>();
  for (const w of workspaceList(state)) {
    const key = teamKey(w);
    if (!key || seen.has(key)) continue;
    seen.set(key, { key, name: teamName(w) ?? key });
  }
  return [...seen.values()];
}

/** The team the view is narrowed to (by name, id or id prefix), or null for all of them. */
export function currentTeam(state: TopState): TopTeam | null {
  const sel = state.selectedTeam?.trim();
  if (!sel) return null;
  const list = teamList(state);
  const lower = sel.toLowerCase();
  return list.find(t => t.key === sel)
    ?? list.find(t => t.name.toLowerCase() === lower)
    ?? list.find(t => t.key.toLowerCase().startsWith(lower))
    ?? null;
}

/** The workspaces `w` steps through: the team's, or every one. */
export function scopedWorkspaces(state: TopState): TopWorkspace[] {
  const team = currentTeam(state);
  const list = workspaceList(state);
  return team ? list.filter(w => teamKey(w) === team.key) : list;
}

/** Which workspace ids the view shows: the selected workspace, else the selected team's, else any. */
export function inView(state: TopState): (workspaceId: string | undefined) => boolean {
  const ws = currentWorkspace(state);
  if (ws) return id => id === ws.id;
  if (currentTeam(state)) {
    const ids = new Set(scopedWorkspaces(state).map(w => w.id));
    return id => !!id && ids.has(id);
  }
  return () => true;
}

/** `t`: the next team, and after the last one, all of them again. */
export function cycleTeam(state: TopState): TopState {
  const teams = teamList(state);
  if (teams.length < 2) return state;
  const cur = currentTeam(state);
  const idx = cur ? teams.findIndex(t => t.key === cur.key) : -1;
  const next = idx + 1 < teams.length ? teams[idx + 1] : null;
  return { ...state, selectedTeam: next?.key ?? null, selectedWorkspace: null, selectedMission: null, missionCursor: 0, rowCursor: 0, queueCursor: 0 };
}

/** The line under the header: what is shown, and the keys that change it. */
export function filterLine(state: TopState): string {
  return `t team: ${currentTeam(state)?.name ?? 'all'} · w workspace: ${currentWorkspace(state)?.name ?? 'all'}`;
}

/** `w`: the next workspace, and after the last one, all of them again. */
export function cycleWorkspace(state: TopState): TopState {
  const list = scopedWorkspaces(state);
  const cur = currentWorkspace(state);
  const idx = cur ? list.findIndex(w => w.id === cur.id) : -1;
  const next = idx + 1 < list.length ? list[idx + 1] : null;
  return { ...state, selectedWorkspace: next?.id ?? null, selectedMission: null, missionCursor: 0, rowCursor: 0, queueCursor: 0 };
}

/** "5 workspaces · Acme" with one team, "5 workspaces · 2 teams" with more. */
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
  /** From the server, in the rail's words; absent means show done/total only. */
  stage?: MissionStage;
  /** The team heading it sits under (R-24); null when the server names none. */
  team: string | null;
  workspaceId?: string;
  /** A person runs it from their own session; no runner takes its tasks. */
  local: boolean;
  held: boolean;
  /** Delivered: when, in ms; it is listed for 7 days after. */
  deliveredAt?: number;
}

/** Delivered missions stay listed this long (R-24). */
export const DELIVERED_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 14", in the reader's own time zone. */
export function deliveredDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** What a mission row says besides its title and stage: its delivered day, or that a person runs it. */
export function missionMeta(row: Pick<MissionRow, 'deliveredAt' | 'local'>): string | null {
  if (row.deliveredAt !== undefined) return `delivered ${deliveredDay(row.deliveredAt)}`;
  if (row.local) return 'local session';
  return null;
}

const STAGE_WORD: Record<MissionStageStep, string> = {
  building: 'building', verifying: 'verifying', delivering: 'delivering', delivered: 'delivered', on_hold: 'on hold', planning: 'planning',
};

/** The stage in one word or two, for the mission row; null without a stage. */
export function missionStageWord(row: Pick<MissionRow, 'stage'>): string | null {
  return row.stage ? STAGE_WORD[row.stage.step] ?? null : null;
}

/** The stage and what it waits on, for the heading: `verifying: 2 checks left`. */
export function missionStageLine(row: Pick<MissionRow, 'stage'>): string | null {
  const word = missionStageWord(row);
  if (!word) return null;
  return row.stage!.waitingOn ? `${word}: ${row.stage!.waitingOn}` : word;
}

function sameLocalDay(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === new Date(now).toDateString();
}

function emptyRow(key: string, title: string): MissionRow {
  return { key, title, done: 0, total: 0, running: 0, planning: false, team: null, local: false, held: false };
}

export function missionRows(state: TopState, now: number = Date.now()): MissionRow[] {
  const workers = workerByTask(state);
  const map = new Map<string, MissionRow>();
  const serverCounts = new Map<string, { done: number; total: number }>();
  for (const t of relevantTasks(state, workers)) {
    const key = t.missionId || NO_MISSION;
    let row = map.get(key);
    if (!row) {
      row = emptyRow(key, key === NO_MISSION ? '(no mission)' : t.mission?.title || `mission ${key.slice(0, 8)}`);
      map.set(key, row);
    }
    row.total++;
    if (t.status === 'completed') row.done++;
    const w = workers.get(t.id);
    if (w && (BUSY.includes(w.status) || w.status === 'waiting')) row.running++;
    if (t.mission?.taskCounts) serverCounts.set(key, t.mission.taskCounts);
    if (t.mission?.stage && STAGE_WORD[t.mission.stage.step]) row.stage = t.mission.stage;
    if (t.mission?.isHeld) row.held = true;
    if (t.mission?.executor === 'local') row.local = true;
    row.workspaceId ??= taskWorkspaceId(t);
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

  // Every open mission of the runner's workspaces, and those delivered in the
  // last 7 days (R-24), even when this runner has no work in them.
  const inWorkspace = inView(state);
  for (const m of state.recentMissions ?? []) {
    if (!inWorkspace(m.workspaceId)) continue;
    const finished = m.status === 'completed';
    const at = finished && m.completedAt ? Date.parse(m.completedAt) : NaN;
    let row = map.get(m.id);
    if (!row) {
      // Not in the task list: listed only while open, or delivered inside the window.
      if (finished && !(at >= now - DELIVERED_DAYS * 86_400_000)) continue;
      row = emptyRow(m.id, m.title);
      map.set(m.id, row);
    }
    row.workspaceId ??= m.workspaceId;
    if (m.stage && STAGE_WORD[m.stage.step]) row.stage ??= m.stage;
    if (m.isHeld) row.held = true;
    if (m.executor === 'local') row.local = true;
    if (finished && !Number.isNaN(at)) row.deliveredAt = at;
  }

  const wsById = new Map(workspaceList(state).map(w => [w.id, w]));
  const teamOrder = new Map(teamList(state).map((t, i) => [t.name, i]));
  for (const row of map.values()) {
    const w = row.workspaceId ? wsById.get(row.workspaceId) : undefined;
    row.team = w && teamKey(w) ? teamName(w) : null;
  }

  const rank = (r: MissionRow) => (r.deliveredAt !== undefined ? 2 : r.held || r.stage?.step === 'on_hold' ? 1 : 0);
  const teamRank = (r: MissionRow) => (r.team === null ? Number.MAX_SAFE_INTEGER : teamOrder.get(r.team) ?? Number.MAX_SAFE_INTEGER - 1);
  const rows = [...map.values()].filter(r => r.key !== NO_MISSION);
  rows.sort((a, b) =>
    teamRank(a) - teamRank(b)
    || rank(a) - rank(b)
    || (rank(a) === 2 ? (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0) : (b.running > 0 ? 1 : 0) - (a.running > 0 ? 1 : 0))
    || a.title.localeCompare(b.title));
  // `(no mission)` is always there, last, so loose tasks have a home.
  rows.push(map.get(NO_MISSION) ?? emptyRow(NO_MISSION, '(no mission)'));
  return rows;
}

/** The mission the right pane shows: the selection if it still exists, else the first. */
export function currentMission(state: TopState, now: number = Date.now()): MissionRow {
  const rows = missionRows(state, now);
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
  /** Running rows: backend and route in words, "Claude · API key (team)" (R-40). Absent when the runner did not record one. */
  route?: string;
  /** Running rows: "$0.08" billed or "~$0.08" estimated; never for a plan run (R-41). */
  dollars?: string;
}

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}d`;
}

export function untilWords(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function roleLabel(slug: string | null | undefined): string | undefined {
  if (!slug) return undefined;
  return slug.split(/[-_]/).map(p => (p ? p[0].toUpperCase() + p.slice(1) : p)).join(' ');
}

// ── Claim outcomes (R-25) ───────────────────────────────────────────────────

/** The server's per-runner cooldown after a failed worker (claim route CLAIM_COOLDOWN_MS). */
export const RUNNER_COOLDOWN_MS = 60_000;
/** An outcome with no end time of its own describes the queue for this long. */
const OUTCOME_TTL_MS = 15 * 60_000;

function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Drop the outcomes of tasks that moved since the claim: no longer pending, or
 * changed on the server after the runner heard back. A task missing from the
 * list keeps its outcome (the list is windowed).
 */
function pruneMovedOutcomes(outcomes: Record<string, ClaimOutcome>, tasks: TopTask[]): Record<string, ClaimOutcome> {
  const byId = new Map(tasks.map(t => [t.id, t]));
  let changed = false;
  const next: Record<string, ClaimOutcome> = {};
  for (const [id, o] of Object.entries(outcomes)) {
    const t = byId.get(id);
    if (!t) { next[id] = o; continue; }
    if (t.status !== 'pending') { changed = true; continue; }
    // Server time against server time: the first list after the outcome fixes
    // what "unchanged" means; a later `updatedAt` retires it.
    const seen = isoMs(o.seenUpdatedAt);
    const updated = isoMs(t.updatedAt) ?? 0;
    if (seen === null) { next[id] = { ...o, seenUpdatedAt: new Date(updated).toISOString() }; changed = true; continue; }
    if (updated > seen) { changed = true; continue; }
    next[id] = o;
  }
  return changed ? next : outcomes;
}

/** The newest server `updatedAt` in the list: what the broad claim had in view. */
function stampBroad(o: ClaimOutcome, tasks: TopTask[]): ClaimOutcome {
  if (o.seenUpdatedAt) return o;
  let max: number | null = null;
  for (const t of tasks) {
    const u = isoMs(t.updatedAt);
    if (u !== null && (max === null || u > max)) max = u;
  }
  return max === null ? o : { ...o, seenUpdatedAt: new Date(max).toISOString() };
}

/** Same rule as the runner's store (claim-outcomes.ts), for a runner that sends the frame as it got it. */
function carryWalls(prev: ClaimOutcome | null, next: ClaimOutcome): ClaimOutcome {
  if (!prev?.walls?.length) return next;
  const silent = next.reason === 'claimed' || next.reason === 'refused' || next.reason === 'context_paused';
  if (!silent && !next.walls?.length) return next;
  const have = new Set((next.walls ?? []).map(w => w.backend));
  const kept = prev.walls.filter(w => {
    const t = isoMs(w.resetsAt);
    return !have.has(w.backend) && t !== null && t > next.at;
  });
  if (kept.length === 0) return next;
  return { ...next, walls: [...(next.walls ?? []), ...kept], summary: next.summary ?? prev.summary };
}

/** The walls of an outcome that still hold at `now`; a wall with no known reset holds while the outcome is fresh. */
function activeWalls(o: ClaimOutcome, now: number): NonNullable<ClaimOutcome['walls']> {
  return (o.walls ?? []).filter(w => {
    const reset = isoMs(w.resetsAt);
    return reset === null ? now - o.at <= OUTCOME_TTL_MS : reset > now;
  });
}

/** Is this outcome still a true account of the task? */
function outcomeLive(o: ClaimOutcome, now: number): boolean {
  if (o.walls && o.walls.length > 0) return activeWalls(o, now).length > 0;
  if (o.exclusion === 'runner_cooldown') return now - o.at < RUNNER_COOLDOWN_MS;
  const until = isoMs(o.until);
  if (until !== null) return until > now;
  return now - o.at <= OUTCOME_TTL_MS;
}

/** The task's last claim outcome, when it still holds and the task has not moved since. */
export function liveTaskOutcome(task: TopTask, state: TopState, now: number): ClaimOutcome | null {
  const o = state.claimOutcomes.tasks[task.id];
  if (!o || task.status !== 'pending') return null;
  const seen = isoMs(o.seenUpdatedAt);
  const updated = isoMs(task.updatedAt);
  if (seen !== null && updated !== null && updated > seen) return null;
  return outcomeLive(o, now) ? o : null;
}

function liveBroad(state: TopState, now: number): ClaimOutcome | null {
  const o = state.claimOutcomes.broad;
  return o && outcomeLive(o, now) ? o : null;
}

function taskBackend(t: TopTask): string {
  return t.backend || 'claude';
}

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const WALL_WORD: Record<string, string> = { account_seat: 'plan limit', provider_pause: 'rate limit', tenant_budget: 'tenant budget' };

export function wallWord(kind: string): string {
  return WALL_WORD[kind] ?? 'usage limit';
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A lift time in this machine's local time: `18:30` today, `Thu 00:00` this week, `Oct 16 04:00` later. */
export function localLiftTime(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock;
  if (d.getTime() - now < 6 * 24 * 3_600_000 && d.getTime() > now) return `${WEEKDAY[d.getDay()]} ${clock}`;
  return `${MONTH[d.getMonth()]} ${d.getDate()} ${clock}`;
}

export interface ProviderHold {
  backend: string;
  provider: string;
  /** `plan limit`, `rate limit`, ... */
  word: string;
  /** When it lifts (ISO), or null when the server did not say. */
  resetsAt: string | null;
}

/** The wall on `backend` an outcome names, the soonest to lift first. */
export function wallFor(o: ClaimOutcome, backend: string, now: number) {
  const walls = activeWalls(o, now).filter(w => w.backend === backend);
  walls.sort((a, b) => (isoMs(a.resetsAt) ?? Infinity) - (isoMs(b.resetsAt) ?? Infinity));
  return walls[0] ?? null;
}

/**
 * The provider limits that hold all of a provider's work (R-25, AC-11): the
 * last broad claim was held by that provider's wall, or every pending task of
 * that provider in view was held by it on its own claim. Said once, in the
 * header, instead of on every row.
 */
export function providerHolds(state: TopState, now: number): ProviderHold[] {
  const out = new Map<string, ProviderHold>();
  const add = (w: { kind: string; backend: string; resetsAt: string | null }) => {
    const prev = out.get(w.backend);
    if (prev && (isoMs(prev.resetsAt) ?? Infinity) <= (isoMs(w.resetsAt) ?? Infinity)) return;
    out.set(w.backend, { backend: w.backend, provider: PROVIDER_NAME[w.backend] ?? w.backend, word: wallWord(w.kind), resetsAt: w.resetsAt ?? null });
  };
  const broad = liveBroad(state, now);
  if (broad) for (const w of activeWalls(broad, now)) add(w);

  const workers = workerByTask(state);
  const pending = relevantTasks(state, workers).filter(t => t.status === 'pending' && !workers.has(t.id));
  const backends = new Set(pending.map(taskBackend));
  for (const b of backends) {
    if (out.has(b)) continue;
    const mine = pending.filter(t => taskBackend(t) === b);
    const walls = mine.map(t => {
      const o = liveTaskOutcome(t, state, now);
      return o ? wallFor(o, b, now) : null;
    });
    if (walls.length > 0 && walls.every(Boolean)) for (const w of walls) add(w!);
  }
  return [...out.values()];
}

/** The runner's hold, while it is in force at `now` (a lapsed `until` reads as none). */
export function heldNow(state: TopState, now: number): RunnerHold | null {
  const h = state.runner.hold;
  return h && isRunnerHoldActive(h, now) ? h : null;
}

/** `N running finish`, or that nothing is running. */
export function holdRunningWords(running: number): string {
  return running === 0 ? 'nothing is running' : `${running} running finish${running === 1 ? 'es' : ''}`;
}

/**
 * The line under the header while held (R-33): since when, what still runs,
 * that h resumes, and when it resumes on its own (`--for`). Null when not held.
 * "On hold since 09:12: nothing new starts, 3 running finish. h resumes."
 */
export function holdLine(state: TopState, now: number): string | null {
  const h = heldNow(state, now);
  if (!h) return null;
  const until = h.until ? ` until ${localLiftTime(h.until, now)}` : '';
  // R-33: what still runs, and what `buildd stop` paused.
  const paused = Object.values(state.workers).filter(w => w.status === 'waiting' && w.waitingFor?.type === 'pause').length;
  const pausedWords = paused > 0 ? `, ${paused} paused` : '';
  return `On hold since ${localLiftTime(h.since, now)}${until}: nothing new starts, ${holdRunningWords(busySlots(state))}${pausedWords}. h resumes${h.until ? ' now' : ''}.`;
}

/** `Claude work waits for the plan limit: resumes Thu 00:00 (in 17h)`. */
export function providerHoldLine(h: ProviderHold, now: number): string {
  const head = `${h.provider} work waits for the ${h.word}`;
  const reset = isoMs(h.resetsAt);
  if (reset === null || reset <= now) return `${head}.`;
  return `${head}: resumes ${localLiftTime(h.resetsAt!, now)} (in ${untilWords(reset - now)})`;
}

/** Exclusion codes in words; a code missing here reads as the server's first sentence. */
export const EXCLUSION_WORDS: Record<string, string> = {
  mission_local: 'local session',
  mission_held: 'mission is on hold',
  task_held: 'held by a person',
  task_reserved: 'reserved by a local session',
  already_claimed: 'another runner has it',
  active_worker: 'another runner has it',
  workspace_cap: 'workspace is at its task limit',
  mission_concurrent: 'mission is at its task limit',
  mission_paced: 'mission is paced',
  mission_budget: 'mission budget is spent',
  codex_single_flight: 'one Codex run per workspace at a time',
  path_overlap: 'waits for work on the same files',
  soft_overlap: 'waits for work on the same files',
  advisory_manifest: 'waits for work on the same files',
  ordered_behind: 'waits for work on the same files',
  role_mismatch: 'needs a role this runner lacks',
  runner_preference: 'for another kind of runner',
  workspace_executor: 'its workspace runs work elsewhere',
  capability_mismatch: 'needs Codex, which this runner lacks',
  subject_dead: 'its PR is closed',
  connector_mismatch: 'needs a connector this runner lacks',
  provider_unavailable: 'its model provider is off',
  routing_paused: 'routing is paused',
  account_cap: 'account is at its worker limit',
  rate_limited: 'claimed too recently, retry soon',
  delegation_unmet: 'needs access a person has not granted',
};

/** Codes that only say the task moved; the list catches up on its own. */
export const MOVED_CODES = new Set(['not_found', 'not_pending', 'state_changed', 'duplicate_worker', 'sibling_retry_open']);

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).replace(/[.!?]$/, '').trim();
}

/** Why the task's dependencies hold it, by title when the list has them. */
function dependencyWords(task: TopTask, state: TopState): string | null {
  const deps = (task.dependsOn ?? [])
    .map(id => state.tasks.find(t => t.id === id))
    .filter((t): t is TopTask => !!t && !TERMINAL.has(t.status));
  if (deps.length === 0) return null;
  const more = deps.length > 1 ? ` and ${deps.length - 1} more` : '';
  return `waits on: ${deps[0].title}${more}`;
}

/** A plan or rate limit on this task's provider, short when the header says it already. */
function wallWords(o: ClaimOutcome, task: TopTask, holds: ProviderHold[], now: number): string | null {
  const b = taskBackend(task);
  const w = wallFor(o, b, now) ?? activeWalls(o, now)[0] ?? null;
  if (!w) return null;
  const word = wallWord(w.kind);
  if (holds.some(h => h.backend === w.backend)) return word;
  return w.resetsAt && (isoMs(w.resetsAt) ?? 0) > now ? `${word}, ${localLiftTime(w.resetsAt, now)}` : word;
}

/** What a live claim outcome says holds the task, in words; null when it saw nothing holding it. */
function outcomeWords(o: ClaimOutcome, task: TopTask, state: TopState, holds: ProviderHold[], now: number): string | null {
  if (o.walls && o.walls.length > 0) {
    const w = wallWords(o, task, holds, now);
    if (w) return w;
  }
  if (o.reason === 'refused') return `refused: ${o.refusal || `HTTP ${o.status ?? '?'}`}`;
  if (o.reason === 'context_paused') {
    const until = isoMs(o.until);
    return until !== null && until > now ? `paused after repeated failures, ${untilWords(until - now)}` : 'paused after repeated failures';
  }
  const code = o.exclusion;
  if (code) {
    if (MOVED_CODES.has(code)) return null;
    if (code === 'runner_cooldown') {
      const left = Math.max(1, Math.ceil((o.at + RUNNER_COOLDOWN_MS - now) / 60_000));
      return `cooldown, ${left} min`;
    }
    if (code === 'deps_blocked') return dependencyWords(task, state) ?? 'waits on a dependency';
    if (code === 'deferred') {
      const until = isoMs(o.until) ?? isoMs(task.startAt);
      return until !== null && until > now ? `starts in ${untilWords(until - now)}` : 'starts later';
    }
    if (code === 'workspace_paused') {
      return o.until && (isoMs(o.until) ?? 0) > now ? `workspace paused until ${localLiftTime(o.until, now)}` : 'workspace paused';
    }
    if (code === 'budget_paused') return 'held by a usage limit';
    if (EXCLUSION_WORDS[code]) return EXCLUSION_WORDS[code];
    return o.detail ? firstSentence(o.detail) : codeWords(code);
  }
  if (o.reason === 'race_lost') return 'another runner took it';
  if (o.reason === 'deps_blocked') return dependencyWords(task, state) ?? 'waits on a dependency';
  if (o.reason === 'capability_mismatch') return EXCLUSION_WORDS.capability_mismatch;
  if (o.reason === 'path_overlap_blocked' || o.reason === 'repo_busy') return 'waits for work on the same files';
  return null;
}

/** Deferral reasons the server counts on a broad claim, in words. */
export const DEFERRAL_WORDS: Record<string, string> = {
  ...EXCLUSION_WORDS,
  budget_paused: 'held by a usage limit',
  oauth_parallelism: 'the plan allows only a few sessions at once',
  duplicate_worker: 'a worker already has it',
  sibling_retry_open: 'a retry of it is already open',
  fix_not_needed: 'its fix is no longer needed',
  runner_capability: 'needs something this runner lacks',
  role_env_unsatisfied: 'its role needs settings this runner lacks',
  managed_concurrency: 'managed runs are at their limit',
  managed_runner_hours: 'managed runner hours are used up',
  hosted_runner_hours: 'hosted runner hours are used up',
  no_personal_credential: 'needs a personal login that is not set up',
  provider_not_allowed: 'its model provider is not allowed here',
  tier_policy: 'its model tier is not allowed here',
};

/** Words for a deferral or exclusion code; a code this view has no words for never prints raw. */
function codeWords(code: string): string {
  return DEFERRAL_WORDS[code] ?? 'held by the server';
}

/**
 * A broad claim reports deferral counts by reason, not which task each one
 * was. So it is a runner-wide reason, said as one only when a single reason
 * accounts for every deferral; with several, no one is pinned on this row.
 */
function broadDeferralWords(o: ClaimOutcome): string | null {
  const entries = Object.entries(o.deferrals ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  if (entries.length === 1) return `held at the last claim (runner-wide): ${codeWords(entries[0][0])}`;
  return 'held at the last claim, for reasons it did not tie to this task';
}

/**
 * Why a task this runner does not hold is waiting, in words (R-25). The
 * server's answer to the runner's last claim comes first, since it is what
 * actually held the task; then what the list itself shows. "Ready" only when
 * the last claim saw nothing holding it.
 */
export function waitingReason(task: TopTask, state: TopState, now: number, holds: ProviderHold[] = providerHolds(state, now)): string {
  if (task.status === 'assigned' || task.status === 'in_progress') return 'another runner has it';
  const own = liveTaskOutcome(task, state, now);
  if (own) {
    const words = outcomeWords(own, task, state, holds, now);
    if (words) return words;
  }
  const broad = liveBroad(state, now);
  const updated = isoMs(task.updatedAt);
  const broadSeen = isoMs(broad?.seenUpdatedAt);
  const broadSawIt = !!broad && (updated === null || broadSeen === null || updated <= broadSeen);
  if (broad && broadSawIt && broad.walls?.length) {
    const words = wallFor(broad, taskBackend(task), now) ? wallWords(broad, task, holds, now) : null;
    if (words) return words;
  }
  if (heldNow(state, now)) return 'runner is on hold';
  if (task.mission?.isHeld) return 'mission is on hold';
  const deps = dependencyWords(task, state);
  if (deps) return deps;
  if (task.startAt) {
    const at = new Date(task.startAt).getTime();
    if (!Number.isNaN(at) && at > now) return `starts in ${untilWords(at - now)}`;
  }
  const busy = busySlots(state);
  if (busy >= state.runner.maxConcurrent) return `runner is full (${busy} of ${state.runner.maxConcurrent} busy)`;
  if (broad && broadSawIt && broad.reason !== 'claimed') {
    if (broad.reason === 'all_candidates_deferred') {
      const words = broadDeferralWords(broad);
      if (words) return words;
    }
    // The claim ran and took nothing, and named nothing holding this task.
    if (!own) return 'the server skipped it at the last claim';
  }
  // Only a claim of this very task that found nothing holding it says ready.
  return own ? 'ready, next claim picks it up' : 'not tried yet';
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

export function matchesFilter(title: string, filter: string): boolean {
  return !filter || title.toLowerCase().includes(filter.toLowerCase());
}

export function taskRows(state: TopState, now: number): TaskRow[] {
  const workers = workerByTask(state);
  const mission = currentMission(state, now);
  const tasks = relevantTasks(state, workers).filter(t => (t.missionId || NO_MISSION) === mission.key);
  const running: TaskRow[] = [];
  const waiting: TaskRow[] = [];
  const done: TaskRow[] = [];
  const holds = providerHolds(state, now);

  for (const t of tasks) {
    if (!matchesFilter(t.title, state.filter)) continue;
    const w = workers.get(t.id);
    const role = roleLabel(t.roleSlug);
    const base = { taskId: t.id, title: t.title || w?.taskTitle || t.id.slice(0, 8), role };

    if (w && (BUSY.includes(w.status) || w.status === 'waiting' || w.status === 'idle')) {
      const elapsedMs = now - (w.startedAt || now);
      const tokens = w.tokenTally ? w.tokenTally.inputTokens + w.tokenTally.outputTokens : undefined;
      const route = w.route ? runWords(w.route.backend, w.route) : undefined;
      const dollars = rowDollars(workerSpend(w)) ?? undefined;
      const money = { ...(route ? { route } : {}), ...(dollars ? { dollars } : {}) };
      if (w.status === 'waiting' && w.waitingFor?.type === 'pause') {
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'paused', elapsedMs, reason: 'paused, a resumes it', tokens, ...money });
      } else if (w.status === 'waiting' && w.waitingFor) {
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'asking', elapsedMs, question: w.waitingFor.prompt, tokens, ...money });
      } else {
        const action = w.currentAction || lastToolLabel(w) || 'starting';
        running.push({ ...base, workerId: w.id, group: 'running', kind: 'running', elapsedMs, action, tokens, ...money });
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

    waiting.push({ ...base, group: 'waiting', kind: 'waiting', reason: waitingReason(t, state, now, holds) });
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

// ── routes and dollars (R-39 to R-42) ──────────────────────────────────────

function activeToday(w: TopWorker, now: number): boolean {
  const at = w.completedAt ?? w.lastActivity ?? w.startedAt;
  return typeof at === 'number' && new Date(at).toDateString() === new Date(now).toDateString();
}

/**
 * The header's "Runs on:" line: this machine's own routes, plus the routes the
 * claims delivered that runs used today (the team's key or endpoint). A plan
 * whose login is expired is left out: routeProblemLines says it (AC-24).
 */
export function runsOn(state: TopState, now: number): string | null {
  const expired = new Set(state.runner.routeProblems.map(p => p.backend));
  const used = Object.values(state.workers)
    .filter(w => w.route && activeToday(w, now))
    .map(w => w.route as RunRoute)
    .filter(r => !(r.bucket === 'plan' && expired.has(r.backend)));
  const routes: RunRoute[] = [];
  for (const r of [...state.runner.routes, ...used]) if (!routes.some(x => sameRoute(x, r))) routes.push(r);
  return runsOnLine(routes);
}

/** Routes that do not work, each on its own line so a narrow terminal never cuts one off. */
export function routeProblemLines(state: TopState): string[] {
  return state.runner.routeProblems.map(p => p.text);
}

/** Today's totals on this runner per bucket (R-42), from the workers top holds. */
export function spendToday(state: TopState, now: number): SpendTotals {
  return todayTotals(Object.values(state.workers), now);
}

/** "Today: $2.10 billed, ~$0.40 estimated · plans covered about $41 at list price", or null. */
export function spendTodayLine(state: TopState, now: number): string | null {
  return todayLine(spendToday(state, now));
}
