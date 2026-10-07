'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { INTERACTIVE_WORKER_RUNNER, LIVE_WORKER_STATUSES } from '@buildd/shared';
import InstructWorkerForm from './InstructWorkerForm';
import InstructionHistory from './InstructionHistory';
import { parseErrorMessage } from './RealTimeWorkerView';
import { messageDeliveryStatus, type InstructionHistoryEntry } from '@/lib/worker-instructions';

interface Props {
  workerId: string;
  status: string;
  /** An open question is answered in the hero; /instruct is the wrong path for it. */
  hasUnansweredQuestion: boolean;
  instructionHistory: InstructionHistoryEntry[];
  /**
   * The previous run of this task, when there is one: its messages the run
   * ended before reading are shown here, each with Resend (to this run).
   */
  earlierRun?: { workerId: string; status: string; history: InstructionHistoryEntry[] } | null;
  /** `workers.runner`. 'mcp' is a local claim_task session buildd cannot stop. */
  runner?: string | null;
  /** The task already ended (completed/failed/cancelled). */
  taskTerminal?: boolean;
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
export default function WorkerSteerPanel({ workerId, status, hasUnansweredQuestion, instructionHistory, runner, taskTerminal = false, earlierRun = null }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const abort = () => post(`/api/workers/${workerId}/cmd`, { action: 'abort' }, 'Failed to abort worker');
  // Same path and priority as the steer form: queued for this run's next turn.
  const resend = (message: string) => post(`/api/workers/${workerId}/instruct`, { message, priority: 'urgent' }, 'Failed to resend');

  const undelivered = earlierRun
    ? earlierRun.history.filter(e => e.type === 'instruction' && messageDeliveryStatus(e, earlierRun.status).state === 'undelivered')
    : [];
  const earlier = undelivered.length > 0 && earlierRun && !taskTerminal && !hasUnansweredQuestion ? (
    <InstructionHistory
      history={undelivered}
      workerStatus={earlierRun.status}
      onResend={resend}
      resending={loading}
      title="Not delivered · the previous run ended first"
      testId="earlier-run-undelivered"
    />
  ) : null;
  const release = () => post(
    `/api/workers/${workerId}/release-slot`,
    { reason: taskTerminal ? 'task already ended' : 'released from the task page' },
    'Failed to release slot',
  );

  if (isLocal) {
    return (
      <div data-testid="worker-steer-panel" className="space-y-3">
        {!taskTerminal && !hasUnansweredQuestion && status !== 'starting' && <InstructWorkerForm workerId={workerId} pendingInstructions={null} />}
        <div data-testid="worker-release-slot" className="space-y-2">
          <p className="text-meta text-text-muted">
            {taskTerminal
              ? 'Task ended, but a local session still holds a slot.'
              : 'Runs in a local session. Buildd can’t stop it.'}
          </p>
          {confirm ? (
            <>
              <p data-testid="worker-release-slot-confirm-copy" className="text-meta text-text-secondary">
                Frees the slot in Buildd. The local session keeps running; close it yourself.
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
        {!taskTerminal && !hasUnansweredQuestion && <InstructionHistory history={instructionHistory} workerStatus={status} />}
      </div>
    );
  }

  return (
    <div data-testid="worker-steer-panel" className="space-y-3">
      {!hasUnansweredQuestion && status !== 'starting' && <InstructWorkerForm workerId={workerId} pendingInstructions={null} />}
      {status !== 'starting' && (
        <div className="flex items-center justify-end gap-2">
          {confirm ? (
            <>
              <button
                type="button"
                onClick={abort}
                disabled={loading}
                className="min-h-11 md:min-h-9 px-3 text-meta font-medium border-2 border-status-error text-status-error hover:bg-status-error/10 disabled:opacity-50"
              >
                {loading ? 'Stopping…' : 'Confirm stop'}
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="min-h-11 md:min-h-9 px-3 text-meta text-text-muted hover:text-text-primary">
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="worker-abort-btn"
              onClick={() => setConfirm(true)}
              className="min-h-11 md:min-h-9 px-3 text-meta font-medium border border-border-default text-text-secondary hover:border-status-error hover:text-status-error"
            >
              Stop agent
            </button>
          )}
        </div>
      )}
      {error && <p data-testid="worker-abort-error" className="text-sm text-status-error">{error}</p>}
      {earlier}
      {!hasUnansweredQuestion && <InstructionHistory history={instructionHistory} workerStatus={status} />}
    </div>
  );
}
