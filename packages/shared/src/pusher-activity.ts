/**
 * Activity channels: where the dashboard-only, high-frequency Pusher events go.
 *
 * Pusher bills every delivery to every subscribed connection, not each
 * publish. Every runner subscribes to every workspace channel it can see and
 * to each of its own workers' channels, for task:* and the terminal worker
 * events. A `worker:progress` published there reached every runner, which
 * ignored it. So progress is published on the channel's `-activity` twin
 * instead, which only the dashboard subscribes to.
 *
 * Only worker and workspace channels have a twin. Server: `channels.workerActivity`
 * / `channels.workspaceActivity` (lib/pusher.ts). Client: `bindChannelEvents`
 * (lib/pusher-client.ts) routes each event to the channel it is published on.
 * Names here are unprefixed; add `PUSHER_CHANNEL_PREFIX` as the other channels do.
 */
export const PUSHER_ACTIVITY_SUFFIX = '-activity';

/** Events published only on activity channels, never on the worker or workspace channel. */
export const PUSHER_ACTIVITY_EVENTS: readonly string[] = ['worker:progress'];

export function workerActivityChannelName(workerId: string): string {
  return `worker-${workerId}${PUSHER_ACTIVITY_SUFFIX}`;
}

export function workspaceActivityChannelName(workspaceId: string): string {
  return `workspace-${workspaceId}${PUSHER_ACTIVITY_SUFFIX}`;
}

/**
 * The channel `event` is published on, for a subscriber that asked for
 * `channelName` (prefixed with `prefix`): the activity twin for an activity
 * event on a worker or workspace channel, otherwise `channelName` itself.
 */
export function channelForEvent(channelName: string, event: string, prefix = ''): string {
  if (!PUSHER_ACTIVITY_EVENTS.includes(event)) return channelName;
  if (channelName.endsWith(PUSHER_ACTIVITY_SUFFIX)) return channelName;
  const bare = channelName.startsWith(prefix) ? channelName.slice(prefix.length) : null;
  if (bare === null || !(bare.startsWith('worker-') || bare.startsWith('workspace-'))) return channelName;
  return `${channelName}${PUSHER_ACTIVITY_SUFFIX}`;
}

/**
 * The kind of a (possibly prefixed) channel, for usage counting:
 * `workspace`, `worker-activity`, `task`, ... ; `other` when unrecognised.
 */
export function pusherChannelKind(channelName: string, prefix = ''): string {
  const bare = prefix && channelName.startsWith(prefix) ? channelName.slice(prefix.length) : channelName;
  const kind = /^([a-z]+)-/.exec(bare)?.[1];
  if (!kind) return 'other';
  return bare.endsWith(PUSHER_ACTIVITY_SUFFIX) ? `${kind}-activity` : kind;
}
