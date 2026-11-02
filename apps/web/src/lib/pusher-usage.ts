/**
 * Pusher publish counter: one Redis hash per UTC day, one field per
 * `<event>|<channel kind>` (never a channel id), so the split of what is
 * published where can be read before and after a change.
 *
 * Pusher bills deliveries, not publishes: a publish costs one message per
 * subscribed connection. Runners subscribe to every workspace and worker
 * channel they can see, so `onRunnerChannels` is the share multiplied by the
 * runner fleet; the activity twins, task and mission channels reach only
 * dashboards (and a `buildd top` watch on a mission).
 *
 * Written by triggerEvent (lib/pusher.ts); read at GET /api/admin/pusher-usage.
 */
import { pusherChannelKind } from '@buildd/shared';
import { hgetAllKey, hincrWithTtl } from '@/lib/redis';

const CHANNEL_PREFIX = process.env.PUSHER_CHANNEL_PREFIX || '';

/** Kept long enough for a month's before/after. */
export const PUSHER_USAGE_TTL_SEC = 35 * 24 * 3600;

/** Channel kinds every runner connection subscribes to. */
const RUNNER_CHANNEL_KINDS = new Set(['workspace', 'worker']);

export function pusherUsageKey(day: string): string {
  return `pusher-usage:${day}`;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function recordPusherPublish(channel: string, event: string, now: Date = new Date()): Promise<void> {
  try {
    await hincrWithTtl(pusherUsageKey(utcDay(now)), `${event}|${pusherChannelKind(channel, CHANNEL_PREFIX)}`, PUSHER_USAGE_TTL_SEC);
  } catch {
    // A counter never fails a publish.
  }
}

export interface PusherUsageDay {
  day: string;
  total: number;
  /** Publishes on workspace and worker channels: each one reaches every runner holding them. */
  onRunnerChannels: number;
  byChannelKind: Record<string, number>;
  rows: Array<{ event: string; channelKind: string; publishes: number }>;
}

/** The last `days` UTC days, newest first; null when Redis could not be asked. */
export async function readPusherUsage(days: number, now: Date = new Date()): Promise<PusherUsageDay[] | null> {
  const out: PusherUsageDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = utcDay(new Date(now.getTime() - i * 24 * 3600 * 1000));
    const hash = await hgetAllKey(pusherUsageKey(day));
    if (hash === undefined) return null;
    const rows = Object.entries(hash ?? {})
      .map(([field, n]) => {
        const at = field.lastIndexOf('|');
        return { event: field.slice(0, at), channelKind: field.slice(at + 1), publishes: Number(n) || 0 };
      })
      .sort((a, b) => b.publishes - a.publishes);
    const byChannelKind: Record<string, number> = {};
    let total = 0;
    let onRunnerChannels = 0;
    for (const r of rows) {
      total += r.publishes;
      byChannelKind[r.channelKind] = (byChannelKind[r.channelKind] ?? 0) + r.publishes;
      if (RUNNER_CHANNEL_KINDS.has(r.channelKind)) onRunnerChannels += r.publishes;
    }
    out.push({ day, total, onRunnerChannels, byChannelKind, rows });
  }
  return out;
}
