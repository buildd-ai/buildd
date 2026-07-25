/**
 * Loop-until-verified dispatcher.
 *
 * Evaluates exit conditions at worker completion time. The completion route is
 * the ONLY authority that may evaluate a condition and increment loopIteration.
 * Stale cleanup and webhook handlers must never call these functions — doing so
 * would create a double-evaluation race where two paths increment loopIteration
 * independently and dispatch two workers for the same iteration.
 *
 * See docs/design/loop-until-verified.md for the full spec.
 */

import type { LoopConfig, LoopExitCondition, LoopHistoryEntry, LoopState } from '@buildd/shared';
import { laterStartAt } from '@/lib/deferred-start';
import { LOOP_MAX_LOOPS_DEFAULT, LOOP_BACKOFF_MINUTES_DEFAULT } from '@buildd/core/loop-config';

/** Evidence shape produced by runner-verification.ts and sent in the completion payload. */
export interface RunnerVerificationEvidence {
  workerId: string;
  iteration: number;
  conditionType: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  outcome: 'ok' | 'failed' | 'timeout' | 'exec_error';
}

export type ConditionResult =
  | { satisfied: true; summary: string; evidence?: Record<string, unknown> }
  | { satisfied: false; summary: string; evidence?: Record<string, unknown> };

/**
 * Evaluate the exit condition for this iteration.
 *
 * - command: validate runner evidence binding (workerId + iteration), then check exit code.
 * - pr_checks_green: check prLifecycleStatus from the worker record.
 * - structured_predicate: apply JSON Pointer operator to structuredOutput.
 *
 * Returns a ConditionResult describing whether the condition is met and why.
 */
export function evaluateExitCondition(opts: {
  exitCondition: LoopExitCondition;
  workerId: string;
  iteration: number;
  verificationEvidence: unknown;
  structuredOutput: unknown;
  prLifecycleStatus: string | null | undefined;
  prNumber: number | null | undefined;
}): ConditionResult {
  const { exitCondition, workerId, iteration } = opts;

  if (exitCondition.type === 'command') {
    return evaluateCommand(opts.verificationEvidence, workerId, iteration);
  }

  if (exitCondition.type === 'pr_checks_green') {
    return evaluatePrChecksGreen(opts.prLifecycleStatus, opts.prNumber);
  }

  return evaluateStructuredPredicate(exitCondition, opts.structuredOutput);
}

function evaluateCommand(
  verificationEvidence: unknown,
  workerId: string,
  iteration: number,
): ConditionResult {
  if (!verificationEvidence || typeof verificationEvidence !== 'object' || Array.isArray(verificationEvidence)) {
    return { satisfied: false, summary: 'No verification evidence provided by runner' };
  }
  const ev = verificationEvidence as Record<string, unknown>;

  // Reject mismatched binding — evidence must be bound to this exact workerId and iteration.
  if (ev.workerId !== workerId) {
    return {
      satisfied: false,
      summary: `Verification evidence workerId mismatch (expected ${workerId}, got ${String(ev.workerId)})`,
    };
  }
  if (typeof ev.iteration !== 'number' || ev.iteration !== iteration) {
    return {
      satisfied: false,
      summary: `Verification evidence iteration mismatch (expected ${iteration}, got ${String(ev.iteration)})`,
    };
  }

  const satisfied = ev.outcome === 'ok';
  return {
    satisfied,
    summary: satisfied
      ? 'Command exited 0'
      : `Command failed (exit code ${ev.exitCode ?? '?'}, outcome: ${String(ev.outcome)})`,
    evidence: ev,
  };
}

function evaluatePrChecksGreen(
  prLifecycleStatus: string | null | undefined,
  prNumber: number | null | undefined,
): ConditionResult {
  if (!prNumber || !prLifecycleStatus) {
    return { satisfied: false, summary: 'No PR or lifecycle status available' };
  }
  // ci_green: all check suites passed (set by webhook when check_suite.conclusion=success).
  // merged: PR was merged (CI was green before merge).
  const satisfied = prLifecycleStatus === 'ci_green' || prLifecycleStatus === 'merged';
  return {
    satisfied,
    summary: satisfied
      ? `PR #${prNumber} checks green (${prLifecycleStatus})`
      : `PR #${prNumber} not green: ${prLifecycleStatus}`,
  };
}

/**
 * Resolve a JSON Pointer (RFC 6901) into a plain-object value.
 * Returns undefined for missing paths or non-object traversal.
 */
function resolveJsonPointer(obj: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return obj;
  const parts = pointer
    .replace(/^\//, '')
    .split('/')
    .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateStructuredPredicate(
  exitCondition: LoopExitCondition & { type: 'structured_predicate' },
  structuredOutput: unknown,
): ConditionResult {
  const predicate = exitCondition.predicate;
  if (!predicate) {
    return { satisfied: false, summary: 'No predicate defined in exitCondition' };
  }

  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
    return { satisfied: false, summary: 'No structuredOutput in completion payload' };
  }

  const actualValue = resolveJsonPointer(structuredOutput, predicate.path);

  if (predicate.operator === 'exists') {
    const satisfied = actualValue !== undefined && actualValue !== null;
    return {
      satisfied,
      summary: `${predicate.path} ${satisfied ? 'exists' : 'does not exist'}`,
    };
  }

  if (predicate.operator === 'neq') {
    const expected = predicate.value;
    const satisfied = actualValue !== expected;
    return {
      satisfied,
      summary: satisfied
        ? `${predicate.path} != ${String(expected)} ✓`
        : `${predicate.path} == ${String(expected)} (expected neq) ✗`,
    };
  }

  if (actualValue === undefined || actualValue === null) {
    return { satisfied: false, summary: `${predicate.path} is absent or null` };
  }

  const expected = predicate.value;
  let satisfied = false;
  switch (predicate.operator) {
    case 'eq':
      satisfied = actualValue === expected;
      break;
    case 'gt':
      satisfied = typeof actualValue === 'number' && typeof expected === 'number' && actualValue > expected;
      break;
    case 'gte':
      satisfied = typeof actualValue === 'number' && typeof expected === 'number' && actualValue >= expected;
      break;
    case 'lt':
      satisfied = typeof actualValue === 'number' && typeof expected === 'number' && actualValue < expected;
      break;
    case 'lte':
      satisfied = typeof actualValue === 'number' && typeof expected === 'number' && actualValue <= expected;
      break;
    default:
      satisfied = false;
  }

  return {
    satisfied,
    summary: satisfied
      ? `${predicate.path} ${predicate.operator} ${String(expected)} ✓`
      : `${predicate.path} ${predicate.operator} ${String(expected)} ✗ (actual: ${String(actualValue)})`,
  };
}

/**
 * Compute the effective startAt for a requeued loop iteration.
 *
 * Per spec §4: "effective startAt = max(existing future startAt, loopFloor, budget reset floor)"
 * Budget floor is the existing task.startAt (already reflects budget_limited requeue).
 * Loop backoff floor = evaluatedAt + backoffMinutes.
 * Later wins: neither clears nor shortens the other.
 */
export function computeLoopStartAt(
  existingStartAt: Date | null | undefined,
  backoffMinutes: number,
  evaluatedAt: Date = new Date(),
): Date | null {
  const backoffMs = backoffMinutes * 60 * 1000;
  const loopFloor = backoffMs > 0 ? new Date(evaluatedAt.getTime() + backoffMs) : null;
  return laterStartAt(existingStartAt ?? null, loopFloor);
}

/**
 * Result of dispatching a loop iteration from the completion route.
 *
 * - satisfied: normal completion continues; add loopState/iteration to task.
 * - requeue: task set to pending; do not run release/dependency steps.
 * - exhausted: task set to failed; run dependency cascade.
 */
export type LoopDispatchResult =
  | { kind: 'satisfied'; loopIteration: number; loopHistory: LoopHistoryEntry[] }
  | {
      kind: 'requeue';
      loopIteration: number;
      loopState: LoopState;
      loopHistory: LoopHistoryEntry[];
      effectiveStartAt: Date | null;
      failureContext: Record<string, unknown>;
      resumeBranch: string | null;
      lastCommitSha: string | null;
    }
  | {
      kind: 'exhausted';
      loopIteration: number;
      loopState: LoopState;
      loopHistory: LoopHistoryEntry[];
    };

/**
 * Evaluate a loop exit condition and return the dispatch result.
 * Called ONLY from the completion route; never from cleanup or webhooks.
 *
 * The caller is responsible for writing the returned state to the DB.
 */
export function dispatchLoopIteration(opts: {
  loopConfig: LoopConfig;
  currentIteration: number;
  existingHistory: LoopHistoryEntry[];
  existingStartAt: Date | null | undefined;
  workerId: string;
  workerBranch: string | null;
  workerLastCommitSha: string | null;
  verificationEvidence: unknown;
  structuredOutput: unknown;
  prLifecycleStatus: string | null | undefined;
  prNumber: number | null | undefined;
  evaluatedAt?: Date;
}): LoopDispatchResult {
  const {
    loopConfig,
    currentIteration,
    existingHistory,
    existingStartAt,
    workerId,
    workerBranch,
    workerLastCommitSha,
    evaluatedAt = new Date(),
  } = opts;

  const maxLoops = loopConfig.maxLoops ?? LOOP_MAX_LOOPS_DEFAULT;
  const backoffMinutes = loopConfig.backoffMinutes ?? LOOP_BACKOFF_MINUTES_DEFAULT;

  const conditionResult = evaluateExitCondition({
    exitCondition: loopConfig.exitCondition,
    workerId,
    iteration: currentIteration,
    verificationEvidence: opts.verificationEvidence,
    structuredOutput: opts.structuredOutput,
    prLifecycleStatus: opts.prLifecycleStatus,
    prNumber: opts.prNumber,
  });

  const historyEntry: LoopHistoryEntry = {
    iteration: currentIteration,
    workerId,
    evaluatedAt: evaluatedAt.toISOString(),
    conditionType: loopConfig.exitCondition.type,
    satisfied: conditionResult.satisfied,
    summary: conditionResult.summary,
    ...(conditionResult.evidence ? { evidence: conditionResult.evidence } : {}),
  };

  const newIteration = currentIteration + 1;
  // Bound history to maxLoops entries
  const newHistory = [...existingHistory, historyEntry].slice(-maxLoops);

  if (conditionResult.satisfied) {
    return { kind: 'satisfied', loopIteration: newIteration, loopHistory: newHistory };
  }

  if (newIteration >= maxLoops) {
    return {
      kind: 'exhausted',
      loopIteration: newIteration,
      loopState: 'exhausted',
      loopHistory: newHistory,
    };
  }

  const effectiveStartAt = computeLoopStartAt(existingStartAt, backoffMinutes, evaluatedAt);

  const failureContext: Record<string, unknown> = {
    conditionType: loopConfig.exitCondition.type,
    summary: conditionResult.summary,
    iteration: currentIteration,
    workerId,
    ...(workerBranch ? { branch: workerBranch } : {}),
    ...(workerLastCommitSha ? { commitSha: workerLastCommitSha } : {}),
    ...(conditionResult.evidence ? { evidence: conditionResult.evidence } : {}),
  };

  return {
    kind: 'requeue',
    loopIteration: newIteration,
    loopState: 'condition_unmet',
    loopHistory: newHistory,
    effectiveStartAt,
    failureContext,
    resumeBranch: workerBranch,
    lastCommitSha: workerLastCommitSha,
  };
}
