'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

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

    const channels = workspaceIds.map(id => `${CHANNEL_PREFIX}workspace-${id}`);
    const handleUpdate = () => fetchCount();

    for (const ch of channels) {
      const channel = subscribeToChannel(ch);
      if (channel) {
        channel.bind('worker:progress', handleUpdate);
        channel.bind('worker:completed', handleUpdate);
        channel.bind('mission:note_posted', handleUpdate);
      }
    }

    return () => {
      for (const ch of channels) {
        unsubscribeFromChannel(ch);
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
