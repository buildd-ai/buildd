'use client';

import { useEffect, useState } from 'react';
import type { HealthQueueWaitingRow } from '@buildd/shared';
import Sheet from '@/components/ui/Sheet';
import { useTaskStart, type TaskStart } from '@/components/tasks/useTaskStart';
import { fetchTaskWaiting, refusalFromWaiting } from '@/lib/task-actions';
import { CoordinationRefusal, seenDeclared } from '@/app/app/(protected)/missions/[id]/TaskActionZone';

/**
 * A Blocked row's start (spec 4bc3e70e r8 R-20, AC-13): the same action the
 * task page offers. It reads the task's canonical reasons (GET /waiting),
 * shows them in the shared confirmation (Skips, Still enforced), and confirms
 * through `/start` with the digest. A Limit is a Force start; a Dependency is
 * Start anyway (spec 36df686b): the agent assesses, the edge stays. What the
 * server accepted is said as requested, never as running, until a runner
 * claims it.
 */

const CHECK_FAILED = 'Could not check what holds it. Try again.';

/** The observed state of an accepted start, in plain words. */
export function startStatusLine(start: Pick<TaskStart, 'status' | 'forced'>): string | null {
  if (start.status === 'accepted') return 'Claimed by a runner';
  if (start.status !== 'waiting' && start.status !== 'queued') return null;
  const anyway = start.forced?.gates.includes('Declared dependency');
  const what = anyway ? 'Start anyway requested' : start.forced ? 'Force start requested' : 'Start requested';
  return start.status === 'queued' ? `${what}. Waiting for a runner to claim it.` : `${what}.`;
}

function StartBody({ row, onDone }: { row: HealthQueueWaitingRow; onDone: () => void }) {
  const start = useTaskStart({ taskId: row.id, workspaceId: row.workspaceId, onStarted: onDone });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    void fetchTaskWaiting(row.id).then(w => {
      if (!live) return;
      const refusal = w ? refusalFromWaiting(w) : null;
      if (refusal) start.present(refusal);
      else setLoadError(w ? 'Nothing holds it now. It starts with the next free runner.' : CHECK_FAILED);
    });
    return () => { live = false; };
  }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = startStatusLine(start);
  return (
    <div className="space-y-3" data-testid="queue-start-sheet" data-action={row.reason === 'declared' ? 'start_anyway' : 'force_start'}>
      <p className="text-title font-semibold text-text-primary [overflow-wrap:anywhere]">{row.title}</p>
      {loadError && <p className="text-body text-text-muted" role="status">{loadError}</p>}
      {start.error && <p className="text-body text-status-error" role="alert">{start.error}</p>}
      {status && <p className="text-body text-text-primary" role="status" data-testid="queue-start-status">{status}</p>}
      {start.status === 'gated' && start.refusal && (
        <CoordinationRefusal
          refusal={start.refusal}
          pending={start.pending}
          taskTitle={row.title}
          onForce={kinds => {
            const refusal = start.refusal;
            if (refusal?.reasonsDigest) void start.start({ force: { kinds, reasonsDigest: refusal.reasonsDigest, ...seenDeclared(refusal) } });
          }}
          onCancel={start.dismiss}
        />
      )}
    </div>
  );
}

export default function QueueStartSheet({ row, onClose, onDone }: { row: HealthQueueWaitingRow | null; onClose: () => void; onDone: () => void }) {
  const title = row?.reason === 'declared' ? 'Start anyway' : 'Force start';
  return (
    <Sheet open={!!row} onClose={onClose} title={title} trapFocus testId="queue-start">
      {row && <StartBody key={row.id} row={row} onDone={onDone} />}
    </Sheet>
  );
}
