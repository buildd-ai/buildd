/**
 * Mission History's two lenses over one source each, nothing re-derived here.
 *
 *   Highlights    — one item per delivery episode (Activity's fold of
 *                   `lib/activity-delivery.ts`, so a retry, a repair, a review
 *                   round and the merge are steps of one story, with the real
 *                   times the delivery record holds), plus the events no
 *                   episode carries: a question to you, your answer, the
 *                   mission finishing. Events of a task with no episode
 *                   (the projection hides it) stay as themselves.
 *   All activity  — the board's event feed, flat and chronological, one item
 *                   per event. Nothing nests, nothing folds.
 *
 * Counts are of what each lens lists, so the number printed beside a lens is
 * the number of items under it. Grouping is presentation: no kernel event or
 * delivery state is changed or inferred from display text.
 *
 * Pure and client-safe.
 */
import type { DeliveryKind, DeliveryTone } from './delivery-projection';
import type { Episode, EpisodeStep } from './activity-delivery';
import { formatClock, groupIntoDays, type DayGroup, type FeedEvent, type FeedEventKind } from './mission-event-feed';
import type { MissionBoardModel } from './mission-board';
import { displayTaskTitle } from './task-title';

export type HistoryLens = 'highlights' | 'all';

export interface HistoryStep extends EpisodeStep {
  /** `09:14`, in the team's zone. */
  time: string;
}

export interface EpisodeItem {
  type: 'episode';
  id: string;
  at: number;
  time: string;
  /** The task's own title; a plain fallback only when it has none. */
  title: string;
  /** The conventional-commit scope or short label (`kernel`, `copy`): secondary, never the title. */
  context: string | null;
  taskId: string;
  prNumber: number | null;
  deliveryKind: DeliveryKind;
  /** The newest step: what the delivery came to. */
  headline: string;
  tone: DeliveryTone;
  /** Chronological, in the order they happened. */
  steps: HistoryStep[];
}

export interface EventItem {
  type: 'event';
  id: string;
  at: number;
  time: string;
  title: string;
  context: string | null;
  taskId: string | null;
  prNumber: number | null;
  event: FeedEvent;
}

export type HistoryItem = EpisodeItem | EventItem;

export interface MissionHistory {
  lens: HistoryLens;
  days: Array<DayGroup<HistoryItem> & { count: number }>;
  counts: { highlights: number; all: number };
}

/** Events an episode never carries: a person's part, and the mission's end. */
const STANDALONE_KINDS: ReadonlySet<FeedEventKind> = new Set(['question', 'answered', 'mission']);

/** Events that belong to a task's delivery: an episode tells them, unless it has none. */
const DELIVERY_KINDS: ReadonlySet<FeedEventKind> = new Set(['claim', 'pr', 'merged', 'done', 'failed']);

const PR_IN_DETAIL = /#(\d+)/;

function eventItem(e: FeedEvent, model: MissionBoardModel): EventItem {
  const task = e.taskId ? model.tasks[e.taskId] : undefined;
  const inDetail = PR_IN_DETAIL.exec(e.detail)?.[1];
  const pr = inDetail ? Number(inDetail) : task?.pr?.number ?? null;
  return {
    type: 'event', id: e.id, at: e.at, time: e.time, title: e.title,
    // The scope is context only when the title came from the task itself.
    context: task ? task.scope ?? null : null,
    taskId: e.taskId, prNumber: e.kind === 'pr' || e.kind === 'merged' || e.kind === 'failed' ? pr : null, event: e,
  };
}

export function buildMissionHistory(input: {
  model: MissionBoardModel;
  /** `buildMissionEventFeed` days: every event, chronological. */
  feed: ReadonlyArray<{ events: readonly FeedEvent[] }>;
  /** `buildActivityEpisodes` over this mission's tasks. */
  episodes: readonly Episode[];
  lens: HistoryLens;
  timeZone?: string | null;
}): MissionHistory {
  const { model, feed, episodes, lens } = input;
  const tz = input.timeZone ?? undefined;
  const events = feed.flatMap(d => d.events);
  const counts = { highlights: 0, all: events.length };

  const episodeTasks = new Set(episodes.map(e => e.id));
  const episodeItems: EpisodeItem[] = episodes.map(ep => {
    const last = ep.steps[ep.steps.length - 1];
    return {
      type: 'episode', id: `episode:${ep.id}`, at: ep.at, time: formatClock(ep.at, tz),
      title: displayTaskTitle(ep.title) || 'Untitled task',
      context: model.tasks[ep.id]?.scope ?? null,
      taskId: ep.id, prNumber: ep.prNumber, deliveryKind: ep.kind,
      headline: last?.text ?? 'Queued', tone: last?.tone ?? 'muted',
      steps: ep.steps.map(s => ({ ...s, time: formatClock(s.at, tz) })),
    };
  });
  const highlightEvents = events
    .filter(e => STANDALONE_KINDS.has(e.kind) || (DELIVERY_KINDS.has(e.kind) && e.kind !== 'claim' && !(e.taskId && episodeTasks.has(e.taskId))))
    .map(e => eventItem(e, model));
  const highlights: HistoryItem[] = [...episodeItems, ...highlightEvents].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  counts.highlights = highlights.length;

  const items: HistoryItem[] = lens === 'highlights' ? highlights : events.map(e => eventItem(e, model));
  const days = groupIntoDays(items, model.now, tz).map(d => ({ ...d, count: d.items.length }));
  return { lens, days, counts };
}
