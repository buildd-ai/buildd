/**
 * The mission Feed: what happened, in order, one row per event — task
 * claimed, PR opened, escalated to you, answered, merged, CI failed, mission
 * completed — grouped by day. It reads the Board's model (the same bars,
 * merges and task states the Board and Lanes draw) plus the mission's notes
 * for escalations and answers, so the three layouts never disagree.
 *
 * Pure and client-safe.
 */
import type { MissionBoardModel } from './mission-board';

export type FeedEventKind =
  | 'filed' | 'plan' | 'claim' | 'pr' | 'merged' | 'done' | 'question' | 'answered' | 'failed' | 'friction' | 'mission';

export interface FeedNoteInput {
  id: string;
  type: string;
  authorType: string;
  title: string | null;
  taskId: string | null;
  createdAt: number;
}

export interface FeedEvent {
  id: string;
  kind: FeedEventKind;
  at: number;
  /** `09:14`, in the team's zone. */
  time: string;
  /** Who or what: a task's scope/label, "orchestrator", "you", "mission". */
  actor: string;
  detail: string;
  /** Opens the task's sheet. */
  taskId: string | null;
  /** A retry or a repair: History nests it under its task's earlier entry. */
  nest?: boolean;
}

export interface FeedDay {
  key: string;
  /** `Sep 3`, or `Sep 3, 2025` outside the current year. */
  label: string;
  /** Whole days since the previous day with events (0 for the first). */
  quietDays: number;
  events: FeedEvent[];
}

export interface MissionEventFeedInput {
  model: MissionBoardModel;
  notes?: readonly FeedNoteInput[];
  /** The completion summary, shown on the "mission completed" row. */
  completionText?: string | null;
  timeZone?: string | null;
}

const DAY_MS = 86_400_000;

function dayKey(ms: number, tz: string | undefined): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
}

function dayLabel(ms: number, now: number, tz: string | undefined): string {
  const sameYear = new Date(ms).toLocaleDateString('en-US', { year: 'numeric', timeZone: tz })
    === new Date(now).toLocaleDateString('en-US', { year: 'numeric', timeZone: tz });
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: tz });
}

function hhmm(ms: number, tz: string | undefined): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz });
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildMissionEventFeed({ model, notes = [], completionText = null, timeZone }: MissionEventFeedInput): FeedDay[] {
  const tz = timeZone ?? undefined;
  const raw: Array<Omit<FeedEvent, 'time'>> = [];
  const tagOf = (taskId: string | null) => {
    const t = taskId ? model.tasks[taskId] : undefined;
    return t ? t.scope ?? t.label : null;
  };

  raw.push({ id: 'filed', kind: 'filed', at: model.startedAt, actor: 'mission', detail: 'filed', taskId: null });

  let plans = 0;
  for (const b of [...model.bars].sort((x, y) => x.start - y.start)) {
    if (b.tone === 'plan') {
      raw.push({ id: `plan:${b.id}`, kind: 'plan', at: b.start, actor: 'orchestrator', detail: plans++ === 0 ? 'planned the work' : 'checked in', taskId: null });
      continue;
    }
    if (b.tone === 'side') {
      raw.push({ id: `side:${b.id}`, kind: 'friction', at: b.start, actor: b.label, detail: 'friction report filed · not mission work', taskId: b.taskId });
      if (b.endMark === 'fail' && b.end != null) {
        raw.push({ id: `side-end:${b.id}`, kind: 'failed', at: b.end, actor: b.label, detail: /orphaned/.test(b.kindTitle ?? '') ? 'friction run orphaned; its runner went away' : 'friction run stopped', taskId: b.taskId });
      }
      continue;
    }
    const tag = tagOf(b.taskId) ?? b.scope ?? b.label;
    raw.push({ id: `claim:${b.id}`, kind: 'claim', at: b.start, actor: tag, detail: `${b.retry ? `${b.label} ` : ''}claimed by ${b.runner}`, taskId: b.taskId, nest: !!b.retry });
    if (b.tone === 'stopped' && b.end != null) {
      raw.push({ id: `stop:${b.id}`, kind: 'failed', at: b.end, actor: tag, detail: 'run stopped without a PR', taskId: b.taskId, nest: true });
    }
  }

  for (const t of Object.values(model.tasks)) {
    if (t.endedAt == null) continue;
    if (t.pr) raw.push({ id: `pr:${t.id}`, kind: 'pr', at: t.endedAt, actor: t.scope ?? t.label, detail: `opened PR #${t.pr.number}`, taskId: t.id });
    else if (t.status === 'done') raw.push({ id: `done:${t.id}`, kind: 'done', at: t.endedAt, actor: t.scope ?? t.label, detail: 'done', taskId: t.id });
  }
  for (const m of model.merges) {
    raw.push({ id: `merged:${m.pr}`, kind: 'merged', at: m.at, actor: tagOf(m.taskId) ?? 'PR', detail: `#${m.pr} merged`, taskId: m.taskId });
  }
  model.ciFails.forEach((f, i) => {
    raw.push({ id: `ci:${i}`, kind: 'failed', at: f.at, actor: tagOf(f.taskId) ?? 'CI', detail: `${f.pr ? `#${f.pr} ` : ''}CI failed`, taskId: f.taskId, nest: true });
  });

  for (const n of notes) {
    const isAsk = n.type === 'question' && n.authorType !== 'user';
    const isAnswer = n.authorType === 'user';
    if (!isAsk && !isAnswer) continue;
    const taskId = n.taskId && model.tasks[n.taskId] ? n.taskId : null;
    const title = n.title ? clip(n.title) : null;
    raw.push(isAsk
      ? { id: `note:${n.id}`, kind: 'question', at: n.createdAt, actor: tagOf(taskId) ?? 'agent', detail: title ? `escalated to you: ${title}` : 'escalated to you', taskId }
      : { id: `note:${n.id}`, kind: 'answered', at: n.createdAt, actor: 'you', detail: title ? `answered: ${title}` : 'answered', taskId });
  }

  if (model.complete && model.endedAt != null) {
    raw.push({ id: 'mission', kind: 'mission', at: model.endedAt, actor: 'mission', detail: completionText ? `completed · ${clip(completionText.split('\n')[0], 160)}` : 'completed', taskId: null });
  }

  raw.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const days: FeedDay[] = [];
  let prevDayStart: number | null = null;
  for (const e of raw) {
    const key = dayKey(e.at, tz);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      const start = Date.parse(`${key}T00:00:00Z`);
      day = { key, label: dayLabel(e.at, model.now, tz), quietDays: prevDayStart == null ? 0 : Math.max(0, Math.round((start - prevDayStart) / DAY_MS) - 1), events: [] };
      prevDayStart = start;
      days.push(day);
    }
    day.events.push({ ...e, time: hhmm(e.at, tz) });
  }
  return days;
}

/** Tie-break for events at the same instant: the order they happen in. */
const KIND_ORDER: Record<FeedEventKind, number> = {
  filed: 0, plan: 1, claim: 2, friction: 3, question: 4, answered: 5, pr: 6, failed: 7, done: 8, merged: 9, mission: 10,
};
