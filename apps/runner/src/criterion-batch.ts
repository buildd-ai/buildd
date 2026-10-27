/**
 * A mission's criterion checks, run by the runner with no agent session
 * (Living Specs 1dc6cc39 R-81; the wire shape is @buildd/shared
 * criterion-batch). One job per mission target: check the head out once,
 * then run each in-scope criterion's command in turn under its own timeout,
 * and report one exit code and output tail per criterion. The server turns
 * each into that criterion's verdict.
 *
 * A criterion that times out or cannot launch says nothing about the others:
 * each command has its own limit, so a slow neighbour never makes a fast
 * passing test read inconclusive.
 */
import {
  batchCheckoutCommand,
  CRITERION_BATCH_CHECKOUT_FAILED_EXIT,
  CRITERION_BATCH_CHECKOUT_TIMEOUT_MS,
  tailExcerpt,
  type CriterionBatchEvidence,
  type CriterionBatchMarker,
  type CriterionBatchOutcome,
  type CriterionBatchResult,
} from '@buildd/shared';
import { runVerificationCommand } from './runner-verification';

export interface BatchExecResult {
  outcome: CriterionBatchOutcome;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
}

/** Runs one shell command in `cwd` under `timeoutMs`, cutting each stream with `excerpt`. */
export type BatchExec = (command: string, cwd: string, timeoutMs: number, excerpt: (text: string) => string) => Promise<BatchExecResult>;

const defaultExec = (workerId: string): BatchExec => (command, cwd, timeoutMs, excerpt) =>
  runVerificationCommand({ workerId, iteration: 0, command, cwd, timeoutMs, excerpt });

export async function runCriterionBatch(
  opts: { workerId: string; cwd: string; marker: CriterionBatchMarker; onCheck?: (criterionId: string, index: number) => void },
  exec: BatchExec = defaultExec(opts.workerId),
): Promise<CriterionBatchEvidence> {
  const { marker } = opts;
  const excerpt = (text: string) => tailExcerpt(text);
  const checkout = await exec(batchCheckoutCommand(marker.headSha), opts.cwd, CRITERION_BATCH_CHECKOUT_TIMEOUT_MS, excerpt)
    .catch((err): BatchExecResult => ({ outcome: 'exec_error', stderr: err instanceof Error ? err.message : String(err) }));
  if (checkout.outcome !== 'ok') {
    // Nothing ran at the head: every criterion reads a failed checkout (inconclusive), never a fail.
    return {
      conditionType: 'criterion_batch', workerId: opts.workerId, headSha: marker.headSha, checkout: 'failed',
      results: marker.checks.map((c) => ({
        criterionId: c.criterionId, command: c.command, outcome: 'failed', exitCode: CRITERION_BATCH_CHECKOUT_FAILED_EXIT,
        durationMs: 0, ...(checkout.stderr ? { stderr: checkout.stderr } : {}),
      })),
    };
  }

  const results: CriterionBatchResult[] = [];
  for (const [i, check] of marker.checks.entries()) {
    opts.onCheck?.(check.criterionId, i);
    // Already bounded when the marker was read (criterionBatchOf).
    const timeoutMs = check.timeoutMs;
    let r: BatchExecResult;
    try {
      r = await exec(check.command, opts.cwd, timeoutMs, excerpt);
    } catch (err) {
      r = { outcome: 'exec_error', stderr: err instanceof Error ? err.message : String(err) };
    }
    results.push({
      criterionId: check.criterionId, command: check.command, outcome: r.outcome, timeoutMs,
      ...(typeof r.exitCode === 'number' ? { exitCode: r.exitCode } : {}),
      ...(typeof r.durationMs === 'number' ? { durationMs: r.durationMs } : {}),
      ...(r.stdout ? { stdout: r.stdout } : {}),
      ...(r.stderr ? { stderr: r.stderr } : {}),
    });
  }
  return { conditionType: 'criterion_batch', workerId: opts.workerId, headSha: marker.headSha, checkout: 'ok', results };
}

/** One plain line per criterion, for the run's summary. */
export function summarizeCriterionBatch(ev: CriterionBatchEvidence): string {
  if (ev.checkout === 'failed') return `Could not check out ${ev.headSha.slice(0, 7)}; no criterion command ran.`;
  const lines = ev.results.map((r) => `- ${r.criterionId}: ${r.outcome === 'ok' ? 'exit 0' : r.outcome === 'failed' ? `exit ${r.exitCode ?? '?'}` : r.outcome}${typeof r.durationMs === 'number' ? ` in ${(r.durationMs / 1000).toFixed(1)}s` : ''}`);
  return [`Ran ${ev.results.length} criterion check(s) at ${ev.headSha.slice(0, 7)} (no agent):`, ...lines].join('\n');
}
