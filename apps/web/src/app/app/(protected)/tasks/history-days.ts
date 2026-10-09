/**
 * History's day sections: episodes (newest first) cut into local calendar
 * days, each with a one-line tally, and the page size for "Show more".
 * Pure, so the server render and the client agree for a given time zone.
 */
import type { Episode } from '@/lib/activity-delivery';

/** Episodes shown before the first "Show more", and per press after it. */
export const HISTORY_PAGE = 20;

export interface HistoryDay {
  key: string;
  label: string;
  episodes: Episode[];
  /** "14 landed · 3 repaired · 1 to you", zero parts left out. */
  tally: string;
}

const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

function dayLabel(ms: number, nowMs: number, timeZone: string): string {
  const key = dayKey(ms, timeZone);
  if (key === dayKey(nowMs, timeZone)) return 'Today';
  if (key === dayKey(nowMs - 86_400_000, timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
}

export function dayTally(episodes: readonly Episode[]): string {
  const landed = episodes.filter(e => e.kind === 'landed').length;
  const repaired = episodes.filter(e => e.repairRounds > 0).length;
  const toYou = episodes.filter(e => e.kind === 'needs').length;
  const parts = [
    landed && `${landed} landed`,
    repaired && `${repaired} repaired`,
    toYou && `${toYou} to you`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `${episodes.length} ${episodes.length === 1 ? 'delivery' : 'deliveries'}`;
}

/**
 * Days in the order the episodes come (newest first). The tally counts every
 * episode of that day, including ones past the shown page, so a day's line
 * doesn't change when you press "Show more".
 */
export function groupEpisodesByDay(all: readonly Episode[], shown: number, nowMs: number, timeZone: string): HistoryDay[] {
  const byKey = new Map<string, Episode[]>();
  for (const e of all) {
    const k = dayKey(e.at, timeZone);
    const list = byKey.get(k);
    if (list) list.push(e); else byKey.set(k, [e]);
  }
  const days: HistoryDay[] = [];
  for (const e of all.slice(0, shown)) {
    const k = dayKey(e.at, timeZone);
    let day = days[days.length - 1];
    if (!day || day.key !== k) {
      day = { key: k, label: dayLabel(e.at, nowMs, timeZone), episodes: [], tally: dayTally(byKey.get(k)!) };
      days.push(day);
    }
    day.episodes.push(e);
  }
  return days;
}
