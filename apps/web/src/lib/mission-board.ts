/**
 * The mission page's Board and Lanes model.
 * Pure and client-safe: rows in, one view model out. The Board, the Lanes tab
 * and their live overlay all read it, so a tile, a bar and a side-rail row can
 * never disagree about a task's state.
 *
 * Row membership and state come from the feed's own rules — `foldMissionDeliverables`
 * (D1: attempts and re-creations fold under their parent) and `deriveFeedTaskState`
 * — so the Board counts exactly what the pulse and the Feed tab count (F3). This
 * module only refines the feed's five states into the finer ones a tile draws
 * (a moving row is `running` or `review`, a failed one `ci_failed` or `fixing`,
 * a queued one `ready` or `blocked`).
 *
 * Nothing here stores progress: a tile shows elapsed time plus one notch per
 * milestone the agent reported. The runner slot an agent held is derived from
 * start/end overlap (`assignSlots`), since no column records it.
 */
import { assignSlots, occupiedSlots } from '@/components/fleet/slot-lanes-layout';
import { groupTasksByPhase } from './flight-strip-nav';
import {
  deriveFeedPrState,
  deriveFeedTaskState,
  foldMissionDeliverables,
  orderDeliverables,
  type DeliverableRow,
  type FeedPrState,
  type MissionFeedTaskInput,
} from './mission-pulse';
import { deriveWorkKind, LIVE_WORKER_STATUSES } from './task-presentation';
import { boardTaskLabel } from './mission-board-label';
import { resolveRunnerDisplay, runnerKey, type RunnerDisplay, type RunnerHeartbeatLike } from './runner-display';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface BoardMilestone {
  /** Epoch ms. */
  ts: number;
  label: string;
}

export interface BoardWorkerInput {
  id: string;
  status: string;
  /** `workers.runner`: a runner claims with its local UI URL. Never shown raw. */
  runner: string | null;
  /** Joins the runner's heartbeat (with `localUiUrl`); optional. */
  accountId?: string | null;
  localUiUrl?: string | null;
  startedAt: number | null;
  /** When the claim inserted the row: where a claimed, not-yet-started worker's bar begins. */
  createdAt?: number | null;
  completedAt: number | null;
  updatedAt: number | null;
  mergedAt: number | null;
  prNumber: number | null;
  prUrl: string | null;
  prLifecycleStatus: string | null;
  currentAction: string | null;
  waitingFor: { prompt: string; options: string[] } | null;
  milestones: BoardMilestone[];
  linesAdded: number | null;
  linesRemoved: number | null;
}

export interface BoardTaskInput extends MissionFeedTaskInput {
  /** `tasks.label`, when the column exists and was set. */
  label?: string | null;
  outputRequirement?: string | null;
  ciRetryPrNumber?: number | null;
  /** Newest first, as the mission query orders them. */
  workers: BoardWorkerInput[];
}

export interface BoardRoleInput {
  slug: string;
  name: string;
  color: string;
}

export interface BoardArtifactInput {
  key?: string | null;
  type?: string | null;
}

export interface BoardCriterionInput {
  type: string;
  label?: string;
  key?: string;
  artifactType?: string;
}

export interface BoardCriterionStateInput {
  index: number;
  verdict: string;
}

export interface MissionBoardInput {
  tasks: readonly BoardTaskInput[];
  roles?: readonly BoardRoleInput[];
  now: number;
  missionCreatedAt: number;
  /** Set once the mission completed. */
  missionCompletedAt?: number | null;
  missionStatus: string;
  criteria?: readonly BoardCriterionInput[];
  criteriaState?: readonly BoardCriterionStateInput[];
  artifacts?: readonly BoardArtifactInput[];
  /** When a human steered the mission (answers, guidance): the Board's "? you" marks. */
  humanTouches?: readonly number[];
  /** Heartbeats of the runners these workers ran on, for hostnames (`resolveRunnerDisplay`). */
  runnerHeartbeats?: readonly RunnerHeartbeatLike[];
  /**
   * The team's fleet capacity (`fleetCapacity` over fresh heartbeats) — the
   * same denominator Home prints. Absent: the slots this mission's bars drew.
   */
  fleetCapacity?: number | null;
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type BoardStatus =
  | 'waiting' // an agent asked the human
  | 'running'
  | 'review' // PR open, CI running or green, awaiting merge
  | 'ci_failed'
  | 'fixing' // a fix attempt is queued or running on a red PR
  | 'failed'
  | 'ready'
  | 'blocked'
  | 'merged'
  | 'done';

export const BOARD_LANDED: ReadonlySet<BoardStatus> = new Set(['merged', 'done']);
const BOARD_QUEUED: ReadonlySet<BoardStatus> = new Set(['ready', 'blocked']);

export interface BoardDep {
  id: string;
  scope: string | null;
  label: string;
  /** Landed (or at least in review) — the dependency no longer holds this task. */
  ok: boolean;
}

export interface BoardTask {
  id: string;
  title: string;
  scope: string | null;
  label: string;
  glyph: string | null;
  roleSlug: string | null;
  roleName: string | null;
  /** The role's own colour (`workspaceSkills.color`), never a constant. */
  roleColor: string | null;
  phaseKey: string;
  status: BoardStatus;
  /** Runner (display name) of the live worker (the fix attempt's, while fixing), else the last one. */
  runner: string | null;
  /** 0-based slot on that runner, derived from overlap. */
  slot: number | null;
  workerId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** When the current wait began (a waiting task). */
  waitStartedAt: number | null;
  milestones: BoardMilestone[];
  currentAction: string | null;
  pr: { number: number; url: string | null; state: FeedPrState } | null;
  deps: BoardDep[];
  unblocks: Array<{ id: string; scope: string | null; label: string }>;
  lines: { added: number; removed: number } | null;
  /** Attempts beyond the first (↻2 = one retry). */
  attempt: number;
  waitingFor: { prompt: string; options: string[] } | null;
}

export interface BoardPhase {
  key: string;
  /** 1-based display number. */
  ordinal: number;
  label: string | null;
  taskIds: string[];
  done: number;
  total: number;
}

export type BoardCriterionState = 'pass' | 'fail' | 'running' | 'partial' | 'pending';

export interface BoardCriterion {
  label: string;
  value: string;
  state: BoardCriterionState;
  /** 0..1 fill for a partial box. */
  frac: number;
}

export interface BoardRunner {
  /** The raw runner key (its URL): lanes group on this, never show it. */
  id: string;
  name: string;
  initial: string;
  machine: string | null;
  /** Slots this runner needed during the mission. */
  capacity: number;
  /** What holds each slot now: a live task, a waiting one, or nothing. */
  slots: Array<{ taskId: string; waiting: boolean } | null>;
}

export type TickerKind = 'merged' | 'pr' | 'claimed' | 'ci_failed' | 'asked' | 'done';

export interface TickerEvent {
  kind: TickerKind;
  at: number;
  taskId: string;
  text: string;
}

export type LaneBarTone = 'live' | 'done' | 'waiting' | 'plan';

export interface MissionLaneBar {
  id: string;
  taskId: string;
  /** Display name (`resolveRunnerDisplay`). */
  runner: string;
  /** The raw runner key its lane groups on. */
  runnerId: string;
  start: number;
  end: number | null;
  tone: LaneBarTone;
  scope: string | null;
  label: string;
  retry: boolean;
  /** ✓ merged/done · ✕ CI failed · ◌ in CI — nothing while live. */
  endMark: 'ok' | 'fail' | 'ci' | null;
  waits: Array<{ start: number; end: number | null }>;
  deps: string[];
}

export interface MissionBoardModel {
  now: number;
  startedAt: number;
  /** When the mission completed; null while it runs. */
  endedAt: number | null;
  complete: boolean;
  /** `T+ 11:50` while running, `took 37:00` once complete. */
  clockLabel: string;
  clockPrefix: 'T+' | 'took';
  phases: BoardPhase[];
  tasks: Record<string, BoardTask>;
  landed: { done: number; total: number };
  criteria: BoardCriterion[];
  criteriaPassed: number;
  runners: BoardRunner[];
  live: number;
  capacity: number;
  needsYou: string[];
  inReview: string[];
  upNext: string[];
  ticker: TickerEvent[];
  bars: MissionLaneBar[];
  merges: Array<{ at: number; pr: number; taskId: string }>;
  ciFails: Array<{ at: number; pr: number | null; taskId: string }>;
  humanTouches: number[];
  record: {
    prsMerged: number;
    linesAdded: number;
    linesRemoved: number;
    ciFixes: number;
    decisions: number;
    peakAgents: number;
    runners: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function epoch(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = new Date(v as string | Date).getTime();
  return Number.isFinite(t) ? t : null;
}

/** `11:50` — minutes:seconds under an hour, `h:mm:ss` past it. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** `<1m`, `9m`, `2h`, `3d`. */
export function formatAge(ms: number): string {
  if (!(ms >= 60_000)) return '<1m';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Milestones a tile draws as notches: what the agent said it was doing
 * (`status` entries), in time order. Checkpoints and the runner's audit
 * entries are bookkeeping, not progress.
 */
export function selectMilestones(raw: unknown, max = 24): BoardMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardMilestone[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (r.type !== undefined && r.type !== 'status') continue;
    const ts = num(r.ts) ?? num(r.timestamp);
    const label = str(r.label);
    if (ts == null || !label) continue;
    out.push({ ts, label: label.length > 160 ? `${label.slice(0, 159)}…` : label });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-max);
}

/** Normalise one DB worker row (dates, jsonb) into the board's input. */
export function toBoardWorkerInput(w: Record<string, unknown>): BoardWorkerInput {
  const wf = w.waitingFor as { prompt?: unknown; options?: unknown } | null | undefined;
  const options = Array.isArray(wf?.options)
    ? (wf!.options as unknown[]).map(o => (typeof o === 'string' ? o : str((o as { label?: unknown })?.label))).filter((o): o is string => !!o)
    : [];
  return {
    id: String(w.id),
    status: str(w.status) ?? 'unknown',
    runner: str(w.runner),
    accountId: str(w.accountId),
    localUiUrl: str(w.localUiUrl),
    startedAt: epoch(w.startedAt),
    createdAt: epoch(w.createdAt),
    completedAt: epoch(w.completedAt),
    updatedAt: epoch(w.updatedAt),
    mergedAt: epoch(w.mergedAt),
    prNumber: num(w.prNumber),
    prUrl: str(w.prUrl),
    prLifecycleStatus: str(w.prLifecycleStatus),
    currentAction: str(w.currentAction),
    waitingFor: wf && typeof wf.prompt === 'string' ? { prompt: wf.prompt, options } : null,
    milestones: selectMilestones(w.milestones),
    linesAdded: num(w.linesAdded),
    linesRemoved: num(w.linesRemoved),
  };
}

/** One DB task row (with its workers, newest first) → the board's input. */
export function toBoardTaskInput(t: Record<string, unknown> & { id: string; title: string; status: string }): BoardTaskInput {
  const workers = (Array.isArray(t.workers) ? t.workers : []).map(w => toBoardWorkerInput(w as Record<string, unknown>));
  const w0 = workers[0] ?? null;
  return {
    id: t.id,
    title: t.title,
    label: str(t.label),
    status: t.status,
    createdAt: new Date(epoch(t.createdAt) ?? 0),
    updatedAt: epoch(t.updatedAt) != null ? new Date(epoch(t.updatedAt)!) : null,
    taskClass: str(t.taskClass),
    parentTaskId: str(t.parentTaskId),
    mode: str(t.mode),
    kind: str(t.kind),
    roleSlug: str(t.roleSlug),
    category: str(t.category),
    creationSource: str(t.creationSource),
    dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).filter((d): d is string => typeof d === 'string') : null,
    missionPhaseIndex: num(t.missionPhaseIndex),
    missionPhaseLabel: str(t.missionPhaseLabel),
    outputRequirement: str(t.outputRequirement),
    ciRetryPrNumber: num(t.ciRetryPrNumber),
    worker: w0
      ? {
          status: w0.status,
          startedAt: w0.startedAt != null ? new Date(w0.startedAt) : null,
          updatedAt: w0.updatedAt != null ? new Date(w0.updatedAt) : null,
          prNumber: w0.prNumber,
          prUrl: w0.prUrl,
          prLifecycleStatus: w0.prLifecycleStatus,
          mergedAt: w0.mergedAt != null ? new Date(w0.mergedAt) : null,
        }
      : null,
    workers,
  };
}

const phaseKeyOf = (t: MissionFeedTaskInput) =>
  t.missionPhaseIndex != null && t.missionPhaseLabel != null ? `p${t.missionPhaseIndex}` : 'none';

const isLiveWorker = (w: BoardWorkerInput | null | undefined) => !!w && LIVE.has(w.status);

/**
 * The Board's state for one deliverable row, refining the feed's
 * (`deriveFeedTaskState`). `depsLanded` answers "is anything still holding it".
 */
export function deriveBoardStatus(row: DeliverableRow<BoardTaskInput>, depsLanded: boolean): BoardStatus {
  const { task } = row;
  const feed = deriveFeedTaskState(row);
  const pr = deriveFeedPrState(task.worker);
  const openAttempt = [...row.attempts].reverse().find(a => !TERMINAL.has(a.status) && a.taskClass !== 'work');
  const attemptLive = !!openAttempt && (isLiveWorker(openAttempt.workers[0]) || openAttempt.status === 'in_progress' || openAttempt.status === 'assigned');
  const redPr = pr?.state === 'ci_failed' || pr?.state === 'conflict';

  switch (feed.state) {
    case 'needs_you':
      if (feed.needsYou === 'input') return 'waiting';
      if (feed.needsYou === 'pr') return redPr ? 'ci_failed' : 'review';
      if (feed.needsYou === 'failed') return 'failed';
      return 'waiting';
    case 'moving':
      if (redPr && attemptLive) return 'fixing';
      if (isLiveWorker(task.workers[0]) || attemptLive || task.status === 'in_progress' || task.status === 'assigned') return 'running';
      return 'review';
    case 'failed':
      return redPr || openAttempt ? 'fixing' : 'failed';
    case 'queued':
      if (openAttempt && pr) return 'fixing';
      return depsLanded ? 'ready' : 'blocked';
    case 'done':
      return pr?.state === 'merged' ? 'merged' : 'done';
    default:
      return 'done';
  }
}

// ─── Criteria ─────────────────────────────────────────────────────────────────

function criterionRow(
  c: BoardCriterionInput,
  verdict: string | null,
  ctx: { prsMerged: number; prsExpected: number; open: number; landed: number; total: number; artifacts: readonly BoardArtifactInput[] },
): BoardCriterion {
  const pass = verdict === 'pass';
  switch (c.type) {
    case 'all_prs_merged': {
      const frac = ctx.prsExpected > 0 ? ctx.prsMerged / ctx.prsExpected : 0;
      return {
        label: 'PRs merged',
        value: `${ctx.prsMerged}/${ctx.prsExpected}`,
        state: pass ? 'pass' : verdict === 'fail' && frac >= 1 ? 'fail' : ctx.prsMerged > 0 ? 'partial' : 'pending',
        frac,
      };
    }
    case 'no_open_tasks':
      return {
        label: 'open tasks',
        value: `${ctx.open} open`,
        state: pass ? 'pass' : ctx.landed > 0 ? 'partial' : 'pending',
        frac: ctx.total > 0 ? ctx.landed / ctx.total : 0,
      };
    case 'command':
      return {
        label: c.label ?? 'command',
        value: pass ? 'exit 0' : verdict === 'fail' ? 'failed' : verdict === 'PENDING' ? 'running' : 'not run',
        state: pass ? 'pass' : verdict === 'fail' ? 'fail' : verdict === 'PENDING' ? 'running' : 'pending',
        frac: 0,
      };
    case 'artifact_exists': {
      const found = ctx.artifacts.some(a => (c.key ? a.key === c.key : c.artifactType ? a.type === c.artifactType : false));
      return {
        label: c.label ?? 'record',
        value: pass || found ? 'recorded' : 'none yet',
        state: pass || found ? 'pass' : 'pending',
        frac: 0,
      };
    }
    default:
      return {
        label: c.label ?? c.type,
        value: pass ? 'met' : verdict === 'fail' ? 'not met' : verdict === 'PENDING' ? 'checking' : 'not checked',
        state: pass ? 'pass' : verdict === 'fail' ? 'fail' : verdict === 'PENDING' ? 'running' : 'pending',
        frac: 0,
      };
  }
}

// ─── Build ────────────────────────────────────────────────────────────────────

const TICKER_MAX = 6;

export function buildMissionBoard(input: MissionBoardInput): MissionBoardModel {
  const { now } = input;
  const roles = new Map((input.roles ?? []).map(r => [r.slug, r]));
  const displayOf = (w: BoardWorkerInput) => resolveRunnerDisplay(w, input.runnerHeartbeats);
  const allById = new Map(input.tasks.map(t => [t.id, t]));
  const folded = foldMissionDeliverables(input.tasks);
  const ordered = orderDeliverables(folded.rows);

  // Folded ids → their row, so a dependency on an attempt or re-creation resolves.
  const rowIdFor = new Map<string, string>();
  for (const r of ordered) {
    rowIdFor.set(r.task.id, r.task.id);
    for (const a of r.attempts) rowIdFor.set(a.id, r.task.id);
  }

  const labelOf = new Map<string, { scope: string | null; label: string }>();
  for (const t of input.tasks) labelOf.set(t.id, boardTaskLabel(t));

  // Pass 1: raw status (landed-ness of deps is needed for ready/blocked).
  const feedLanded = new Map<string, boolean>();
  for (const r of ordered) {
    const s = deriveFeedTaskState(r).state;
    feedLanded.set(r.task.id, s === 'done' || s === 'skipped');
  }
  const inReviewish = (id: string) => {
    const r = ordered.find(x => x.task.id === id);
    if (!r) return true;
    return feedLanded.get(id) === true || (r.task.status === 'completed' && !!r.task.worker?.prNumber);
  };

  const tasks: Record<string, BoardTask> = {};
  const skipped = new Set<string>();
  for (const r of ordered) {
    const t = r.task;
    if (deriveFeedTaskState(r).state === 'skipped') {
      skipped.add(t.id);
      continue;
    }
    const depIds = (t.dependsOn ?? []).map(d => rowIdFor.get(d) ?? d).filter(d => d !== t.id && allById.has(d));
    const deps: BoardDep[] = [...new Set(depIds)].map(d => ({
      id: d,
      ...labelOf.get(d)!,
      ok: feedLanded.get(d) === true || inReviewish(d),
    }));
    const depsLanded = depIds.every(d => feedLanded.get(d) === true);
    const status = deriveBoardStatus(r, depsLanded);
    const openAttempt = [...r.attempts].reverse().find(a => !TERMINAL.has(a.status));
    const activeWorker = (status === 'fixing' && openAttempt?.workers[0]) || t.workers[0] || null;
    const own = t.workers[0] ?? null;
    const role = t.roleSlug ? roles.get(t.roleSlug) : undefined;
    const kind = deriveWorkKind({ kind: t.kind ?? null, roleSlug: t.roleSlug ?? null });
    const prState = deriveFeedPrState(t.worker);
    tasks[t.id] = {
      id: t.id,
      title: t.title,
      ...labelOf.get(t.id)!,
      glyph: kind?.glyph ?? null,
      roleSlug: t.roleSlug ?? null,
      roleName: role?.name ?? null,
      roleColor: role?.color ?? null,
      phaseKey: phaseKeyOf(t),
      status,
      runner: activeWorker ? displayOf(activeWorker)?.name ?? null : null,
      slot: null,
      workerId: activeWorker?.id ?? null,
      startedAt: activeWorker?.startedAt ?? null,
      endedAt: activeWorker && !isLiveWorker(activeWorker) ? activeWorker.completedAt ?? activeWorker.updatedAt : null,
      waitStartedAt: status === 'waiting' ? activeWorker?.updatedAt ?? null : null,
      milestones: activeWorker?.milestones ?? [],
      currentAction: isLiveWorker(activeWorker) ? activeWorker?.currentAction ?? null : null,
      pr: prState ? { number: prState.number, url: own?.prUrl ?? null, state: prState.state } : null,
      deps,
      unblocks: [],
      lines: own && (own.linesAdded || own.linesRemoved) ? { added: own.linesAdded ?? 0, removed: own.linesRemoved ?? 0 } : null,
      attempt: 1 + r.attempts.filter(a => a.workers.length > 0 || a.status !== 'pending').length,
      waitingFor: status === 'waiting' ? activeWorker?.waitingFor ?? null : null,
    };
  }
  for (const bt of Object.values(tasks)) {
    for (const d of bt.deps) tasks[d.id]?.unblocks.push({ id: bt.id, scope: bt.scope, label: bt.label });
  }

  // Phases, in pulse order.
  const rows = ordered.filter(r => !skipped.has(r.task.id));
  const phases: BoardPhase[] = groupTasksByPhase(rows.map(r => r.task)).map((g, i) => {
    const ids = g.tasks.map(t => t.id);
    return {
      key: g.index != null ? `p${g.index}` : 'none',
      ordinal: i + 1,
      label: g.label,
      taskIds: ids,
      done: ids.filter(id => BOARD_LANDED.has(tasks[id].status)).length,
      total: ids.length,
    };
  });

  const all = Object.values(tasks);
  const landedN = all.filter(t => BOARD_LANDED.has(t.status)).length;

  // ── Lanes: every worker that ran for this mission, on its runner ──
  type Span = MissionLaneBar;
  const bars: Span[] = [];
  const ciFails: MissionBoardModel['ciFails'] = [];
  for (const t of input.tasks) {
    const rowId = rowIdFor.get(t.id) ?? null;
    if (rowId && skipped.has(rowId)) continue;
    const isPlan = !rowId || t.mode === 'planning';
    const retry = !!rowId && rowId !== t.id;
    if (retry && t.ciRetryPrNumber != null) {
      ciFails.push({ at: epoch(t.createdAt) ?? now, pr: t.ciRetryPrNumber, taskId: rowId });
    }
    const lbl = labelOf.get(t.id)!;
    // Oldest first so the newest span wins its slot's later position.
    for (const w of [...t.workers].reverse()) {
      const live = isLiveWorker(w);
      // A claim inserts the worker (idle) before the runner stamps startedAt;
      // the tile already shows it on its runner, so the lane and the fleet
      // band count it from the claim.
      const start = w.startedAt ?? (live ? w.createdAt ?? w.updatedAt ?? now : null);
      if (start == null || !w.runner) continue;
      const end = live ? null : w.completedAt ?? w.updatedAt ?? start;
      const rowMerged = (rowId ? tasks[rowId] : undefined)?.status === 'merged';
      const endGlyph: MissionLaneBar['endMark'] = live || isPlan
        ? null
        : w.mergedAt || rowMerged || (!w.prNumber && w.status === 'completed' && !retry)
          ? 'ok'
          : w.prLifecycleStatus === 'ci_failed' || w.status === 'failed'
            ? 'fail'
            : w.prNumber
              ? 'ci'
              : w.status === 'completed' ? 'ok' : null;
      bars.push({
        id: w.id,
        taskId: rowId ?? t.id,
        runner: displayOf(w)?.name ?? w.runner,
        runnerId: runnerKey(w) ?? w.runner,
        start,
        end,
        tone: w.status === 'waiting_input' ? 'waiting' : live ? 'live' : isPlan ? 'plan' : 'done',
        scope: retry ? labelOf.get(rowId!)?.scope ?? lbl.scope : isPlan && t.mode === 'planning' ? null : lbl.scope,
        // A retry's title repeats its parent's; what it is, is the fix. An
        // orchestrator run's title is the mission's own; it is the plan.
        label: retry ? (t.ciRetryPrNumber != null ? 'CI fix' : 'retry') : isPlan && t.mode === 'planning' ? 'plan' : lbl.label,
        retry,
        endMark: endGlyph,
        waits: w.status === 'waiting_input' && w.updatedAt != null ? [{ start: w.updatedAt, end: null }] : [],
        deps: rowId && !retry ? tasks[rowId]?.deps.map(d => d.id) ?? [] : [],
      });
    }
  }

  // Slots per runner, and the fleet band's "what holds each slot now".
  const byRunner = new Map<string, Span[]>();
  for (const b of bars) {
    const list = byRunner.get(b.runnerId) ?? [];
    list.push(b);
    byRunner.set(b.runnerId, list);
  }
  const runnerDisplay = new Map<string, RunnerDisplay>();
  for (const t of input.tasks) for (const w of t.workers) {
    const key = runnerKey(w);
    const d = key && !runnerDisplay.has(key) ? displayOf(w) : null;
    if (key && d) runnerDisplay.set(key, d);
  }
  const runnerIds = [...byRunner.keys()].sort((a, b) =>
    (runnerDisplay.get(a)?.name ?? a).localeCompare(runnerDisplay.get(b)?.name ?? b) || (a < b ? -1 : a > b ? 1 : 0));
  const runners: BoardRunner[] = runnerIds.map(id => {
    const d = runnerDisplay.get(id) ?? resolveRunnerDisplay({ runner: id })!;
    const a = assignSlots(byRunner.get(id)!);
    for (const b of byRunner.get(id)!) {
      const bt = tasks[b.taskId];
      if (bt && bt.workerId === b.id) bt.slot = a.slotOf.get(b.id) ?? null;
    }
    const occ = occupiedSlots(a, now).map(s =>
      s && s.end == null ? { taskId: s.taskId, waiting: s.tone === 'waiting' } : null,
    );
    return { id, name: d.name, initial: d.initial, machine: d.machineLabel, capacity: a.slots, slots: occ };
  });
  const live = bars.filter(b => b.end == null).length;

  // Merges (the merged-PR track) and the record.
  const merges: MissionBoardModel['merges'] = [];
  const seenPr = new Set<number>();
  for (const t of input.tasks) {
    for (const w of t.workers) {
      if (w.mergedAt != null && w.prNumber != null && !seenPr.has(w.prNumber)) {
        seenPr.add(w.prNumber);
        merges.push({ at: w.mergedAt, pr: w.prNumber, taskId: rowIdFor.get(t.id) ?? t.id });
      }
    }
  }
  merges.sort((a, b) => a.at - b.at);
  ciFails.sort((a, b) => a.at - b.at);

  // Criteria, with live partial counts.
  const prsExpected = all.filter(t => t.pr != null || (t.status !== 'done' && rowsOutput(input, t.id) === 'pr_required')).length;
  const prsMerged = all.filter(t => t.pr?.state === 'merged').length;
  const verdictAt = new Map((input.criteriaState ?? []).map(c => [c.index, c.verdict]));
  const criteria = (input.criteria ?? []).map((c, i) =>
    criterionRow(c, verdictAt.get(i) ?? null, {
      prsMerged, prsExpected, open: all.length - landedN, landed: landedN, total: all.length, artifacts: input.artifacts ?? [],
    }),
  );

  // Side rail.
  const needsYou = all.filter(t => t.status === 'waiting').map(t => t.id);
  const inReview = all.filter(t => t.status === 'review' || t.status === 'ci_failed' || t.status === 'fixing').map(t => t.id);
  const upNext = rows.map(r => r.task.id).filter(id => BOARD_QUEUED.has(tasks[id].status));

  // Ticker: newest first.
  const ticker: TickerEvent[] = [];
  const tag = (bt: BoardTask) => bt.scope ?? bt.label;
  for (const b of bars) {
    const bt = tasks[b.taskId];
    if (!bt || b.tone === 'plan') continue;
    ticker.push({ kind: 'claimed', at: b.start, taskId: bt.id, text: `${b.retry ? `${tag(bt)} fix` : tag(bt)} → ${runnerDisplay.get(b.runnerId)?.initial ?? b.runner.slice(0, 1).toUpperCase()}` });
    if (b.tone === 'waiting' && b.waits[0]) ticker.push({ kind: 'asked', at: b.waits[0].start, taskId: bt.id, text: `${tag(bt)} asked you` });
  }
  for (const r of rows) {
    const bt = tasks[r.task.id];
    const w = r.task.workers[0];
    if (!w || w.completedAt == null) continue;
    ticker.push(w.prNumber
      ? { kind: 'pr', at: w.completedAt, taskId: bt.id, text: `#${w.prNumber} ${tag(bt)} PR` }
      : { kind: 'done', at: w.completedAt, taskId: bt.id, text: `${tag(bt)} done` });
  }
  for (const m of merges) {
    const bt = tasks[m.taskId];
    if (bt) ticker.push({ kind: 'merged', at: m.at, taskId: bt.id, text: `#${m.pr} ${tag(bt)} merged` });
  }
  for (const f of ciFails) {
    const bt = tasks[f.taskId];
    if (bt) ticker.push({ kind: 'ci_failed', at: f.at, taskId: bt.id, text: `${f.pr ? `#${f.pr} ` : ''}CI failed` });
  }
  ticker.sort((a, b) => b.at - a.at);

  // Clock and record.
  const complete = input.missionStatus === 'completed';
  const startedAt = input.missionCreatedAt;
  const endAt = complete ? input.missionCompletedAt ?? Math.max(now, ...bars.map(b => b.end ?? now)) : now;
  let peak = 0;
  const edges = bars.flatMap(b => [b.start, b.end ?? endAt]).sort((a, b) => a - b);
  for (const e of edges) {
    const n = bars.filter(b => b.start <= e && (b.end ?? endAt) > e).length;
    if (n > peak) peak = n;
  }
  const lineRows = rows.map(r => tasks[r.task.id].lines).filter((l): l is NonNullable<typeof l> => !!l);

  return {
    now,
    startedAt,
    endedAt: complete ? endAt : null,
    complete,
    clockLabel: formatClock(endAt - startedAt),
    clockPrefix: complete ? 'took' : 'T+',
    phases,
    tasks,
    landed: { done: landedN, total: all.length },
    criteria,
    criteriaPassed: criteria.filter(c => c.state === 'pass').length,
    runners,
    live,
    capacity: input.fleetCapacity != null && input.fleetCapacity > 0
      ? Math.max(input.fleetCapacity, live)
      : runners.reduce((n, r) => n + r.capacity, 0),
    needsYou,
    inReview,
    upNext,
    ticker: ticker.slice(0, TICKER_MAX),
    bars,
    merges,
    ciFails,
    humanTouches: [...(input.humanTouches ?? [])].sort((a, b) => a - b),
    record: {
      prsMerged: merges.length,
      linesAdded: lineRows.reduce((n, l) => n + l.added, 0),
      linesRemoved: lineRows.reduce((n, l) => n + l.removed, 0),
      ciFixes: ciFails.length,
      decisions: (input.humanTouches ?? []).length,
      peakAgents: peak,
      runners: runners.length,
    },
  };
}

function rowsOutput(input: MissionBoardInput, id: string): string | null {
  return input.tasks.find(t => t.id === id)?.outputRequirement ?? null;
}

/**
 * Concurrency over the mission's span, for the completed Board's "agents over
 * time": one bin per `binMs`, counting spans open at the bin's midpoint.
 */
export function concurrencyBins(bars: readonly Pick<MissionLaneBar, 'start' | 'end'>[], from: number, to: number, bins = 72): number[] {
  if (!(to > from)) return [];
  const step = (to - from) / bins;
  return Array.from({ length: bins }, (_, i) => {
    const mid = from + step * (i + 0.5);
    return bars.filter(b => b.start <= mid && (b.end ?? to) > mid).length;
  });
}
