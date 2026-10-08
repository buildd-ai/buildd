'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { demandCatchUp } from '@/lib/app-freshness';
import {
  createThrottle,
  shouldRefreshHomeOnEvent,
  HOME_THROTTLE_MS,
  HOME_URGENT_MS,
} from '@/lib/realtime-throttle';

/**
 * Invisible component that keeps Home's action queue live.
 *
 * Home is a `force-dynamic` server component with no subscription of its own,
 * so an open tab froze its "Waiting on You" queue at page-load time — a Merge
 * card could still be offering to merge a PR that landed hours earlier. Follows
 * the MissionAutoRefresh / TaskAutoRefresh pattern, minus the task-id filter:
 * every event on a visible workspace can change what's waiting on the user.
 *
 * The PR merge/close webhook publishes `worker:progress` on the workspace
 * channel, so merges reconciled outside the dashboard land here too.
 *
 * Every refresh is a full server render, and runner heartbeats publish
 * `worker:progress` every ~10s per active worker, so heartbeats that don't
 * change a worker's status are ignored and the rest are throttled — see
 * shouldRefreshHomeOnEvent. Nothing refreshes while the tab is hidden: a
 * skipped event is handed to the shell's freshness coordinator
 * (lib/app-freshness.ts), which also catches up on return to the foreground and
 * on Pusher reconnect whether or not anything was seen.
 */
const REFRESH_EVENTS = [
  'task:created',
  'task:claimed',
  'task:completed',
  'task:failed',
  'task:unblocked',
  'worker:progress',
  'worker:completed',
  'worker:failed',
] as const;

export default function HomeAutoRefresh({ workspaceIds }: { workspaceIds: string[] }) {
  const router = useRouter();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableIds = useMemo(() => [...new Set(workspaceIds)], [workspaceIds.join(',')]);

  useEffect(() => {
    if (stableIds.length === 0) return;

    const lastStatusByWorker = new Map<string, string>();
    const throttle = createThrottle(() => {
      if (document.visibilityState === 'hidden') {
        demandCatchUp('missed');
        return;
      }
      router.refresh();
    }, { waitMs: HOME_THROTTLE_MS });

    const handlers = REFRESH_EVENTS.map(event => [event, (data: unknown) => {
      const decision = shouldRefreshHomeOnEvent(event, data, lastStatusByWorker);
      if (decision === 'none') return;
      if (document.visibilityState === 'hidden') {
        demandCatchUp('missed');
        return;
      }
      // Urgent transitions still wait briefly: a merge fans out several events,
      // and one re-render covers them.
      throttle.call({ maxDelayMs: decision === 'urgent' ? HOME_URGENT_MS : undefined });
    }] as const);

    const bound = stableIds.map((wsId) => {
      const channelName = `${CHANNEL_PREFIX}workspace-${wsId}`;
      const channel = subscribeToChannel(channelName);
      for (const [event, handler] of handlers) channel?.bind(event, handler);
      return { channelName, channel };
    });

    return () => {
      for (const { channelName, channel } of bound) {
        for (const [event, handler] of handlers) channel?.unbind(event, handler);
        unsubscribeFromChannel(channelName);
      }
      throttle.cancel();
    };
  }, [stableIds, router]);

  return null;
}
