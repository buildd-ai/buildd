/**
 * The mission card — one model for the Home card and the missions-list card
 * (docs/design/mission-feed-mobile-continuity.md, W1, S5, addendum D7/D8).
 *
 * Pure and client-safe. Two steps, so a surface can group every mission it
 * loaded but only pay for the heavy parts of the ones it shows:
 *
 * - `summarizeMissionForCard` — cheap: health, group, live workers, schedule
 *   timing. Every loaded mission goes through it, so the header's "N active"
 *   and the cards are counted by the same rule (D8).
 * - `buildMissionCardView` — the card itself: the accessor's chip and
 *   situation (one derivation, D2), the pulse, the `n/N` caption and the one
 *   primary line, routed through `missionTaskHref` into mission context.
 *
 * Vocabulary (one per concept, every surface):
 * - group: `healthToGroup` (mission-status-mobile-header-spec.md §1.1), never
 *   `statusToGroup`.
 * - live workers: `LIVE_WORKER_STATUSES`, so a worker waiting on the user
 *   counts as live, on Home and the list alike.
 * - chip: `deriveMissionStateView(...).chip`, the detail header's accessor.
 */
import {
  computeMissionProgress,
  deriveCriteriaGatePresentation,
  hasPendingDeliverableWork,
  isDeliverableTask,
  type MissionFlightStripData,
} from '@buildd/core/mission-helpers';
import { deriveMissionStateView, type MissionSituation } from './mission-state-view';
import {
  deriveMissionHealth,
  deriveTaskHealthSignal,
  healthToGroup,
  type Health,
  type MissionGroup,
  type MissionHealth,
} from './mission-helpers';
import { buildMissionFeedGroups, type FeedRow } from './mission-feed-groups';
import { buildPulseSegments, type MissionFeedTaskInput, type MissionFeedWorkerInput, type PulseSegment } from './mission-pulse';
import { missionTaskHref, type MissionOrigin } from './mission-task-href';
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { deriveMissionIntegrationPr } from './mission-integration-pr';

// ─── Input ────────────────────────────────────────────────────────────────────

type DateLike = Date | string | null | undefined;

export interface MissionCardWorkerRow {
  id?: string;
  status: string;
  startedAt?: DateLike;
  completedAt?: DateLike;
  updatedAt?: DateLike;
  turns?: number | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prLifecycleStatus?: string | null;
  mergedAt?: DateLike;
  supersededByPrNumber?: number | null;
  exitCause?: string | null;
}

export interface MissionCardTaskRow {
  id: string;
  title: string;
  status: string;
  createdAt?: DateLike;
  updatedAt?: DateLike;
  taskClass?: string | null;
  parentTaskId?: string | null;
  mode?: string | null;
  kind?: string | null;
  roleSlug?: string | null;
  category?: string | null;
  creationSource?: string | null;
  dependsOn?: string[] | null;
  missionPhaseIndex?: number | null;
  missionPhaseLabel?: string | null;
  scheduleId?: string | null;
  startAt?: DateLike;
  loopIteration?: number | null;
  workers?: MissionCardWorkerRow[] | null;
}

export interface MissionCardScheduleRow {
  id?: string | null;
  nextRunAt?: DateLike;
  lastRunAt?: DateLike;
  cronExpression?: string | null;
  lastDeferralReason?: string | null;
  lastDeferredAt?: DateLike;
  maxConcurrentFromSchedule?: number | null;
}

export interface MissionCardRow {
  id: string;
  title: string;
  status: string;
  isHeld?: boolean | null;
  startAt?: DateLike;
  orchestrationMode?: string | null;
  dependsOnMissionId?: string | null;
  dependencyMetAt?: DateLike;
  criteriaEscalatedAt?: DateLike;
  goalCriteria?: unknown;
  goalCriteriaState?: unknown;
  completedAt?: DateLike;
  primaryPrUrl?: string | null;
  primaryPrNumber?: number | null;
  workingBranch?: string | null;
  integrationBranchEnabled?: boolean | null;
  schedule?: MissionCardScheduleRow | null;
  tasks?: MissionCardTaskRow[] | null;
}

// ─── Blocked on a PR ──────────────────────────────────────────────────────────

/** What the blocked-on-PR rule needs of a task a pending task may be blocked *on*. */
export interface BlockingTask {
  status: string;
  workers?: Array<{
    prNumber?: number | null;
    mergedAt?: unknown;
    prLifecycleStatus?: string | null;
  }> | null;
}

/**
 * A mission's pending tasks blocked on a dependency whose PR is open, in input
 * order. The ONE rule: `countBlockedByPR` (Missions, Initiatives) is its
 * length, and the card links the first.
 *
 * `taskIndex` must span every mission the caller loaded — `dependsOn` crosses
 * mission boundaries. EVERY worker of the dependency is read, not just the
 * newest: a retried dependency can carry the PR an attempt or two back.
 */
export function blockedByPRTaskIds(
  missionTasks: ReadonlyArray<{ id?: string; status: string; dependsOn?: string[] | null }>,
  taskIndex: ReadonlyMap<string, BlockingTask>,
): string[] {
  const out: string[] = [];
  for (const task of missionTasks) {
    if (task.status !== 'pending') continue;
    for (const depId of task.dependsOn ?? []) {
      const dep = taskIndex.get(depId);
      if (!dep || dep.status !== 'completed') continue;
      const openPR = (dep.workers ?? []).some(w => w?.prNumber && !w.mergedAt && w.prLifecycleStatus !== 'closed');
      if (openPR) {
        out.push(task.id ?? '');
        break;
      }
    }
  }
  return out;
}

// ─── Summary (every loaded mission) ───────────────────────────────────────────

export interface MissionCardSummary {
  health: MissionHealth;
  healthState: Health;
  group: MissionGroup;
  /** Workers in `LIVE_WORKER_STATUSES` across the mission's tasks. */
  liveWorkers: number;
  progress: number;
  totalTasks: number;
  completedTasks: number;
  /** Schedule deferral that is still in force, or null (a stale cap reason is cleared). */
  lastDeferralReason: string | null;
  /** Schedule `nextRunAt`, else the earliest user-scheduled task start. ISO. */
  nextRunAt: string | null;
  nextScanMins: number | null;
  hasPendingDeliverableWork: boolean;
  heartbeatWaitingUntil: DateLike;
}

const TERMINAL_MISSION = new Set(['completed', 'archived', 'cancelled']);
const OPEN_TASK = new Set(['pending', 'assigned', 'in_progress']);
const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const iso = (d: DateLike) => (d == null ? null : new Date(d).toISOString());

/** Live workers on a mission: every `LIVE_WORKER_STATUSES` worker on any of its tasks. */
export function countLiveWorkers(tasks: readonly MissionCardTaskRow[]): number {
  let n = 0;
  for (const t of tasks) for (const w of t.workers ?? []) if (LIVE.has(w.status)) n++;
  return n;
}

/**
 * The one card grouping. Terminal missions are `completed` whatever their
 * health reads (an archived row is not "needs attention"); a mission whose
 * start gate is in the future is `scheduled`; everything else is
 * `healthToGroup`, so `liveWorkers > 0` is `running` (§1.1).
 */
export function missionCardGroup(input: {
  status: string;
  health: MissionHealth;
  progress: number;
  isHeld?: boolean | null;
  startAt?: DateLike;
  now?: number;
  /** Live workers (`LIVE_WORKER_STATUSES`, so `waiting_input` counts). */
  liveWorkers?: number;
  criteriaEscalatedAt?: DateLike;
  hasPendingDeliverableWork?: boolean;
}): MissionGroup {
  if (TERMINAL_MISSION.has(input.status)) return 'completed';
  const now = input.now ?? Date.now();
  if (!input.isHeld && input.startAt && new Date(input.startAt).getTime() > now && input.health !== 'active') {
    return 'scheduled';
  }
  // D8: a paused or budget-stopped mission whose next step is the user's is
  // active, not PAUSED / HELD. `deriveMissionHealth` returns `paused` before it
  // looks at workers or criteria, but the card's chip (deriveMissionStateView)
  // does not, so without this a READY FOR REVIEW or AWAITING DECISION card sat
  // under PAUSED / HELD and the header's "N active" skipped it. Held missions
  // stay PAUSED / HELD (§1.1): arming is a start, not an answer.
  if (!input.isHeld && (input.health === 'paused' || input.health === 'budget-exhausted')) {
    if ((input.liveWorkers ?? 0) > 0) return 'running';
    if (input.criteriaEscalatedAt && input.hasPendingDeliverableWork === false) return 'attention';
    if (input.progress >= 100) return 'review';
  }
  return healthToGroup(input.health, input.progress);
}

/** Most cards one surface builds in a request (Home, the list). */
export const MISSION_CARD_VIEW_CAP = 30;

/**
 * `liveWorkers`: an exact count from a batched query. The nested worker
 * relation is capped per task, so counting it can miss a live re-claim.
 */
export function summarizeMissionForCard(row: MissionCardRow, opts: { now?: number; liveWorkers?: number } = {}): MissionCardSummary {
  const now = opts.now ?? Date.now();
  const tasks = row.tasks ?? [];
  const schedule = row.schedule ?? null;
  const { totalTasks, completedTasks, progress } = computeMissionProgress(tasks as any);
  const liveWorkers = opts.liveWorkers ?? countLiveWorkers(tasks);

  const nextRunAt = schedule?.nextRunAt ?? null;
  const rawDeferral = schedule?.lastDeferralReason ?? null;
  // Recorded as `nextRunAt` while the heartbeat deliberately waits on a known
  // self-resolving condition (heartbeat-prepass.ts) — renders BLOCKED, not idle.
  const heartbeatWaitingUntil = rawDeferral === 'heartbeat_waiting' ? nextRunAt : null;

  // A concurrent-cap deferral the schedule is no longer over is stale.
  let lastDeferralReason = rawDeferral;
  if (rawDeferral === 'concurrent_cap') {
    const max = schedule?.maxConcurrentFromSchedule ?? 1;
    const open = tasks.filter(t => t.scheduleId === schedule?.id && OPEN_TASK.has(t.status)).length;
    if (open < max) lastDeferralReason = null;
  }

  // Earliest future start of a deliberately scheduled pending task (loopIteration 0).
  let pendingUserScheduledAt: Date | null = null;
  for (const t of tasks) {
    if (t.status !== 'pending' || (t.loopIteration ?? 0) !== 0 || !t.startAt) continue;
    const at = new Date(t.startAt);
    if (at.getTime() > now && (!pendingUserScheduledAt || at < pendingUserScheduledAt)) pendingUserScheduledAt = at;
  }
  // A deliberately scheduled task is not a seat deferral.
  if (pendingUserScheduledAt) lastDeferralReason = null;

  const pending = hasPendingDeliverableWork(tasks as any);
  const health = deriveMissionHealth({
    status: row.status,
    activeAgents: liveWorkers,
    cronExpression: schedule?.cronExpression ?? null,
    lastRunAt: (schedule?.lastRunAt as any) ?? null,
    nextRunAt: (nextRunAt as any) ?? null,
    orchestrationMode: row.orchestrationMode ?? null,
    isHeld: row.isHeld ?? false,
    pendingUserScheduledAt,
    criteriaEscalatedAt: row.criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork: pending,
  });

  const effectiveNext = nextRunAt ?? pendingUserScheduledAt;
  return {
    health,
    healthState: deriveTaskHealthSignal(
      { dependsOnMissionId: row.dependsOnMissionId, dependencyMetAt: row.dependencyMetAt, heartbeatWaitingUntil },
      tasks as any,
    ),
    group: missionCardGroup({
      status: row.status, health, progress, isHeld: row.isHeld, startAt: row.startAt, now,
      liveWorkers, criteriaEscalatedAt: row.criteriaEscalatedAt, hasPendingDeliverableWork: pending,
    }),
    liveWorkers,
    progress,
    totalTasks,
    completedTasks,
    lastDeferralReason,
    nextRunAt: iso(effectiveNext),
    nextScanMins: effectiveNext ? Math.max(0, Math.round((new Date(effectiveNext).getTime() - now) / 60000)) : null,
    hasPendingDeliverableWork: pending,
    heartbeatWaitingUntil,
  };
}

/** Header "N active": the Active tab's groups, counted with the cards' grouping (D8). */
export const ACTIVE_CARD_GROUPS: readonly MissionGroup[] = ['running', 'attention', 'review'];

export function countActiveMissions(groups: Iterable<MissionGroup>): number {
  let n = 0;
  for (const g of groups) if (ACTIVE_CARD_GROUPS.includes(g)) n++;
  return n;
}

// ─── The card ─────────────────────────────────────────────────────────────────

export interface MissionCardPrimary {
  label: string;
  href: string;
  taskId: string;
  kind: 'needs_you' | 'moving' | 'blocked_pr';
}

export interface MissionCardView {
  id: string;
  title: string;
  status: string;
  group: MissionGroup;
  /** The detail header's chip, from the same accessor (D2). */
  chip: { label: string; cls: string };
  situation: MissionSituation;
  segments: PulseSegment[];
  /** `done/total`, plus `· N live`. */
  caption: string;
  done: number;
  total: number;
  liveWorkers: number;
  /** `/app/missions/X?from=…` — the card body. */
  href: string;
  primary: MissionCardPrimary | null;
  /** Completed missions render compact: one line, no pulse (D7). */
  compact: boolean;
  /** `Completed <when> · n/n`, for compact cards. ISO of the completion. */
  completedAt: string | null;
  /** The time-axis strip, for `FlightDetailSheet` only (D4). Null when nothing to draw. */
  flightStrip: MissionFlightStripData | null;
  /** Titles of the tasks the strip draws, for the bars' accessible names. */
  flightStripTaskTitles: Record<string, string>;
}

export interface BuildMissionCardViewOptions {
  from: MissionOrigin;
  now?: number;
  /** Precomputed summary (the page grouped with it); computed when absent. */
  summary?: MissionCardSummary;
  /**
   * Every task the caller loaded, across missions — `dependsOn` crosses
   * mission boundaries (`countBlockedByPR`). Absent: this mission's own tasks.
   */
  taskIndex?: ReadonlyMap<string, BlockingTask>;
  flightStrip?: MissionFlightStripData | null;
}

const ms = (d: DateLike) => (d == null ? NaN : new Date(d).getTime());

/** The worker the feed reads for a task: newest by start (then update), not array order. */
export function latestWorker(workers: readonly MissionCardWorkerRow[] | null | undefined): MissionCardWorkerRow | null {
  if (!workers || workers.length === 0) return null;
  const key = (w: MissionCardWorkerRow) => {
    const s = ms(w.startedAt);
    return Number.isFinite(s) ? s : ms(w.updatedAt);
  };
  return [...workers].sort((a, b) => (key(b) || 0) - (key(a) || 0))[0];
}

/** Adapt a loaded task row into the feed/pulse input. */
export function toFeedTask(t: MissionCardTaskRow): MissionFeedTaskInput {
  const w = latestWorker(t.workers);
  const worker: MissionFeedWorkerInput | null = w
    ? {
        status: w.status, startedAt: w.startedAt ?? null, updatedAt: w.updatedAt ?? null,
        prNumber: w.prNumber ?? null, prUrl: w.prUrl ?? null,
        prLifecycleStatus: w.prLifecycleStatus ?? null, mergedAt: w.mergedAt ?? null,
      }
    : null;
  return {
    id: t.id, title: t.title, status: t.status,
    createdAt: (t.createdAt ?? t.updatedAt ?? 0) as Date | string,
    updatedAt: t.updatedAt ?? null, taskClass: t.taskClass ?? null, parentTaskId: t.parentTaskId ?? null,
    mode: t.mode ?? null, kind: t.kind ?? null, roleSlug: t.roleSlug ?? null, category: t.category ?? null,
    creationSource: t.creationSource ?? null, dependsOn: t.dependsOn ?? null,
    missionPhaseIndex: t.missionPhaseIndex ?? null, missionPhaseLabel: t.missionPhaseLabel ?? null,
    worker,
  };
}

const NEEDS_YOU_VERB: Record<NonNullable<FeedRow['needsYou']>, string> = {
  input: 'Answer',
  question: 'Answer',
  decision: 'Decide',
  pr: 'Merge',
  failed: 'Retry',
};

function needsYouLabel(row: FeedRow): string {
  if (row.needsYou === 'pr' && (row.pr?.state === 'ci_failed' || row.pr?.state === 'conflict')) {
    return `Fix PR: ${row.task.title}`;
  }
  return `${NEEDS_YOU_VERB[row.needsYou ?? 'input']}: ${row.task.title}`;
}

/** The card's pulse caption: `done/total`, plus `· N live` when agents are working. */
export function missionCardCaption(segments: readonly PulseSegment[], liveWorkers: number): { caption: string; done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of segments) {
    if (s.kind === 'phase') {
      total += s.taskIds.length;
      done += Math.round(s.fill * s.taskIds.length);
    } else {
      total += 1;
      if (s.state === 'done' || s.state === 'skipped') done += 1;
    }
  }
  return { caption: liveWorkers > 0 ? `${done}/${total} · ${liveWorkers} live` : `${done}/${total}`, done, total };
}

/** The mission's own page, carrying the breadcrumb origin. */
export function missionCardHref(missionId: string, from: MissionOrigin): string {
  return `/app/missions/${encodeURIComponent(missionId)}?from=${encodeURIComponent(from)}`;
}

function hasFlightStripActivity(data: MissionFlightStripData | null | undefined): boolean {
  return !!data && (data.bars.length > 0 || data.rail.marks.length > 0);
}

export function buildMissionCardView(row: MissionCardRow, opts: BuildMissionCardViewOptions): MissionCardView {
  const now = opts.now ?? Date.now();
  const tasks = row.tasks ?? [];
  const summary = opts.summary ?? summarizeMissionForCard(row, { now });
  const deliverables = tasks.filter(t => isDeliverableTask(t as any));

  // ── One chip, one sentence: the detail header's accessor (D2). ──
  const criteriaState = (row.goalCriteriaState ?? null) as
    { overall?: string; criteria?: Array<{ verdict: string; label?: string; type?: string }> } | null;
  const criteriaCount = Array.isArray(row.goalCriteria) ? row.goalCriteria.length : 0;
  const criteriaGate = TERMINAL_MISSION.has(row.status)
    ? null
    : deriveCriteriaGatePresentation({
        criteriaCount,
        overall: (criteriaState?.overall as any) ?? null,
        items: (criteriaState?.criteria ?? []) as any,
        completionAttempted: summary.progress >= 100,
      });
  const integrationPr = deriveMissionIntegrationPr({ mission: row as any, tasks: tasks as any });
  const unmergedPrs = tasks.flatMap(t => {
    if (t.status !== 'completed') return [];
    const w = latestWorker(t.workers);
    if (!w?.prUrl || w.mergedAt || w.prLifecycleStatus === 'closed') return [];
    return [{ taskId: t.id, title: t.title, prNumber: w.prNumber ?? null, prUrl: w.prUrl ?? null }];
  });
  const state = deriveMissionStateView({
    status: row.status,
    isHeld: row.isHeld ?? false,
    orchestrationMode: row.orchestrationMode ?? null,
    activeAgents: summary.liveWorkers,
    progress: summary.progress,
    health: summary.healthState,
    dependsOnMissionId: row.dependsOnMissionId ?? null,
    criteriaEscalatedAt: row.criteriaEscalatedAt ?? null,
    hasPendingDeliverableWork: summary.hasPendingDeliverableWork,
    criteriaGate,
    criteriaItems: (criteriaState?.criteria ?? []) as any,
    openTasks: deliverables
      .filter(t => OPEN_TASK.has(t.status))
      .map(t => ({ id: t.id, status: t.status, title: t.title })),
    failedTasks: deliverables
      .filter(t => t.status === 'failed')
      // No `infra`: it only matters with a completion decision, which a card never has.
      .map(t => ({ id: t.id, title: t.title })),
    missionPr: integrationPr && integrationPr.state === 'open'
      ? { prNumber: integrationPr.prNumber, prUrl: integrationPr.prUrl }
      : null,
    unmergedPrs,
  });

  // ── Pulse, caption, primary line. ──
  const feedTasks = tasks.map(toFeedTask);
  const segments = buildPulseSegments(feedTasks);
  const { caption, done, total } = missionCardCaption(segments, summary.liveWorkers);
  const compact = summary.group === 'completed';

  let primary: MissionCardPrimary | null = null;
  if (!compact) {
    const model = buildMissionFeedGroups(feedTasks);
    const needsYou = model.groups.find(g => g.kind === 'needs_you');
    const moving = model.groups.find(g => g.kind === 'moving');
    const link = (taskId: string) => missionTaskHref({ missionId: row.id, taskId, from: opts.from, mode: 'sheet' });
    if (needsYou && needsYou.rows[0]) {
      const r = needsYou.rows[0];
      primary = { kind: 'needs_you', taskId: r.taskId, label: needsYouLabel(r), href: link(r.taskId) };
    } else if (moving && moving.rows[0]) {
      const r = moving.rows[0];
      primary = { kind: 'moving', taskId: r.taskId, label: `${r.task.title} · running`, href: link(r.taskId) };
    } else {
      const index = opts.taskIndex ?? new Map(tasks.map(t => [t.id, t as BlockingTask]));
      const blocked = blockedByPRTaskIds(tasks, index);
      if (blocked.length > 0) {
        primary = {
          kind: 'blocked_pr', taskId: blocked[0],
          label: `Blocked on ${blocked.length} PR${blocked.length === 1 ? '' : 's'}`,
          href: link(blocked[0]),
        };
      }
    }
  }

  const flightStrip = !compact && hasFlightStripActivity(opts.flightStrip) ? opts.flightStrip! : null;
  const flightStripTaskTitles: Record<string, string> = {};
  if (flightStrip) {
    const titleById = new Map(tasks.map(t => [t.id, t.title]));
    for (const bar of flightStrip.bars) {
      const t = titleById.get(bar.taskId);
      if (t) flightStripTaskTitles[bar.taskId] = t;
    }
  }

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    group: summary.group,
    chip: state.chip,
    situation: state.situation,
    segments,
    caption,
    done,
    total,
    liveWorkers: summary.liveWorkers,
    href: missionCardHref(row.id, opts.from),
    primary,
    compact,
    completedAt: iso(row.completedAt ?? null),
    flightStrip,
    flightStripTaskTitles,
  };
}

/** `Completed 3d ago · 6/6` — the whole of a compact card's body (D7). */
export function compactCardLine(view: Pick<MissionCardView, 'completedAt' | 'done' | 'total'>, timeAgo: (d: string) => string): string {
  const when = view.completedAt ? `Completed ${timeAgo(view.completedAt)}` : 'Completed';
  return view.total > 0 ? `${when} · ${view.done}/${view.total}` : when;
}
