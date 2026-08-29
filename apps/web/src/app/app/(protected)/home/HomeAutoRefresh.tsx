'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { shouldRefreshOnVisible } from '@/lib/merge-outcome';

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
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRef = useRef<number>(Date.now());

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableIds = useMemo(() => [...new Set(workspaceIds)], [workspaceIds.join(',')]);

  const doRefresh = useCallback(() => {
    // Debounce: a merge fans out several events, and one re-render covers them.
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      lastRefreshRef.current = Date.now();
      router.refresh();
      refreshTimerRef.current = null;
    }, 500);
  }, [router]);

  useEffect(() => {
    if (stableIds.length === 0) return;

    const handler = () => doRefresh();
    const bound = stableIds.map((wsId) => {
      const channelName = `${CHANNEL_PREFIX}workspace-${wsId}`;
      const channel = subscribeToChannel(channelName);
      for (const event of REFRESH_EVENTS) channel?.bind(event, handler);
      return { channelName, channel };
    });

    return () => {
      for (const { channelName, channel } of bound) {
        for (const event of REFRESH_EVENTS) channel?.unbind(event, handler);
        unsubscribeFromChannel(channelName);
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [stableIds, doRefresh]);

  // Backstop: a tab that was hidden (or a laptop that was asleep) misses the
  // events entirely. Re-render on return to visibility, rate-limited so tab
  // flicking doesn't re-run the page's queries.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      if (!shouldRefreshOnVisible(lastRefreshRef.current, Date.now())) return;
      lastRefreshRef.current = Date.now();
      router.refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [router]);

  return null;
}
