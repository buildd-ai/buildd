/**
 * One check run per mission target (Living Specs 1dc6cc39 R-81): the server
 * files a single runner job for a mission's (revision, head, command set),
 * and the runner, with no agent session, checks the head out once and runs
 * each in-scope criterion's command in turn under its own timeout. Its report
 * carries one exit code and output tail per criterion; the server turns each
 * into that criterion's verdict (apps/web/src/lib/specs/criterion-checks.ts).
 *
 * Shared by the server (which writes the marker), the host runner and the
 * cloud Worker (which both run it and report the evidence).
 */

/** One criterion's command, as the server filed it. */
export interface CriterionBatchCheck {
  criterionId: string;
  /** The criterion's command, without any checkout: the runner checks the head out once for all of them. */
  command: string;
  /** This command's own limit. A slow neighbour never spends it. */
  timeoutMs: number;
}

/** The marker on the run's `context.specCriterionBatch`. Server-written. */
export interface CriterionBatchMarker {
  /** The verification task that first filed the run; outcome handling re-reads the selection through it. */
  subjectTaskId: string;
  missionId: string;
  specRevisionId: string;
  headSha: string;
  /** Hash of the (criterionId, command) set: a changed command set is a new run. */
  commandSet: string;
  /** The integrated target (`targetKey` of mission-verification) the run was filed for. */
  targetKey?: string;
  checks: CriterionBatchCheck[];
}

export type CriterionBatchOutcome = 'ok' | 'failed' | 'timeout' | 'exec_error';

export interface CriterionBatchResult {
  criterionId: string;
  command: string;
  outcome: CriterionBatchOutcome;
  exitCode?: number;
  durationMs?: number;
  timeoutMs?: number;
  /** The last CRITERION_BATCH_TAIL_BYTES of output: a test run's verdict is at its end. */
  stdout?: string;
  stderr?: string;
}

/** The runner's report, sent as the worker's `verificationEvidence`. */
export interface CriterionBatchEvidence {
  conditionType: 'criterion_batch';
  workerId: string;
  headSha: string;
  /** 'failed': the head could not be checked out, so no command ran (every result is exit 125). */
  checkout: 'ok' | 'failed';
  results: CriterionBatchResult[];
}

/** Exit code a result carries when the head could not be checked out (check-lines CHECKOUT_FAILED_EXIT). */
export const CRITERION_BATCH_CHECKOUT_FAILED_EXIT = 125;
export const CRITERION_BATCH_TAIL_BYTES = 4096;
/** Bounds the runner applies to a server-sized timeout. */
export const CRITERION_BATCH_MIN_TIMEOUT_MS = 30_000;
export const CRITERION_BATCH_MAX_TIMEOUT_MS = 20 * 60_000;
export const CRITERION_BATCH_CHECKOUT_TIMEOUT_MS = 120_000;

const SHA40 = /^[0-9a-f]{40}$/;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The batch marker on a task's context, or null when the task is not a batch run. */
export function criterionBatchOf(context: unknown): CriterionBatchMarker | null {
  const m = asRecord(asRecord(context)?.specCriterionBatch);
  if (!m) return null;
  const { subjectTaskId, missionId, specRevisionId, headSha, commandSet, targetKey, checks } = m;
  if (typeof subjectTaskId !== 'string' || typeof missionId !== 'string' || typeof specRevisionId !== 'string'
    || typeof headSha !== 'string' || !SHA40.test(headSha) || typeof commandSet !== 'string' || !Array.isArray(checks)) return null;
  const parsed: CriterionBatchCheck[] = [];
  for (const c of checks) {
    const r = asRecord(c);
    if (!r || typeof r.criterionId !== 'string' || typeof r.command !== 'string' || !r.command.trim()) return null;
    parsed.push({ criterionId: r.criterionId, command: r.command, timeoutMs: clampBatchTimeout(r.timeoutMs) });
  }
  if (parsed.length === 0) return null;
  return {
    subjectTaskId, missionId, specRevisionId, headSha, commandSet, checks: parsed,
    ...(typeof targetKey === 'string' ? { targetKey } : {}),
  };
}

export function clampBatchTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : CRITERION_BATCH_MIN_TIMEOUT_MS;
  return Math.min(CRITERION_BATCH_MAX_TIMEOUT_MS, Math.max(CRITERION_BATCH_MIN_TIMEOUT_MS, Math.round(n)));
}

/** The shell command that checks `headSha` out in the run's checkout, once for every criterion. */
export function batchCheckoutCommand(headSha: string): string {
  if (!SHA40.test(headSha)) throw new Error('headSha must be a full commit SHA');
  return `git fetch -q origin ${headSha} >/dev/null 2>&1; git checkout -q --detach ${headSha}`;
}

/** The last `limit` UTF-8 bytes of `text`, cut on a character boundary. */
export function tailExcerpt(text: string, limit = CRITERION_BATCH_TAIL_BYTES): string {
  const buf = new TextEncoder().encode(text);
  if (buf.length <= limit) return text;
  let start = buf.length - limit;
  // Skip UTF-8 continuation bytes so the cut lands on a character start.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(buf.subarray(start));
}
