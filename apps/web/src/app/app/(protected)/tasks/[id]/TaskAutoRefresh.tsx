'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

/**
 * Invisible component that subscribes to workspace Pusher events
 * and triggers a server-side page refresh when the task gets claimed,
 * a worker starts reporting progress, dependencies resolve, or children complete.
 */
export default function TaskAutoRefresh({
  taskId,
  workspaceId,
  taskStatus,
  taskMode,
  depTaskIds,
  hasSubTasks,
}: {
  taskId: string;
  workspaceId: string;
  taskStatus: string;
  taskMode: string;
  depTaskIds: string[];
  hasSubTasks: boolean;
}) {
  const router = useRouter();
  const refreshedRef = useRef(false);

  // Stabilize depTaskIds to avoid infinite re-renders (arrays are compared by reference)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableDepIds = useMemo(() => depTaskIds, [depTaskIds.join(',')]);

  useEffect(() => {
    // Skip subscriptions for truly terminal tasks:
    // - failed tasks never need updates
    // - completed non-planning tasks with no subtasks are terminal leaf tasks
    const isTerminalLeaf =
      taskStatus === 'failed' ||
      (taskStatus === 'completed' && taskMode !== 'planning' && !hasSubTasks);

    if (isTerminalLeaf) return;

    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const doRefresh = () => {
      if (!refreshedRef.current) {
        refreshedRef.current = true;
        setTimeout(() => {
          router.refresh();
          // Reset so future events can trigger another refresh
          refreshedRef.current = false;
        }, 500);
      }
    };

    // When a worker claims this task
    const handleClaimed = (data: { task: { id: string } }) => {
      if (data.task?.id === taskId) {
        doRefresh();
      }
    };

    // When a worker reports progress on this task
    const handleWorkerProgress = (data: { worker: { taskId: string } }) => {
      if (data.worker?.taskId === taskId) {
        doRefresh();
      }
    };

    // When a dependency of this task resolves, unblocking it
    const handleTaskUnblocked = (data: { taskId: string; resolvedDependency: string }) => {
      if (data.taskId === taskId) {
        doRefresh();
      }
    };

    // When all children of this task complete (planning tasks)
    const handleChildrenCompleted = (data: { parentTaskId: string; childCount: number; completed: number; failed: number }) => {
      if (data.parentTaskId === taskId) {
        doRefresh();
      }
    };

    // When any dep task completes or fails, refresh to update blocked status
    const handleTaskCompleted = (data: { taskId: string }) => {
      if (stableDepIds.includes(data.taskId)) {
        doRefresh();
      }
    };

    const handleTaskFailed = (data: { taskId: string }) => {
      if (stableDepIds.includes(data.taskId)) {
        doRefresh();
      }
    };

    channel.bind('task:claimed', handleClaimed);
    channel.bind('worker:progress', handleWorkerProgress);
    channel.bind('task:unblocked', handleTaskUnblocked);
    channel.bind('task:children_completed', handleChildrenCompleted);
    channel.bind('task:completed', handleTaskCompleted);
    channel.bind('task:failed', handleTaskFailed);

    return () => {
      channel.unbind('task:claimed', handleClaimed);
      channel.unbind('worker:progress', handleWorkerProgress);
      channel.unbind('task:unblocked', handleTaskUnblocked);
      channel.unbind('task:children_completed', handleChildrenCompleted);
      channel.unbind('task:completed', handleTaskCompleted);
      channel.unbind('task:failed', handleTaskFailed);
      unsubscribeFromChannel(channelName);
    };
  }, [taskId, workspaceId, taskStatus, taskMode, stableDepIds, hasSubTasks, router]);

  return null;
}
