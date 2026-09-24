'use client';

/**
 * The task's body inside the mission task sheet (TaskSheet.tsx), plus the data
 * hook that feeds it. The shell — bottom sheet on mobile, docked panel at md+ —
 * lives in TaskSheet; the phase action lives in TaskActionZone so the full task
 * page can share it.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import LiveWorkerActivity from './LiveWorkerActivity';
import StatusBadge from '@/components/StatusBadge';
import PrCard from '@/components/task/PrCard';
import WorkerStats from '@/components/task/WorkerStats';
import TaskSummary from '@/components/task/TaskSummary';
import AiFeedback from '@/components/AiFeedback';
import { deriveDisplayStatus, deriveTaskPhase } from '@/lib/task-presentation';
import { taskPageHref } from '@/lib/mission-task-href';
import { CHANNEL_PREFIX, getPusherClient, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import TaskActionZone from './TaskActionZone';

export interface TaskPanelData {
  id: string;
  title: string;
  status: string;
  description: string | null;
  mode: string | null;
  roleSlug: string | null;
  createdAt: string;
  missionId: string | null;
  backend: 'claude' | 'codex' | null;
  failover: { from: string; reason: string | null } | null;
  worker: {
    id: string;
    status: string;
    currentAction: string | null;
    turns: number | null;
    prUrl: string | null;
    prNumber: number | null;
    prLifecycleStatus: string | null;
    mergedAt: string | null;
    commitCount: number | null;
    filesChanged: number | null;
    linesAdded: number | null;
    linesRemoved: number | null;
    costUsd: string | null;
    inputTokens: number;
    outputTokens: number;
    startedAt: string | null;
    completedAt: string | null;
    waitingFor: { type: string; prompt: string; options?: string[] } | null;
    branch: string | null;
    milestones: Array<{ type: string; label: string; ts: number; [k: string]: unknown }> | null;
    account: { authType: string } | null;
  } | null;
  result: {
    summary: string | null;
    nextSuggestion: string | null;
  } | null;
  lastError: { excerpt: string; pattern: string | null; ts: string } | null;
  blockedByCount: number;
}

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** How often the open sheet re-reads `/summary` when nothing pushes to it. */
export const SUMMARY_POLL_MS = 5000;

/**
 * Poll only when it can matter: never while the tab is hidden, and never while
 * the Pusher channel is connected — then the task's own events refetch instead
 * (design: "Realtime", the sheet's poll).
 */
export function shouldPollSummary({ hidden, realtime }: { hidden: boolean; realtime: boolean }): boolean {
  return !hidden && !realtime;
}

/** Workspace events that can change what the open task's summary says. */
export const SUMMARY_REFRESH_EVENTS = ['task:claimed', 'worker:progress', 'worker:completed', 'worker:failed'] as const;

/** The task an event is about, across the thin `{taskId}` and legacy nested payloads. */
export function eventTaskId(data: unknown): string | null {
  const d = (data ?? {}) as { taskId?: unknown; task?: { id?: unknown }; worker?: { taskId?: unknown } };
  const id = d.taskId ?? d.task?.id ?? d.worker?.taskId;
  return typeof id === 'string' ? id : null;
}

export function useTaskSummary(taskId: string, { workspaceId }: { workspaceId?: string | null } = {}) {
  const [data, setData] = useState<TaskPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Stepping ‹ › changes taskId while a fetch for the previous one is in flight.
  const currentRef = useRef(taskId);
  currentRef.current = taskId;
  const realtimeRef = useRef(false);

  const fetchTask = useCallback(async () => {
    const id = taskId;
    try {
      const res = await fetch(`/api/tasks/${id}/summary`);
      if (!res.ok) throw new Error('Failed to load task');
      const json = (await res.json()) as TaskPanelData;
      if (currentRef.current !== id) return;
      setData(json);
      setError(null);
    } catch (err) {
      if (currentRef.current !== id) return;
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      if (currentRef.current === id) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    setError(null);
    fetchTask();
  }, [fetchTask]);

  // Realtime: while connected, the task's own events refetch and the poll rests.
  useEffect(() => {
    if (!workspaceId) return;
    const client = getPusherClient();
    if (!client) return;
    realtimeRef.current = client.connection.state === 'connected';
    const onState = (s: { current: string }) => {
      realtimeRef.current = s.current === 'connected';
    };
    client.connection.bind('state_change', onState);

    const channelName = `${CHANNEL_PREFIX}workspace-${workspaceId}`;
    const channel = subscribeToChannel(channelName);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = (payload: unknown) => {
      if (eventTaskId(payload) !== taskId || timer) return;
      timer = setTimeout(() => {
        timer = null;
        fetchTask();
      }, 500);
    };
    for (const e of SUMMARY_REFRESH_EVENTS) channel?.bind(e, handle);
    return () => {
      for (const e of SUMMARY_REFRESH_EVENTS) channel?.unbind(e, handle);
      if (channel) unsubscribeFromChannel(channelName);
      client.connection.unbind('state_change', onState);
      if (timer) clearTimeout(timer);
      realtimeRef.current = false;
    };
  }, [workspaceId, taskId, fetchTask]);

  // Fallback poll, paused while hidden or while realtime is live; catch up on return.
  useEffect(() => {
    const interval = setInterval(() => {
      if (shouldPollSummary({ hidden: document.hidden, realtime: realtimeRef.current })) fetchTask();
    }, SUMMARY_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) fetchTask();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchTask]);

  return { data, loading, error, refetch: fetchTask };
}

/** Rendered at once when a sheet opens, before `/summary` answers. */
export function TaskPanelSkeleton() {
  return (
    <div data-testid="task-sheet-skeleton" aria-busy="true" className="space-y-3 py-2">
      <span className="sr-only">Loading task…</span>
      <div className="h-5 w-3/4 bg-surface-3" />
      <div className="h-4 w-1/3 bg-surface-3" />
      <div className="h-20 w-full border border-border-default bg-surface-2" />
    </div>
  );
}

export interface TaskPanelBodyProps {
  data: TaskPanelData;
  onChanged: () => void | Promise<void>;
}

export default function TaskPanelBody({ data, onChanged }: TaskPanelBodyProps) {
  const w = data.worker;
  const isBlocked = data.status === 'pending' && data.blockedByCount > 0;
  // Canonical phase — shared with the task detail page (deriveTaskPhase), so the
  // sheet and the full page agree on what state a task is in.
  const phase = deriveTaskPhase({
    taskStatus: data.status,
    taskMode: data.mode,
    workerStatus: w?.status,
    workerWaitingFor: w?.waitingFor,
    isBlocked,
  });
  const displayStatus = deriveDisplayStatus(data.status, w?.status);
  const isRunning = phase === 'running';
  const hasPr = !!w?.prUrl;

  return (
    <div className="space-y-4">
      {/* Status — the badge keeps the task page's testid (AC-19). The title is
          the shell's heading (TaskSheet), so it is not repeated here. */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="task-header-status" data-status={displayStatus}>
            <StatusBadge status={displayStatus} />
          </span>
          {data.backend && (
            <span
              className="inline-flex items-center border border-border-default px-2 py-0.5 font-mono text-[11px] font-medium capitalize text-text-secondary"
              title={`Ran on the ${data.backend} backend`}
            >
              {data.backend}
            </span>
          )}
          {data.roleSlug && <span className="font-mono text-[11px] text-text-muted">{data.roleSlug}</span>}
          <span className="font-mono text-[11px] text-text-muted">{timeAgo(data.createdAt)}</span>
        </div>
      </div>

      {/* Failover note — a Claude task that got flipped to Codex mid-life */}
      {data.failover && (
        <p className="font-mono text-[11px] text-text-muted">
          Switched to <span className="capitalize text-text-secondary">{data.backend}</span> after{' '}
          <span className="capitalize">{data.failover.from}</span>
          {data.failover.reason === 'budget_exhausted' ? ' hit its budget' : ' failed'}.
        </p>
      )}

      {/* ── Action zone — the one decision this state needs, done here ── */}
      <TaskActionZone
        taskId={data.id}
        phase={phase}
        isBlocked={isBlocked}
        blockedByCount={data.blockedByCount}
        backend={data.backend}
        lastError={data.lastError}
        worker={w ? { id: w.id, waitingFor: w.waitingFor } : null}
        historyHref={taskPageHref({ taskId: data.id, missionId: data.missionId })}
        onChanged={onChanged}
      />

      {/* Live worker → first-class view: watch what it's doing, steer or stop it */}
      {isRunning && w && (
        <LiveWorkerActivity
          workerId={w.id}
          currentAction={w.currentAction}
          turns={w.turns}
          costUsd={w.costUsd}
          inputTokens={w.inputTokens}
          outputTokens={w.outputTokens}
          authType={w.account?.authType}
          milestones={(w.milestones ?? []) as never}
          onWorkerEvent={onChanged}
        />
      )}

      {/* PR → review CI state + merge (in GitHub) without leaving to find it */}
      {hasPr && w && (
        <PrCard
          prUrl={w.prUrl!}
          prNumber={w.prNumber}
          prLifecycleStatus={w.prLifecycleStatus}
          linesAdded={w.linesAdded}
          linesRemoved={w.linesRemoved}
          filesChanged={w.filesChanged}
        />
      )}

      {/* ── Details ── */}
      {data.description && (
        <p className="line-clamp-4 text-[13px] leading-relaxed text-text-secondary">{data.description}</p>
      )}

      {/* Worker stats — the run's shape once it's not live (live view owns these) */}
      {w && !isRunning && (
        <WorkerStats
          turns={w.turns}
          commitCount={w.commitCount}
          costUsd={w.costUsd}
          inputTokens={w.inputTokens}
          outputTokens={w.outputTokens}
          authType={w.account?.authType}
          branch={w.branch}
        />
      )}

      {data.result?.summary && (
        <TaskSummary summary={data.result.summary} entityId={`task-${data.id}-summary`} label="Summary" />
      )}

      {data.result?.nextSuggestion && (
        <div className="flex items-start gap-2">
          <p className="flex-1 text-[12px] italic text-text-muted">
            <span className="text-text-secondary">Suggested:</span> &ldquo;{data.result.nextSuggestion}&rdquo;
          </p>
          <AiFeedback entityType="summary" entityId={`task-${data.id}-suggestion`} compact />
        </div>
      )}
    </div>
  );
}
