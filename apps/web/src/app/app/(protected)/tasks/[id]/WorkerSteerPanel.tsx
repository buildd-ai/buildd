'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import InstructWorkerForm from './InstructWorkerForm';
import InstructionHistory from './InstructionHistory';
import { parseErrorMessage } from './RealTimeWorkerView';

interface Props {
  workerId: string;
  status: string;
  /** An open question is answered in the hero; /instruct is the wrong path for it. */
  hasUnansweredQuestion: boolean;
  instructionHistory: Array<{ message: string; timestamp: number; type: 'instruction' | 'response'; deliveryState?: 'pending' | 'delivered' }>;
}

/**
 * Side-panel controls for a live worker: steer it (an urgent instruction), see
 * what was said, or stop it. Hidden while a question is open — the question
 * hero is where that conversation happens.
 */
export default function WorkerSteerPanel({ workerId, status, hasUnansweredQuestion, instructionHistory }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isActive = ['running', 'starting', 'waiting_input'].includes(status);
  if (!isActive) return null;

  async function abort() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to abort'));
      setConfirm(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to abort worker');
    } finally {
      setLoading(false);
    }
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
                className="min-h-11 md:min-h-9 px-3 text-[12px] font-medium border-2 border-status-error text-status-error hover:bg-status-error/10 disabled:opacity-50"
              >
                {loading ? 'Stopping…' : 'Confirm stop'}
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="min-h-11 md:min-h-9 px-3 text-[12px] text-text-muted hover:text-text-primary">
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="worker-abort-btn"
              onClick={() => setConfirm(true)}
              className="min-h-11 md:min-h-9 px-3 text-[12px] font-medium border border-border-default text-text-secondary hover:border-status-error hover:text-status-error"
            >
              Stop agent
            </button>
          )}
        </div>
      )}
      {error && <p data-testid="worker-abort-error" className="text-sm text-status-error">{error}</p>}
      {!hasUnansweredQuestion && <InstructionHistory history={instructionHistory} />}
    </div>
  );
}
