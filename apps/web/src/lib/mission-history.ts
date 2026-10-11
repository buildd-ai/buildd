/**
 * Mission History's entries: the event feed with retries and repairs nested
 * under their parent, and its two filters. Pure and client-safe.
 *
 * Nesting happens within a day, under the task's most recent entry that is
 * not itself a retry or repair. An event with no such parent stays top-level.
 */
import type { FeedDay, FeedEvent, FeedEventKind } from './mission-event-feed';

export type HistoryFilter = 'changes' | 'everything';

export interface HistoryEntry {
  event: FeedEvent;
  /** Retries and repairs of this entry's task, in time order. */
  children: FeedEvent[];
}

export interface HistoryDay {
  key: string;
  label: string;
  quietDays: number;
  entries: HistoryEntry[];
  /** Events the day holds under this filter, children included. */
  count: number;
}

/** What changed the mission: work landed, was asked of you or answered, stopped, or finished. */
export const CHANGE_KINDS: ReadonlySet<FeedEventKind> = new Set(['pr', 'merged', 'done', 'question', 'answered', 'failed', 'mission']);

export function nestDay(events: readonly FeedEvent[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const event of events) {
    const parent = event.nest && event.taskId
      ? [...entries].reverse().find(e => e.event.taskId === event.taskId)
      : undefined;
    if (parent) parent.children.push(event);
    else entries.push({ event, children: [] });
  }
  return entries;
}

function filterEntries(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  if (filter === 'everything') return entries;
  return entries.flatMap(e => {
    const kids = e.children.filter(c => CHANGE_KINDS.has(c.kind));
    if (CHANGE_KINDS.has(e.event.kind)) return [{ event: e.event, children: kids }];
    // The parent is not a change but something under it is: it surfaces on its own.
    return kids.map(c => ({ event: c, children: [] }));
  });
}

export function buildHistory(days: readonly FeedDay[], filter: HistoryFilter): HistoryDay[] {
  return days.flatMap(d => {
    const entries = filterEntries(nestDay(d.events), filter);
    if (entries.length === 0) return [];
    return [{ key: d.key, label: d.label, quietDays: d.quietDays, entries, count: entries.reduce((n, e) => n + 1 + e.children.length, 0) }];
  });
}
