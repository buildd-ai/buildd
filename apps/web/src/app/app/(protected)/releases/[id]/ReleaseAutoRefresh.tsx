'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

export default function ReleaseAutoRefresh({
  releaseId,
  workspaceId,
}: {
  releaseId: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      router.refresh();
      refreshTimerRef.current = null;
    }, 500);
  }, [router]);

  useEffect(() => {
    if (!workspaceId) return;
    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const handleReleaseUpdated = (data: { releaseId?: string }) => {
      if (data.releaseId === releaseId) {
        doRefresh();
      }
    };

    channel.bind('release:updated', handleReleaseUpdated);

    return () => {
      channel.unbind('release:updated', handleReleaseUpdated);
      unsubscribeFromChannel(channelName);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [releaseId, workspaceId, doRefresh]);

  return null;
}
