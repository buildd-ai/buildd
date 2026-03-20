'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

/**
 * Invisible component that subscribes to workspace Pusher events
 * and triggers a page refresh when mission-related tasks are created,
 * claimed, or workers report progress. Follows the TaskAutoRefresh pattern.
 */
export default function MissionAutoRefresh({
  missionId,
  workspaceId,
  taskIds,
}: {
  missionId: string;
  workspaceId: string;
  /** Known task IDs belonging to this mission (for filtering worker events) */
  taskIds: string[];
}) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize taskIds to avoid re-renders on every SSR refresh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableTaskIds = useMemo(() => new Set(taskIds), [taskIds.join(',')]);

  const doRefresh = useCallback(() => {
    // Debounce: collapse rapid events into a single refresh
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

    // Task created — new task spawned (filter by missionId in payload)
    const handleTaskCreated = (data: { task?: { missionId?: string } }) => {
      if (data.task?.missionId === missionId) {
        doRefresh();
      }
    };

    // Task claimed — worker picked up a task (filter by known task IDs)
    const handleTaskClaimed = (data: { task?: { id?: string } }) => {
      if (data.task?.id && stableTaskIds.has(data.task.id)) {
        doRefresh();
      }
    };

    // Worker progress — filter by taskId matching a mission task
    const handleWorkerProgress = (data: { worker?: { taskId?: string } }) => {
      if (data.worker?.taskId && stableTaskIds.has(data.worker.taskId)) {
        doRefresh();
      }
    };

    // Worker completed
    const handleWorkerCompleted = (data: { worker?: { taskId?: string } }) => {
      if (data.worker?.taskId && stableTaskIds.has(data.worker.taskId)) {
        doRefresh();
      }
    };

    // Worker failed
    const handleWorkerFailed = (data: { worker?: { taskId?: string } }) => {
      if (data.worker?.taskId && stableTaskIds.has(data.worker.taskId)) {
        doRefresh();
      }
    };

    // Children completed — planning task's subtasks all done
    const handleChildrenCompleted = (data: { parentTaskId?: string }) => {
      if (data.parentTaskId && stableTaskIds.has(data.parentTaskId)) {
        doRefresh();
      }
    };

    channel.bind('task:created', handleTaskCreated);
    channel.bind('task:claimed', handleTaskClaimed);
    channel.bind('worker:progress', handleWorkerProgress);
    channel.bind('worker:completed', handleWorkerCompleted);
    channel.bind('worker:failed', handleWorkerFailed);
    channel.bind('task:children_completed', handleChildrenCompleted);

    return () => {
      channel.unbind('task:created', handleTaskCreated);
      channel.unbind('task:claimed', handleTaskClaimed);
      channel.unbind('worker:progress', handleWorkerProgress);
      channel.unbind('worker:completed', handleWorkerCompleted);
      channel.unbind('worker:failed', handleWorkerFailed);
      channel.unbind('task:children_completed', handleChildrenCompleted);
      unsubscribeFromChannel(channelName);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [missionId, workspaceId, stableTaskIds, doRefresh]);

  return null;
}
