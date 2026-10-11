/**
 * The record a task verdict is derived from, assembled from the rows the task
 * page already loads. Pure: the page passes its rows, and the state-change
 * recompute (lib/task-verdict-decision.ts) loads the same rows and calls the
 * same function, so the two can never derive different verdicts.
 */
import type { TaskEvidence, TaskMismatch } from '@buildd/shared';
import { isLiveWorkerStatus } from '@buildd/shared';
import type { CheckSource, TaskVerdict, VerdictCheck, VerdictInput, VerdictOpenAttempt } from './task-verdict';
import type { PriorAttemptFact, TraceOutcomeContext, TraceSettledAs } from './trace-consequence';
import { latestChecks } from './task-verdict';
import { parseTaskShippedRecord } from './task-shipped';
import { prListStatus, type PrDisplayState } from './pr-presentation';

export interface VerdictWorkerRow {
  id: string;
  status: string;
  waitingFor?: unknown;
  prUrl?: string | null;
  prNumber?: number | null;
  prLifecycleStatus?: string | null;
  mergedAt?: Date | string | null;
  error?: string | null;
  createdAt?: Date | string | null;
}

export interface VerdictAttemptRow {
  id: string;
  status: string;
  createdAt: Date | string;
  context: unknown;
  result: unknown;
}

export interface VerdictFactsInput {
  task: { status: string; mode?: string | null; result: unknown };
  /** This task's workers, newest first (the page's `taskWorkers`). */
  workers: readonly VerdictWorkerRow[];
  /** CI-fix attempts at this task's PR, oldest first. */
  ciAttempts: readonly VerdictAttemptRow[];
  openAttempt: VerdictOpenAttempt | null;
  openQuestion: boolean;
  inRelease: boolean;
  /**
   * The delivery's PR state when the workflow kernel owns the PR
   * (docs/specs/workflow-state-kernel.md §17.5). When set it wins over the
   * worker's fact-cache columns.
   */
  deliveryPrState?: PrDisplayState | null;
}

const ms = (v: Date | string | null | undefined): number => {
  if (!v) return 0;
  const n = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(n) ? 0 : n;
};

function firstLine(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? null;
  return line ? (line.length > 200 ? `${line.slice(0, 200)}…` : line) : null;
}

interface FailureContext { job?: string; test?: string; excerpt?: string; summary?: string }

function failureContextOf(context: unknown): FailureContext | null {
  const fc = (context as { failureContext?: unknown } | null)?.failureContext;
  return fc && typeof fc === 'object' ? fc as FailureContext : null;
}

function evidenceOf(result: unknown): TaskEvidence | null {
  const e = (result as { evidence?: unknown } | null)?.evidence;
  return e && typeof e === 'object' ? e as TaskEvidence : null;
}

/**
 * Every source that names checks, each with the moment it was captured:
 * the task's own evidence, each attempt's evidence at its end, and the
 * failing job each attempt was handed. A failing check's line comes from the
 * failure excerpt the CI digest recorded for that job, never from an
 * unrelated Bash trace.
 */
export function checkSourcesOf(input: Pick<VerdictFactsInput, 'task' | 'ciAttempts'>): CheckSource[] {
  const lineByJob = new Map<string, string>();
  for (const a of input.ciAttempts) {
    const fc = failureContextOf(a.context);
    const line = firstLine(fc?.excerpt) ?? firstLine(fc?.test);
    if (fc?.job && line) lineByJob.set(fc.job, line);
  }
  const fromEvidence = (e: TaskEvidence | null): CheckSource | null => {
    if (!e?.ciChecks || e.ciChecks.length === 0) return null;
    return {
      at: ms(e.capturedAt),
      checks: e.ciChecks.map((c): VerdictCheck => ({ name: c.name, state: c.state, url: c.url, line: c.state === 'failed' ? lineByJob.get(c.name) ?? null : null })),
    };
  };
  const out: CheckSource[] = [];
  const own = fromEvidence(evidenceOf(input.task.result));
  if (own) out.push(own);
  for (const a of input.ciAttempts) {
    const fc = failureContextOf(a.context);
    if (fc?.job) {
      const ctx = a.context as { ciRunUrl?: unknown } | null;
      out.push({
        at: ms(a.createdAt),
        checks: [{ name: fc.job, state: 'failed', url: typeof ctx?.ciRunUrl === 'string' ? ctx.ciRunUrl : null, line: lineByJob.get(fc.job) ?? null }],
      });
    }
    const ev = fromEvidence(evidenceOf(a.result));
    if (ev) out.push(ev);
  }
  return out;
}

/** The live worker the verdict reads: one running, or one waiting on a person. */
function liveWorkerOf(workers: readonly VerdictWorkerRow[]): VerdictInput['live'] {
  const w = workers.find(x => isLiveWorkerStatus(x.status));
  if (!w) return null;
  const waiting = !!w.waitingFor && typeof w.waitingFor === 'object' && (w.waitingFor as { type?: unknown }).type != null;
  return { status: w.status, waitingForInput: waiting };
}

export function buildVerdictInput(input: VerdictFactsInput): VerdictInput {
  const result = (input.task.result ?? null) as {
    summary?: unknown; summarySource?: unknown; shipped?: unknown; mismatch?: unknown; error?: unknown;
  } | null;
  const prWorker = input.workers.find(w => w.prUrl && w.prNumber) ?? null;
  const mismatch: TaskMismatch[] = [
    ...(Array.isArray(result?.mismatch) ? result!.mismatch as TaskMismatch[] : []),
    // The newest attempt's own mismatch (it claimed a fix the check denies).
    ...input.ciAttempts.slice(-1).flatMap(a => {
      const m = (a.result as { mismatch?: unknown } | null)?.mismatch;
      return Array.isArray(m) ? (m as TaskMismatch[]).filter(x => x.kind === 'fix_check_still_red' || x.kind === 'success_with_red_check') : [];
    }),
  ];
  const evidence = evidenceOf(input.task.result);
  return {
    taskStatus: input.task.status,
    taskMode: input.task.mode ?? null,
    live: liveWorkerOf(input.workers),
    openQuestion: input.openQuestion,
    pr: prWorker?.prUrl && prWorker.prNumber
      ? input.deliveryPrState
        ? { url: prWorker.prUrl, number: prWorker.prNumber, lifecycle: prListStatus(input.deliveryPrState), merged: input.deliveryPrState === 'merged' }
        : { url: prWorker.prUrl, number: prWorker.prNumber, lifecycle: prWorker.prLifecycleStatus ?? null, merged: !!prWorker.mergedAt }
      : null,
    checks: latestChecks(checkSourcesOf(input)),
    openAttempt: input.openAttempt,
    inRelease: input.inRelease,
    lede: parseTaskShippedRecord(result?.shipped)?.lede ?? null,
    summary: typeof result?.summary === 'string' ? result.summary : null,
    summarySource: typeof result?.summarySource === 'string' ? result.summarySource : null,
    failureLine: (typeof result?.error === 'string' ? result.error : null)
      ?? input.workers[0]?.error
      ?? evidence?.keyLines?.[0]
      ?? null,
    mismatch,
  };
}

/**
 * What the trace rules (lib/trace-consequence.ts) need to know about the
 * outcome, read off the verdict so the two never disagree: a shipped, done or
 * green-and-waiting task succeeded; a blocked-by-checks one has a red gate.
 */
export function traceOutcomeOf(
  verdict: TaskVerdict | null,
  taskStatus: string,
  priorAttempts?: readonly PriorAttemptFact[],
): TraceOutcomeContext {
  const settledAs: TraceSettledAs | null = verdict?.state === 'shipped' ? 'shipped'
    : verdict?.state === 'done' ? 'done'
    : verdict?.causeKey === 'needs_you:merge' ? 'ready_to_merge'
    : null;
  return {
    succeeded: settledAs != null,
    failed: taskStatus === 'failed' || verdict?.state === 'failed',
    gatingCheckRed: verdict?.state === 'blocked' && verdict.causeKey.startsWith('blocked:check'),
    settledAs,
    ...(priorAttempts ? { priorAttempts } : {}),
  };
}
