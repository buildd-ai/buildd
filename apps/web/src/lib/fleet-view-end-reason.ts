/**
 * How one run (a worker row) stands or ended, as a short sentence for Health ›
 * Runners and Home's Agents rows: "Done · merged as #12", "Stopped: session
 * limit · work kept · merged as #4235", "Failed: code or tests".
 *
 * A stop on a session or budget limit is not a failure: the runner keeps the
 * work ("[work preserved: …]") and the task carries on later, so it never
 * reads "failed". The raw error text is never shown, only its class.
 */
import { LIVE_WORKER_STATUSES } from './task-presentation';
import { classifyFailure } from './failure-classifier';

export interface RunEndInput {
  status: string;
  error?: string | null;
  prNumber?: number | null;
  /** This run's own PR merged. */
  mergedAt?: string | Date | null;
  /** A PR of the same task that merged, from this run or a later one. */
  taskMergedPr?: number | null;
  waitingFor?: { type?: string | null } | null;
}

const LIVE = new Set<string>(LIVE_WORKER_STATUSES);

export function runEndReason(r: RunEndInput): string {
  if (r.status === 'waiting_input') return r.waitingFor?.type === 'pause' ? 'Paused' : 'Needs input';
  if (LIVE.has(r.status)) return 'Working';
  if (r.status === 'paused') return 'Paused';
  if (r.status === 'cancelled') return 'Cancelled';
  if (r.status === 'superseded') return r.taskMergedPr ? `Superseded · merged as #${r.taskMergedPr}` : 'Superseded by another run';
  if (r.status === 'completed') {
    if (r.prNumber && r.mergedAt) return `Done · merged as #${r.prNumber}`;
    if (r.taskMergedPr) return `Done · merged as #${r.taskMergedPr}`;
    if (r.prNumber) return `Done · PR #${r.prNumber} open`;
    return 'Done';
  }
  const error = r.error ?? '';
  if (/aborted by user|cancelled by user|canceled by user/i.test(error)) return 'Cancelled';
  const merged = r.taskMergedPr ? ` · merged as #${r.taskMergedPr}` : '';
  if (classifyFailure(error) === 'budget_limited') {
    const which = /session limit|hit your session/i.test(error) ? 'session limit' : 'budget limit';
    const kept = /work preserved/i.test(error) ? ' · work kept' : '';
    return `Stopped: ${which}${kept}${merged}`;
  }
  if (r.taskMergedPr) return `Failed · the task later merged as #${r.taskMergedPr}`;
  switch (classifyFailure(error)) {
    case 'logic': return 'Failed: code or tests';
    case 'transient': return 'Failed: network or capacity';
    case 'environmental': return 'Failed: environment';
    default: return 'Failed';
  }
}
