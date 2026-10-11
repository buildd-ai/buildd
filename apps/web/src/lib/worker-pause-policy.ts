/** Pure rules for pausing a running agent; see worker-pause.ts. */
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';

export type PauseRefusal =
  | { code: 'not_running'; status: number; error: string }
  | { code: 'interactive'; status: number; error: string }
  | { code: 'already_paused'; status: number; error: string };

interface PausableWorker {
  status: string;
  runner?: string | null;
  waitingFor?: unknown;
}

/** Why this worker cannot be paused, or null when it can. */
export function pauseRefusal(worker: PausableWorker): PauseRefusal | null {
  const waitingType = (worker.waitingFor as { type?: unknown } | null | undefined)?.type;
  if (worker.status === 'waiting_input' && waitingType === 'pause') {
    return { code: 'already_paused', status: 409, error: 'This run is already paused. Resume it from the task page.' };
  }
  if (worker.runner === INTERACTIVE_WORKER_RUNNER) {
    return { code: 'interactive', status: 400, error: 'This run is a local session on someone’s own machine; buildd can’t pause it.' };
  }
  if (worker.status !== 'running') {
    return { code: 'not_running', status: 409, error: `Only a running agent can be paused (this one is ${worker.status}).` };
  }
  return null;
}

/** Whether a PATCH response should tell the runner to pause. */
export function pauseServed(row: { status?: string | null; pauseRequestedAt?: Date | string | null } | null | undefined): boolean {
  return !!row?.pauseRequestedAt && row.status === 'running';
}
