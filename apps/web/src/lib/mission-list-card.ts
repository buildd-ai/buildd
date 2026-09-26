/**
 * The missions-list card model: what the redesigned list draws for one mission
 * (running card with a phase-segmented bar, recurring card, held card, done row).
 *
 * Pure and client-safe. It layers list-only facts over the shared card model
 * (`buildMissionCardView`, lib/mission-card-view.ts) and never re-derives what
 * that model owns: the n/N count, the group, the needs-you ask and the primary
 * line all come from the view, so Home and the list still describe one
 * mission one way.
 *
 * Cell states are the pulse's (`deriveFeedTaskState`), with one split the
 * pulse does not draw: a completed task whose PR is waiting on CI is `in_ci`,
 * not `running` — the platform owns it (auto-merge evaluates on green), and the
 * owner can tell "an agent is typing" from "the checks are running".
 */
import {
  deriveFeedPrState,
  deriveFeedTaskState,
  foldMissionDeliverables,
  orderDeliverables,
  type MissionFeedTaskInput,
} from './mission-pulse';
import {
  toFeedTask,
  latestWorker,
  type MissionCardRow,
  type MissionCardSummary,
  type MissionCardTaskRow,
  type MissionCardView,
  type MissionCardWorkerRow,
} from './mission-card-view';
import { missionNeedsYou } from './mission-state-view';
import { missionTaskHref } from './mission-task-href';
import { taskShortLabel } from './segment-label';
import { LIVE_WORKER_STATUSES } from './task-presentation';

type DateLike = Date | string | null | undefined;

// ─── Input (the list's extra columns over MissionCardRow) ─────────────────────

export interface ListWorkerRow extends MissionCardWorkerRow {
  waitingFor?: { type?: string; prompt?: string; options?: string[] } | null;
}
export interface ListTaskRow extends MissionCardTaskRow {
  result?: { summary?: string | null } | null;
  workers?: ListWorkerRow[] | null;
}
export interface ListMissionRow extends MissionCardRow {
  createdAt?: DateLike;
  updatedAt?: DateLike;
  schedule?: (NonNullable<MissionCardRow['schedule']> & { totalRuns?: number | null }) | null;
  tasks?: ListTaskRow[] | null;
}

export interface MissionListCardOptions {
  now?: number;
  /** Role slug → the role's own colour (workspace_skills.color). Never hardcoded here. */
  roleColors?: ReadonlyMap<string, string | null>;
  /** Live worker id → its last reported progress, 0..100. */
  progressByWorker?: ReadonlyMap<string, number>;
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type ListCellState = 'done' | 'in_ci' | 'running' | 'needs_you' | 'failed' | 'queued' | 'skipped';
export type ListTone = 'accent' | 'warning' | 'success' | 'error' | 'muted';
export type ListCardKind = 'active' | 'recurring' | 'held' | 'scheduled' | 'paused' | 'done';

export interface ListCell {
  taskId: string;
  label: string;
  title: string;
  state: ListCellState;
  /** 0..1 — the live worker's reported progress for `running`, 1 otherwise. */
  fill: number;
  href: string;
}

export interface ListPhase {
  key: string;
  label: string | null;
  /** Counted cells done in this phase / counted cells (cancelled excluded). */
  done: number;
  total: number;
  cells: ListCell[];
}

export interface ListQuestion {
  taskId: string;
  label: string;
  href: string;
  /** Present when a worker is parked on a question the list can answer inline. */
  workerId: string | null;
  prompt: string;
  options: string[];
}

export interface ListRun {
  taskId: string;
  state: 'ok' | 'fail' | 'live' | 'pending';
}

export interface MissionListCardModel {
  id: string;
  kind: ListCardKind;
  status: { label: string; tone: ListTone };
  phases: ListPhase[];
  counts: { done: number; total: number; inCi: number; running: number; needsYou: number; queued: number; failed: number };
  live: { count: number; dots: Array<{ roleSlug: string | null; color: string | null }> };
  /** Minutes since the mission's first worker started. Null before any work. */
  elapsedMin: number | null;
  criteria: { passed: number; total: number } | null;
  /** The owner's one ask, inline. Null when nothing needs them. */
  question: ListQuestion | null;
  /** A non-question ask (merge, retry) — the card links to it. */
  ask: { label: string; href: string } | null;
  /** Shown under the title when the status word alone would mislead (stalled, paused, needs you). */
  sentence: string | null;
  recurring: {
    cadence: string;
    nextMins: number | null;
    /** Schedule `nextRunAt`, ISO — lets a far-off run read as a date. */
    nextRunAt: string | null;
    runs: ListRun[];
    totalRuns: number;
    lastTickAt: string | null;
    lastSummary: string | null;
  } | null;
  held: { ready: number; roles: string[]; since: string | null } | null;
  done: { prs: number; fixes: number; durationMs: number | null; completedAt: string | null } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);
const msOf = (d: DateLike) => (d == null ? NaN : new Date(d).getTime());
const isoOf = (d: DateLike) => (d == null ? null : new Date(d).toISOString());

/** "every 6h", "every 15m", "hourly", "daily", "weekly" — the recurring chip. */
export function describeCadence(cron: string | null | undefined): string {
  const parts = (cron ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return 'on a schedule';
  const [min, hour, dom, mon, dow] = parts;
  const every = (f: string) => /^\*\/(\d+)$/.exec(f)?.[1];
  const num = (f: string) => /^\d+$/.test(f);
  if (every(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${every(min)}m`;
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'every minute';
  if (num(min) && dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*') return 'hourly';
    if (every(hour)) return `every ${every(hour)}h`;
    if (num(hour)) return 'daily';
    if (/^\d+(,\d+)+$/.test(hour)) return `${hour.split(',').length}× daily`;
  }
  if (num(min) && num(hour) && dom === '*' && mon === '*' && dow !== '*') {
    return /^[1-5]-5$|^1-5$/.test(dow) ? 'weekdays' : 'weekly';
  }
  if (num(min) && num(hour) && num(dom) && mon === '*' && dow === '*') return 'monthly';
  return 'on a schedule';
}

function firstSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return s.replace(/[.!]$/, '') || null;
}

function liveWorkerOf(task: ListTaskRow): ListWorkerRow | null {
  for (const w of task.workers ?? []) if (LIVE.has(w.status)) return w;
  return null;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export function buildMissionListCard(
  row: ListMissionRow,
  view: MissionCardView,
  summary: MissionCardSummary,
  opts: MissionListCardOptions = {},
): MissionListCardModel {
  const now = opts.now ?? Date.now();
  const tasks = row.tasks ?? [];
  const byId = new Map(tasks.map(t => [t.id, t]));
  const link = (taskId: string) => missionTaskHref({ missionId: row.id, taskId, from: 'missions', mode: 'sheet' });
  const schedule = row.schedule ?? null;
  const isRecurring = !!schedule?.cronExpression && view.group !== 'completed';

  // ── Cells, in pulse order, grouped by phase ──
  const feed: MissionFeedTaskInput[] = tasks.map(toFeedTask);
  const ordered = orderDeliverables(foldMissionDeliverables(feed).rows);
  const phases: ListPhase[] = [];
  const counts = { done: view.done, total: view.total, inCi: 0, running: 0, needsYou: 0, queued: 0, failed: 0 };
  let question: ListQuestion | null = null;

  for (const r of ordered) {
    const fs = deriveFeedTaskState(r);
    const source = byId.get(r.task.id)!;
    let state: ListCellState;
    let fill = 1;
    switch (fs.state) {
      case 'moving': {
        const inCi = r.task.status === 'completed' && deriveFeedPrState(r.task.worker)?.state === 'checks_running';
        state = inCi ? 'in_ci' : 'running';
        if (!inCi) {
          const candidates = [source, ...r.attempts.map(a => byId.get(a.id)!).filter(Boolean)];
          const live = candidates.map(liveWorkerOf).find(Boolean);
          const pct = live?.id ? opts.progressByWorker?.get(live.id) : undefined;
          fill = pct == null ? 0 : Math.max(0, Math.min(1, pct / 100));
        }
        break;
      }
      default:
        state = fs.state;
    }
    if (state === 'in_ci') counts.inCi++;
    else if (state === 'running') counts.running++;
    else if (state === 'needs_you') counts.needsYou++;
    else if (state === 'queued') counts.queued++;
    else if (state === 'failed') counts.failed++;

    const { label } = taskShortLabel(source);
    const cell: ListCell = { taskId: r.task.id, label, title: r.task.title, state, fill, href: link(r.task.id) };

    if (state === 'needs_you' && !question) {
      const candidates = [source, ...r.attempts.map(a => byId.get(a.id)!).filter(Boolean)];
      const parked = candidates
        .flatMap(t => t.workers ?? [])
        .find(w => w.status === 'waiting_input' && w.waitingFor?.prompt);
      if (parked) {
        question = {
          taskId: r.task.id, label, href: cell.href, workerId: parked.id ?? null,
          prompt: parked.waitingFor!.prompt!, options: (parked.waitingFor!.options ?? []).slice(0, 3),
        };
      }
    }

    const key = r.task.missionPhaseIndex != null && r.task.missionPhaseLabel ? `p${r.task.missionPhaseIndex}` : 'none';
    let phase = phases[phases.length - 1];
    if (!phase || phase.key !== key) {
      phase = { key, label: key === 'none' ? null : r.task.missionPhaseLabel ?? null, done: 0, total: 0, cells: [] };
      phases.push(phase);
    }
    phase.cells.push(cell);
    if (state !== 'skipped') {
      phase.total++;
      if (state === 'done') phase.done++;
    }
  }

  // The orchestrator's own row carries no phase: name its group "Plan".
  for (const p of phases) {
    if (p.label == null && p.cells.every(c => byId.get(c.taskId)?.mode === 'planning')) {
      p.label = 'Plan';
      for (const c of p.cells) c.label = 'plan';
    }
  }
  // Planning happens first, so it reads first (the pulse keeps unphased rows last).
  const planAt = phases.findIndex(p => p.label === 'Plan' && p.key === 'none');
  if (planAt > 0) phases.unshift(...phases.splice(planAt, 1));

  // ── Live agents ──
  const dots: MissionListCardModel['live']['dots'] = [];
  let firstStart = NaN;
  for (const t of tasks) {
    for (const w of t.workers ?? []) {
      const s = msOf(w.startedAt);
      if (Number.isFinite(s) && !(s >= firstStart)) firstStart = s;
      if (LIVE.has(w.status)) {
        const slug = t.roleSlug ?? null;
        dots.push({ roleSlug: slug, color: slug ? opts.roleColors?.get(slug) ?? null : null });
      }
    }
  }
  const elapsedMin = Number.isFinite(firstStart) && view.group !== 'completed'
    ? Math.max(0, Math.round((now - firstStart) / 60_000))
    : null;

  // ── Criteria ──
  const criteriaTotal = Array.isArray(row.goalCriteria) ? row.goalCriteria.length : 0;
  const verdicts = ((row.goalCriteriaState as any)?.criteria ?? []) as Array<{ verdict?: string }>;
  const criteria = criteriaTotal > 0
    ? { passed: Math.min(criteriaTotal, verdicts.filter(c => c.verdict === 'pass').length), total: criteriaTotal }
    : null;

  // ── Kind + the one status word ──
  const needsYou = missionNeedsYou(summary.state) || counts.needsYou > 0;
  let kind: ListCardKind;
  if (view.group === 'completed') kind = 'done';
  else if (isRecurring) kind = 'recurring';
  else if (row.isHeld) kind = 'held';
  else if (view.group === 'scheduled') kind = 'scheduled';
  else if (view.group === 'paused') kind = 'paused';
  else kind = 'active';

  const status: MissionListCardModel['status'] = (() => {
    if (kind === 'done') return { label: 'Done', tone: 'success' };
    if (kind === 'held') return { label: 'Held', tone: 'warning' };
    if (needsYou) return { label: 'Needs you', tone: 'warning' };
    if (summary.liveWorkers > 0) return { label: 'Running', tone: 'accent' };
    if (kind === 'recurring') return { label: 'Idle', tone: 'muted' };
    if (kind === 'scheduled') return { label: 'Scheduled', tone: 'muted' };
    if (kind === 'paused') return { label: 'Paused', tone: 'muted' };
    if (counts.inCi > 0) return { label: 'In CI', tone: 'accent' };
    if (view.group === 'attention') return { label: 'Stalled', tone: 'error' };
    return { label: 'Waiting', tone: 'muted' };
  })();

  // The status word covers a healthy running card; anything else says why.
  const sentence = kind === 'done' || (status.label === 'Running' && !needsYou) || question
    ? null
    : view.situation.headline || null;

  const ask = !question && needsYou && view.primary?.kind === 'needs_you'
    ? { label: view.primary.label, href: view.primary.href }
    : null;

  // ── Recurring ──
  let recurring: MissionListCardModel['recurring'] = null;
  if (isRecurring && schedule) {
    const ticks = tasks
      .filter(t => t.scheduleId && t.scheduleId === schedule.id)
      .sort((a, b) => msOf(b.createdAt) - msOf(a.createdAt));
    const runs: ListRun[] = ticks.slice(0, 4).reverse().map(t => ({
      taskId: t.id,
      state: liveWorkerOf(t) ? 'live' : t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'fail' : 'pending',
    }));
    const lastDone = ticks.find(t => t.status === 'completed');
    const lastWorker = lastDone ? latestWorker(lastDone.workers) : null;
    recurring = {
      cadence: describeCadence(schedule.cronExpression),
      nextMins: summary.nextScanMins,
      nextRunAt: summary.nextRunAt ?? null,
      runs,
      totalRuns: Math.max(schedule.totalRuns ?? 0, ticks.length),
      lastTickAt: isoOf(lastWorker?.completedAt ?? lastDone?.updatedAt ?? schedule.lastRunAt ?? null),
      lastSummary: firstSentence(lastDone?.result?.summary ?? null),
    };
  }

  // ── Held ──
  let held: MissionListCardModel['held'] = null;
  if (kind === 'held') {
    const pending = ordered.filter(r => r.task.status === 'pending').map(r => r.task);
    const roles = [...new Set(pending.map(t => t.roleSlug).filter((s): s is string => !!s))];
    held = { ready: pending.length, roles, since: isoOf(row.updatedAt ?? row.createdAt ?? null) };
  }

  // ── Done row ──
  let done: MissionListCardModel['done'] = null;
  if (kind === 'done') {
    const folded = foldMissionDeliverables(feed);
    const prs = folded.rows.filter(r => r.task.worker?.prNumber && (r.task.worker.mergedAt || r.task.worker.prLifecycleStatus === 'merged')).length;
    const fixes = folded.rows.reduce((n, r) => n + r.attempts.length, 0);
    const start = msOf(row.createdAt);
    const end = msOf(row.completedAt);
    done = {
      prs, fixes,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
      completedAt: isoOf(row.completedAt ?? null),
    };
  }

  return {
    id: row.id, kind, status, phases, counts,
    live: { count: summary.liveWorkers, dots },
    elapsedMin, criteria, question, ask, sentence, recurring, held, done,
  };
}

/** "37m", "5h", "3d" — compact durations for list meta. */
export function shortDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * "next 45m", "next 3h 20m", "in 5 days", "next Jan 15" — when a schedule runs
 * next. Hours stop at two days (nobody reads "2664h"); past two weeks the date
 * says more than a count. Null when nothing is scheduled.
 */
export function nextRunLabel(
  mins: number | null | undefined,
  nextRunAt: string | Date | null | undefined,
  opts: { now?: number; timeZone?: string | null } = {},
): { lead: string; value: string } | null {
  if (mins == null || !Number.isFinite(mins)) return null;
  if (mins <= 0) return { lead: '', value: 'due now' };
  if (mins < 90) return { lead: 'next', value: `${mins}m` };
  if (mins < 48 * 60) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return { lead: 'next', value: m ? `${h}h ${m}m` : `${h}h` };
  }
  const days = Math.round(mins / 1440);
  if (days < 14 || !nextRunAt) return { lead: 'in', value: `${days} days` };
  const now = opts.now ?? Date.now();
  const at = new Date(nextRunAt);
  let tz = opts.timeZone || undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = undefined; }
  const year = (d: Date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: tz }).format(d);
  const value = at.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(year(at) !== year(new Date(now)) ? { year: 'numeric' } : {}), timeZone: tz,
  });
  return { lead: 'next', value };
}

/** The list's sentence headline: "1 running · 6 agents on it", "1 shipped today. Nothing running." */
export function missionsHeadline(input: { running: number; liveAgents: number; shippedToday: number }): string {
  const { running, liveAgents, shippedToday } = input;
  if (running > 0) {
    return liveAgents > 0 ? `${running} running · ${liveAgents} agent${liveAgents === 1 ? '' : 's'} on it` : `${running} running`;
  }
  return shippedToday > 0 ? `${shippedToday} shipped today. Nothing running.` : 'Nothing running.';
}

/** "now", "12m", "5h", "3d" — how long ago, for tight list columns. */
export function shortAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'now';
  return shortDuration(ms);
}
