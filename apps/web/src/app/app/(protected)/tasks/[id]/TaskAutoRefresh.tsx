'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';

/**
 * Invisible component that subscribes to workspace Pusher events
 * and triggers a server-side page refresh when the task gets claimed
 * or a worker starts reporting progress.
 */
export default function TaskAutoRefresh({
  taskId,
  workspaceId,
  taskStatus,
}: {
  taskId: string;
  workspaceId: string;
  taskStatus: string;
}) {
  const router = useRouter();
  const refreshedRef = useRef(false);

  useEffect(() => {
    // Only auto-refresh for pending/assigned/blocked tasks (waiting for worker or unblock)
    if (!['pending', 'assigned', 'blocked'].includes(taskStatus)) return;

    const channelName = `workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const handleClaimed = (data: { task: { id: string } }) => {
      if (data.task?.id === taskId && !refreshedRef.current) {
        refreshedRef.current = true;
        // Small delay to let the DB settle
        setTimeout(() => router.refresh(), 500);
      }
    };

    const handleWorkerProgress = (data: { worker: { taskId: string } }) => {
      if (data.worker?.taskId === taskId && !refreshedRef.current) {
        refreshedRef.current = true;
        router.refresh();
      }
    };

    const handleUnblocked = (data: { task: { id: string } }) => {
      if (data.task?.id === taskId && !refreshedRef.current) {
        refreshedRef.current = true;
        setTimeout(() => router.refresh(), 500);
      }
    };

    channel.bind('task:claimed', handleClaimed);
    channel.bind('worker:progress', handleWorkerProgress);
    channel.bind('task:unblocked', handleUnblocked);

    return () => {
      channel.unbind('task:claimed', handleClaimed);
      channel.unbind('worker:progress', handleWorkerProgress);
      channel.unbind('task:unblocked', handleUnblocked);
      unsubscribeFromChannel(channelName);
    };
  }, [taskId, workspaceId, taskStatus, router]);

  return null;
}
