'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { requestRefresh, flushRefresh } from './coalesced-refresh';

interface RouterLike {
  refresh: () => void;
}

// Exported for testing: the actual event→refresh wiring, decoupled from the
// Pusher subscription lifecycle. worker:progress is the steady ~10s-per-worker
// heartbeat and goes through the debounce; everything else here is a one-off
// status transition or terminal event and must never be delayed or merged away.
export function createEventHandlers(router: RouterLike, taskId: string, depTaskIds: string[]) {
  const handleClaimed = (data: { task: { id: string } }) => {
    if (data.task?.id === taskId) flushRefresh(router, taskId);
  };

  const handleWorkerEvent = (data: { taskId?: string; worker?: { taskId?: string } }) => {
    const eventTaskId = data.taskId ?? data.worker?.taskId;
    if (eventTaskId === taskId) requestRefresh(router, taskId);
  };

  const handleWorkerTerminal = (data: { taskId?: string; worker?: { taskId?: string } }) => {
    const eventTaskId = data.taskId ?? data.worker?.taskId;
    if (eventTaskId === taskId) flushRefresh(router, taskId);
  };

  const handleTaskUnblocked = (data: { taskId: string; resolvedDependency: string }) => {
    if (data.taskId === taskId) flushRefresh(router, taskId);
  };

  const handleChildrenCompleted = (data: { parentTaskId: string; childCount: number; completed: number; failed: number }) => {
    if (data.parentTaskId === taskId) flushRefresh(router, taskId);
  };

  const handleTaskCompleted = (data: { taskId: string }) => {
    if (depTaskIds.includes(data.taskId)) flushRefresh(router, taskId);
  };

  const handleTaskFailed = (data: { taskId: string }) => {
    if (depTaskIds.includes(data.taskId)) flushRefresh(router, taskId);
  };

  const handleTaskUpdated = (data: { task?: { id?: string } }) => {
    if (data.task?.id === taskId) flushRefresh(router, taskId);
  };

  return {
    handleClaimed,
    handleWorkerEvent,
    handleWorkerTerminal,
    handleTaskUnblocked,
    handleChildrenCompleted,
    handleTaskCompleted,
    handleTaskFailed,
    handleTaskUpdated,
  };
}

export function computeIsTerminalLeaf(
  taskStatus: string,
  taskMode: string,
  hasSubTasks: boolean,
  workerHasOpenPr: boolean,
): boolean {
  return (
    taskStatus === 'failed' ||
    (taskStatus === 'completed' && taskMode !== 'planning' && !hasSubTasks && !workerHasOpenPr)
  );
}

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
  workerHasOpenPr,
}: {
  taskId: string;
  workspaceId: string;
  taskStatus: string;
  taskMode: string;
  depTaskIds: string[];
  hasSubTasks: boolean;
  workerHasOpenPr: boolean;
}) {
  const router = useRouter();

  // Stabilize depTaskIds to avoid infinite re-renders (arrays are compared by reference)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableDepIds = useMemo(() => depTaskIds, [depTaskIds.join(',')]);

  useEffect(() => {
    // Skip subscriptions for truly terminal tasks:
    // - failed tasks never need updates
    // - completed non-planning tasks with no subtasks and no open PR are terminal leaf tasks
    // - completed tasks with an open PR stay subscribed until the PR merges/closes
    const isTerminalLeaf = computeIsTerminalLeaf(taskStatus, taskMode, hasSubTasks, workerHasOpenPr);

    if (isTerminalLeaf) return;

    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const {
      handleClaimed,
      handleWorkerEvent,
      handleWorkerTerminal,
      handleTaskUnblocked,
      handleChildrenCompleted,
      handleTaskCompleted,
      handleTaskFailed,
      handleTaskUpdated,
    } = createEventHandlers(router, taskId, stableDepIds);

    channel.bind('task:claimed', handleClaimed);
    channel.bind('task:updated', handleTaskUpdated);
    // worker:progress is the steady ~10s-per-worker heartbeat — debounced.
    // worker:completed/failed are terminal — refreshed immediately.
    channel.bind('worker:progress', handleWorkerEvent);
    channel.bind('worker:completed', handleWorkerTerminal);
    channel.bind('worker:failed', handleWorkerTerminal);
    channel.bind('task:unblocked', handleTaskUnblocked);
    channel.bind('task:children_completed', handleChildrenCompleted);
    channel.bind('task:completed', handleTaskCompleted);
    channel.bind('task:failed', handleTaskFailed);

    return () => {
      channel.unbind('task:claimed', handleClaimed);
      channel.unbind('task:updated', handleTaskUpdated);
      channel.unbind('worker:progress', handleWorkerEvent);
      channel.unbind('worker:completed', handleWorkerTerminal);
      channel.unbind('worker:failed', handleWorkerTerminal);
      channel.unbind('task:unblocked', handleTaskUnblocked);
      channel.unbind('task:children_completed', handleChildrenCompleted);
      channel.unbind('task:completed', handleTaskCompleted);
      channel.unbind('task:failed', handleTaskFailed);
      unsubscribeFromChannel(channelName);
    };
  }, [taskId, workspaceId, taskStatus, taskMode, stableDepIds, hasSubTasks, workerHasOpenPr, router]);

  return null;
}
