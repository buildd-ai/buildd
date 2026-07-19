'use client';

import { useState, useEffect, useRef, type ComponentProps } from 'react';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { buildAgentTree, flattenAgentTree, type AgentProgressEntry } from '@/lib/agent-tree';
import WorkerActivityTimeline, { collapseWorkspacePath } from '../../tasks/[id]/WorkerActivityTimeline';

type Milestones = ComponentProps<typeof WorkerActivityTimeline>['milestones'];

interface Props {
  workerId: string;
  currentAction: string | null;
  turns: number | null;
  costUsd: string | null;
  milestones: Milestones;
  /** Called on every worker realtime event so the panel can refetch the summary
   *  (turns/cost/status/PR) and flip out of the running view when the run ends. */
  onWorkerEvent: () => void;
}

/**
 * First-class live view of a running agent, embedded in the task peek drawer.
 *
 * Subscribes to the same `worker-{id}` Pusher channel the full task page uses,
 * so you watch the run — current action, the live background-agents tree, and
 * the milestone timeline — without leaving your place in the mission. Also lets
 * you steer (urgent /instruct) or stop (/cmd abort) the agent in place.
 *
 * `taskProgress` is transient (event-only, never persisted), so it's consumed
 * straight off the event; everything else refreshes via onWorkerEvent().
 */
export default function LiveWorkerActivity({
  workerId,
  currentAction,
  turns,
  costUsd,
  milestones,
  onWorkerEvent,
}: Props) {
  const [taskProgress, setTaskProgress] = useState<AgentProgressEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [steering, setSteering] = useState(false);
  const [steerBusy, setSteerBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  // Keep the latest callback in a ref so the Pusher subscription isn't torn
  // down and rebuilt whenever the parent re-renders.
  const onEventRef = useRef(onWorkerEvent);
  onEventRef.current = onWorkerEvent;

  useEffect(() => {
    const channelName = `${CHANNEL_PREFIX}worker-${workerId}`;
    const channel = subscribeToChannel(channelName);
    if (!channel) return;

    const handle = (data: { taskProgress?: AgentProgressEntry[] }) => {
      setTaskProgress(data.taskProgress ?? []);
      onEventRef.current();
    };

    channel.bind('worker:progress', handle);
    channel.bind('worker:completed', handle);
    channel.bind('worker:failed', handle);
    return () => {
      channel.unbind('worker:progress', handle);
      channel.unbind('worker:completed', handle);
      channel.unbind('worker:failed', handle);
      unsubscribeFromChannel(channelName);
    };
  }, [workerId]);

  async function sendSteer(message: string) {
    setSteerBusy(true);
    setActionNote(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, priority: 'urgent' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to send');
      setSteering(false);
      setActionNote('Message delivered');
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSteerBusy(false);
    }
  }

  async function stop() {
    setStopBusy(true);
    setActionNote(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to stop');
      setConfirmStop(false);
      onEventRef.current();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : 'Failed to stop');
    } finally {
      setStopBusy(false);
    }
  }

  const tree = taskProgress.length > 0 ? flattenAgentTree(buildAgentTree(taskProgress)) : [];

  return (
    <div className="rounded-lg border border-status-info/30 bg-status-info/5 p-4 space-y-3">
      {/* Current action */}
      <div className="flex items-start gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse shrink-0 mt-1.5" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`text-[12px] text-status-info text-left flex-1 min-w-0 ${expanded ? 'break-words' : 'truncate'}`}
          title={currentAction || undefined}
        >
          {currentAction ? collapseWorkspacePath(currentAction) : 'Working…'}
        </button>
      </div>

      {/* Live turns / cost */}
      <div className="flex items-center gap-3 text-[11px] text-text-muted tabular-nums">
        {turns != null && <span>{turns} turn{turns !== 1 ? 's' : ''}</span>}
        {costUsd != null && <span>${Number(costUsd).toFixed(3)}</span>}
      </div>

      {/* Live background-agents tree (transient, from Pusher) */}
      {tree.length > 0 && (
        <div className="rounded-md border border-border-default/50 bg-surface-3 p-2.5 space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-text-muted">Background Agents</div>
          {tree.map((tp) => (
            <div key={tp.taskId} className="flex items-center justify-between font-mono text-[11px]">
              <div
                className="flex items-center gap-2 min-w-0"
                style={{ paddingLeft: tp.depth > 0 ? `${tp.depth * 14}px` : undefined }}
              >
                {tp.depth > 0 && <span className="text-text-muted select-none" aria-hidden>└</span>}
                <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-status-pulse shrink-0" />
                <span className="text-text-secondary truncate">{tp.agentName || tp.taskId.slice(0, 8)}</span>
              </div>
              <div className="flex items-center gap-3 text-text-muted shrink-0">
                <span>{tp.toolCount} tool{tp.toolCount !== 1 ? 's' : ''}</span>
                <span>{Math.round(tp.durationMs / 1000)}s</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Milestone timeline */}
      {milestones && milestones.length > 0 && (
        <WorkerActivityTimeline milestones={milestones} currentAction={currentAction} />
      )}

      {/* Steer / Stop */}
      {steering ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const input = (e.target as HTMLFormElement).elements.namedItem('steer') as HTMLInputElement;
            const v = input.value.trim();
            if (v) sendSteer(v);
          }}
          className="flex gap-2"
        >
          <input
            name="steer"
            autoFocus
            placeholder="Steer the agent…"
            className="flex-1 px-2.5 py-1.5 text-[12px] rounded-md border border-border-default bg-surface-1 focus:ring-2 focus:ring-status-info/40 focus:border-status-info"
          />
          <button type="submit" disabled={steerBusy} className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-status-info/15 text-status-info hover:bg-status-info/25 disabled:opacity-50">
            {steerBusy ? '…' : 'Send'}
          </button>
          <button type="button" onClick={() => setSteering(false)} className="px-2 py-1.5 text-[12px] text-text-muted hover:text-text-primary">
            Cancel
          </button>
        </form>
      ) : confirmStop ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-text-secondary flex-1">Stop this agent?</span>
          <button onClick={stop} disabled={stopBusy} className="px-3 py-1.5 text-[12px] font-medium rounded-md bg-status-error/15 text-status-error hover:bg-status-error/25 disabled:opacity-50">
            {stopBusy ? 'Stopping…' : 'Yes, stop'}
          </button>
          <button onClick={() => setConfirmStop(false)} className="px-2 py-1.5 text-[12px] text-text-muted hover:text-text-primary">
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setSteering(true); setActionNote(null); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md bg-surface-3 text-text-primary hover:bg-card-hover transition-colors"
          >
            Steer
          </button>
          <button
            onClick={() => { setConfirmStop(true); setActionNote(null); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md text-status-error hover:bg-status-error/10 transition-colors"
          >
            Stop
          </button>
        </div>
      )}

      {actionNote && <p className="text-[11px] text-text-muted">{actionNote}</p>}
    </div>
  );
}
