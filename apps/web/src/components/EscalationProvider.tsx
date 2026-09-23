'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { createEscalationRefresher } from '@/lib/realtime-throttle';

interface EscalationContextValue {
  count: number;
  refresh: () => void;
}

const EscalationContext = createContext<EscalationContextValue>({ count: 0, refresh: () => {} });

export function useEscalation() {
  return useContext(EscalationContext);
}

interface Props {
  workspaceIds: string[];
  children: React.ReactNode;
}

/**
 * BT-15: Provides the escalation inbox count to the nav badge (sidebar + bottom nav).
 * Fetches on mount and refreshes on PR-merge/reviewer Pusher events.
 *
 * Mounted on every protected page, and `worker:progress` fires every ~10s per
 * active worker — so refetches are filtered to status changes and throttled
 * (see createEscalationRefresher), and paused while the tab is hidden.
 */
export function EscalationProvider({ workspaceIds, children }: Props) {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/prs/escalation-inbox', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCount(data.count ?? 0);
      }
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  // Re-fetch when PR or worker events fire in any of the user's workspaces
  const workspaceIdsKey = workspaceIds.join(',');
  useEffect(() => {
    if (!workspaceIdsKey) return;

    const refresher = createEscalationRefresher({
      fetch: () => { fetchCount(); },
      isHidden: () => document.visibilityState === 'hidden',
    });

    const channels = workspaceIds.map(id => `${CHANNEL_PREFIX}workspace-${id}`);
    const events = ['worker:progress', 'worker:completed', 'mission:note_posted'] as const;
    const handlers = events.map(event => [event, (data: unknown) => refresher.onEvent(event, data)] as const);

    const bound = channels.map((ch) => {
      const channel = subscribeToChannel(ch);
      for (const [event, handler] of handlers) channel?.bind(event, handler);
      return { channelName: ch, channel };
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresher.onVisible();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Channels are shared with the other layout providers, so this handler must
    // be unbound explicitly — releasing the subscription no longer drops it.
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      refresher.dispose();
      for (const { channelName, channel } of bound) {
        for (const [event, handler] of handlers) channel?.unbind(event, handler);
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, fetchCount]);

  return (
    <EscalationContext.Provider value={{ count, refresh: fetchCount }}>
      {children}
    </EscalationContext.Provider>
  );
}
