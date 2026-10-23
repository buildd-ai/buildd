'use client';

import { useContext, useState } from 'react';
import { useRouter } from 'next/navigation';
import { INTERACTIVE_WORKER_RUNNER, LIVE_WORKER_STATUSES } from '@buildd/shared';
import InstructWorkerForm from './InstructWorkerForm';
import InstructionHistory from './InstructionHistory';
import { parseErrorMessage } from './RealTimeWorkerView';
import { messageDeliveryStatus, type InstructionHistoryEntry } from '@/lib/worker-instructions';
import { RunStallContext } from './run-stall-context';

interface Props {
  workerId: string;
  status: string;
  /** An open question is answered in the hero; /instruct is the wrong path for it. */
  hasUnansweredQuestion: boolean;
  instructionHistory: InstructionHistoryEntry[];
  /** Task pages keep messages out of the default flow; other consumers retain receipts. */
  showHistory?: boolean;
  /**
   * The previous run of this task, when there is one: its messages the run
   * ended before reading are shown here, each with Resend (to this run).
   */
  earlierRun?: { workerId: string; status: string; history: InstructionHistoryEntry[] } | null;
  /** `workers.runner`. 'mcp' is a local claim_task session buildd cannot stop. */
  runner?: string | null;
  /** The task already ended (completed/failed/cancelled). */
  taskTerminal?: boolean;
  /** Restart re-queues this task; without it a stalled run offers Stop only. */
  taskId?: string;
  /**
   * `row`: the live block's controls (design 6356e80d `phone-task-running`):
   * Steer, Pause and Stop as one row, Steer opening the box under it.
   */
  layout?: 'stack' | 'row';
}

/**
 * Side-panel controls for a live worker: steer it (an urgent instruction), see
 * what was said, or stop it. Hidden while a question is open — the question
 * hero is where that conversation happens.
 *
 * A local session (runner 'mcp') runs on someone's own machine, so nothing here
 * can stop it. It gets "Release slot" instead: buildd stops counting it and
 * frees its seat; the session itself keeps running.
 */
export default function WorkerSteerPanel({ workerId, status, hasUnansweredQuestion, instructionHistory, runner, taskTerminal = false, earlierRun = null, showHistory = true, taskId, layout = 'stack' }: Props) {
  const router = useRouter();
  // A run with no progress for 30 minutes: Restart and Stop, Steer kept (R-7).
  const stall = useContext(RunStallContext);
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steerOpen, setSteerOpen] = useState(false);

  const isLocal = runner === INTERACTIVE_WORKER_RUNNER;
  const isActive = isLocal
    ? (LIVE_WORKER_STATUSES as readonly string[]).includes(status)
    : ['running', 'starting', 'waiting_input'].includes(status);
  if (!isActive) return null;

  async function post(path: string, body: Record<string, unknown>, fallback: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res, fallback));
      setConfirm(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setLoading(false);
    }
  }

  const abort = () => post(`/api/workers/${workerId}/cmd`, { action: 'abort' }, 'Could not abort the worker. Try again.');
  // Pause keeps the session: Resume (answering the pause) continues it (lib/worker-pause.ts).
  const pause = () => post(`/api/workers/${workerId}/pause`, {}, 'Could not pause the worker. Try again.');
  const canPause = status === 'running' && !stall;
  // The same re-queue as Retry elsewhere: the stuck run ends, a fresh one claims the task.
  const restart = () => post(`/api/tasks/${taskId}/reassign?force=true`, {}, 'Could not restart the task. Try again.');
  const canRestart = !!stall && !!taskId;
  const RESTART_TIP = 'Ends this run and starts the task again on a fresh session.';
  const PAUSE_TIP = 'Stops at the next safe point and keeps the session. Resume continues it.';
  // Same path and priority as the steer form: queued for this run's next turn.
  const resend = (message: string) => post(`/api/workers/${workerId}/instruct`, { message, priority: 'urgent' }, 'Could not resend the message. Try again.');

  const undelivered = earlierRun
    ? earlierRun.history.filter(e => e.type === 'instruction' && messageDeliveryStatus(e, earlierRun.status).state === 'undelivered')
    : [];
  const earlier = undelivered.length > 0 && earlierRun && !taskTerminal && !hasUnansweredQuestion ? (
    <InstructionHistory
      history={undelivered}
      workerStatus={earlierRun.status}
      onResend={resend}
      resending={loading}
      title="Not received · the previous run ended first"
      testId="earlier-run-undelivered"
    />
  ) : null;
  const release = () => post(
    `/api/workers/${workerId}/release-slot`,
    { reason: taskTerminal ? 'task already ended' : 'released from the task page' },
    'Could not release the slot. Try again.',
  );

  if (isLocal) {
    return (
      <div data-testid="worker-steer-panel" className="space-y-3">
        {!taskTerminal && !hasUnansweredQuestion && status !== 'starting' && <InstructWorkerForm workerId={workerId} pendingInstructions={null} />}
        <div data-testid="worker-release-slot" className="space-y-2">
          <p className="text-meta text-text-muted">
            {taskTerminal
              ? 'Task ended, but your session still holds a slot.'
              : 'Runs in your session. buildd can’t stop it.'}
          </p>
          {confirm ? (
            <>
              <p data-testid="worker-release-slot-confirm-copy" className="text-meta text-text-secondary">
                Frees the slot in buildd. Your session keeps running; close it yourself.
                {!taskTerminal && ' The task goes back to the queue.'}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={release}
                  disabled={loading}
                  className="min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-text-primary text-text-primary hover:bg-surface-3 disabled:opacity-50"
                >
                  {loading ? 'Releasing…' : 'Confirm release'}
                </button>
                <button type="button" onClick={() => setConfirm(false)} className="min-h-11 md:min-h-9 px-3 text-meta text-text-muted hover:text-text-primary">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-end">
              <button
                type="button"
                data-testid="worker-release-slot-btn"
                onClick={() => setConfirm(true)}
                className={taskTerminal
                  ? 'min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-text-primary text-text-primary hover:bg-surface-3'
                  : 'min-h-11 md:min-h-9 px-3 text-meta font-medium border border-border-default text-text-secondary hover:border-text-primary hover:text-text-primary'}
              >
                Release slot
              </button>
            </div>
          )}
        </div>
        {error && <p data-testid="worker-abort-error" className="text-sm text-status-error">{error}</p>}
        {earlier}
        {showHistory && !taskTerminal && !hasUnansweredQuestion && <InstructionHistory history={instructionHistory} workerStatus={status} />}

      </div>
    );
  }

  // Stop asks first; while it asks, Pause is offered as the safer move.
  const confirmControls = (
    <>
      {canPause && (
        <span data-testid="worker-stop-confirm-copy" className="mr-auto text-meta text-text-muted">
          Stopping loses work it hasn’t pushed. Pause keeps it.
        </span>
      )}
      {canPause && (
        <button
          type="button"
          data-testid="worker-pause-instead-btn"
          onClick={pause}
          disabled={loading}
          className="min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-text-primary text-text-primary hover:bg-surface-3 disabled:opacity-50"
        >
          Pause instead
        </button>
      )}
      <button
        type="button"
        onClick={abort}
        disabled={loading}
        className="min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-status-error text-status-error hover:bg-status-error/10 disabled:opacity-50"
      >
        {loading ? 'Stopping…' : 'Abort now'}
      </button>
      <button type="button" onClick={() => setConfirm(false)} className="min-h-11 md:min-h-9 px-3 text-meta text-text-muted hover:text-text-primary">
        Cancel
      </button>
    </>
  );

  if (layout === 'row') {
    const canSteer = !hasUnansweredQuestion && status !== 'starting';
    const ctl = 'min-h-11 px-3 text-body font-medium border border-border-default bg-card text-text-primary hover:border-text-primary disabled:opacity-50';
    return (
      <div data-testid="worker-steer-panel" className="space-y-3">
        {status !== 'starting' && (confirm ? (
          <div className="flex flex-wrap items-center justify-end gap-2">{confirmControls}</div>
        ) : (
          <div data-testid="worker-control-row" className="grid grid-cols-3 gap-2">
            {canSteer && (
              <button type="button" data-testid="worker-steer-toggle" aria-expanded={steerOpen} aria-controls={`steer-box-${workerId}`} onClick={() => setSteerOpen(o => !o)} className={ctl}>
                Steer
              </button>
            )}
            {canRestart && (
              <button type="button" data-testid="worker-restart-btn" onClick={restart} disabled={loading} title={RESTART_TIP} className={ctl}>
                {loading ? 'Restarting…' : 'Restart'}
              </button>
            )}
            {canPause && (
              <button type="button" data-testid="worker-pause-btn" onClick={pause} disabled={loading} title={PAUSE_TIP} className={ctl}>
                {loading ? 'Pausing…' : 'Pause'}
              </button>
            )}
            <button type="button" data-testid="worker-abort-btn" onClick={() => setConfirm(true)} className={`${ctl} hover:border-status-error hover:text-status-error`}>Stop</button>
          </div>
        ))}
        {canSteer && steerOpen && (
          <div id={`steer-box-${workerId}`}>
            <InstructWorkerForm workerId={workerId} pendingInstructions={null} />
          </div>
        )}
        {error && <p data-testid="worker-abort-error" className="text-sm text-status-error">{error}</p>}
        {earlier}
      </div>
    );
  }

  return (
    <div data-testid="worker-steer-panel" className="space-y-3">
      {!hasUnansweredQuestion && status !== 'starting' && <InstructWorkerForm workerId={workerId} pendingInstructions={null} />}
      {status !== 'starting' && (
        <div className="flex items-center justify-end gap-2">
          {confirm ? (
            confirmControls
          ) : (
            <>
            {canRestart && (
              <button
                type="button"
                data-testid="worker-restart-btn"
                onClick={restart}
                disabled={loading}
                title={RESTART_TIP}
                className="min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-text-primary text-text-primary hover:bg-surface-3 disabled:opacity-50"
              >
                {loading ? 'Restarting…' : 'Restart'}
              </button>
            )}
            {canPause && (
              <button
                type="button"
                data-testid="worker-pause-btn"
                onClick={pause}
                disabled={loading}
                title={PAUSE_TIP}
                className="min-h-11 md:min-h-9 px-3 text-meta font-medium border border-border-default text-text-secondary hover:border-text-primary hover:text-text-primary disabled:opacity-50"
              >
                {loading ? 'Pausing…' : 'Pause'}
              </button>
            )}
            <button
              type="button"
              data-testid="worker-abort-btn"
              onClick={() => setConfirm(true)}
              className="min-h-11 md:min-h-9 px-3 text-meta font-medium border border-border-default text-text-secondary hover:border-status-error hover:text-status-error"
            >
              Stop agent
            </button>
            </>
          )}
        </div>
      )}
      {error && <p data-testid="worker-abort-error" className="text-sm text-status-error">{error}</p>}
      {earlier}
      {showHistory && !hasUnansweredQuestion && <InstructionHistory history={instructionHistory} workerStatus={status} />}

    </div>
  );
}
