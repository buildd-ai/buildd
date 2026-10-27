/**
 * History's day sections: episodes (newest first) cut into local calendar
 * days, each with a one-line tally, and the page size for "Show more".
 * Pure, so the server render and the client agree for a given time zone.
 */
import type { Episode } from '@/lib/activity-delivery';
import type { DeliveryOutcome } from '@/components/ui/DeliveryBar';

/** Episodes shown before the first "Show more", and per press after it. */
export const HISTORY_PAGE = 20;

/** The end mark an episode gets: what the finished delivery came to. */
export function outcomeOf(e: Episode): DeliveryOutcome {
  return e.kind === 'landed' ? 'delivered' : e.kind === 'needs' ? 'came-to-you' : 'not-delivered';
}

/** One day's totals. merged, review and closed are the bars by end mark; retried counts bars with a fix round. */
export interface DayTotals { merged: number; retried: number; review: number; closed: number }

export function dayTotals(episodes: readonly Episode[]): DayTotals {
  const t: DayTotals = { merged: 0, retried: 0, review: 0, closed: 0 };
  for (const e of episodes) {
    const o = outcomeOf(e);
    if (o === 'delivered') t.merged += 1; else if (o === 'came-to-you') t.review += 1; else t.closed += 1;
    if (e.repairRounds > 0) t.retried += 1;
  }
  return t;
}

const HOUR = 3_600_000;

export interface HistoryDay {
  key: string;
  label: string;
  /** Deliveries only, newest first: one bar each. */
  episodes: Episode[];
  /** Counted over exactly `episodes`, so the totals are the bars by end mark. */
  totals: DayTotals;
  /** The day axis in epoch ms, whole hours, shared by every bar of the day. */
  axis: { from: number; to: number };
}

const dayKey = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

function dayLabel(ms: number, nowMs: number, timeZone: string): string {
  const key = dayKey(ms, timeZone);
  if (key === dayKey(nowMs, timeZone)) return 'Today';
  if (key === dayKey(nowMs - 86_400_000, timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
}

/** When a delivery began: its earliest recorded step, else when it ended. */
export const startOf = (e: Episode) => e.steps.reduce((m, s) => Math.min(m, s.at), e.at);

/** A day's axis: from the hour its earliest delivery began (within 24h of the last end) to the hour after the last end. */
function axisOf(episodes: readonly Episode[]): { from: number; to: number } {
  const last = Math.max(...episodes.map(e => e.at));
  const to = Math.ceil((last + 1) / HOUR) * HOUR;
  const first = Math.min(...episodes.map(startOf));
  return { from: Math.floor(Math.max(first, to - 24 * HOUR) / HOUR) * HOUR, to };
}

/** Offsets 0..1 on an axis. */
export const offsetOn = (axis: { from: number; to: number }, at: number) => (at - axis.from) / Math.max(1, axis.to - axis.from);

/**
 * A bar's geometry on its day's axis. Fix ticks are the automatic repairs;
 * build hands over to verify when the PR opened, else halfway.
 */
export function barOf(e: Episode, axis: { from: number; to: number }) {
  const built = e.steps.find(s => s.text.startsWith('Built;'));
  return {
    start: offsetOn(axis, startOf(e)),
    end: offsetOn(axis, e.at),
    verifyStart: built ? offsetOn(axis, built.at) : undefined,
    fixRounds: e.steps.filter(s => s.repair && s.text.startsWith('Automatic repair')).map(s => offsetOn(axis, s.at)),
    outcome: outcomeOf(e),
  };
}

/** Evenly spaced hour marks along an axis, at most `max`, as offsets 0..1 with epoch ms. */
export function axisHours(axis: { from: number; to: number }, max = 6): { at: number; offset: number }[] {
  const hours = Math.max(1, Math.round((axis.to - axis.from) / HOUR));
  const step = Math.ceil(hours / max);
  const out: { at: number; offset: number }[] = [];
  for (let h = 0; h <= hours; h += step) out.push({ at: axis.from + h * HOUR, offset: offsetOn(axis, axis.from + h * HOUR) });
  return out;
}

/**
 * Deliveries (newest first) cut into local calendar days. A creation event is
 * no delivery and gets no bar. Paging adds whole days' worth: `shown` is
 * rounded up to the end of the day it lands in, so a day's totals are always
 * the bars on screen and never change on "Show more".
 */
export function groupEpisodesByDay(all: readonly Episode[], shown: number, nowMs: number, timeZone: string): HistoryDay[] {
  const deliveries = all.filter(e => !e.event);
  let n = Math.min(shown, deliveries.length);
  while (n > 0 && n < deliveries.length && dayKey(deliveries[n].at, timeZone) === dayKey(deliveries[n - 1].at, timeZone)) n += 1;
  const days: HistoryDay[] = [];
  for (const e of deliveries.slice(0, n)) {
    const k = dayKey(e.at, timeZone);
    let day = days[days.length - 1];
    if (!day || day.key !== k) {
      day = { key: k, label: dayLabel(e.at, nowMs, timeZone), episodes: [], totals: { merged: 0, retried: 0, review: 0, closed: 0 }, axis: { from: 0, to: 0 } };
      days.push(day);
    }
    day.episodes.push(e);
  }
  for (const d of days) { d.totals = dayTotals(d.episodes); d.axis = axisOf(d.episodes); }
  return days;
}
