import { describe, it, expect } from 'bun:test';
import {
  classifyReportedFailure,
  classifyStaleExit,
  consumesRetryAttempt,
  isBookkeepingExit,
  isConcurrencyConflictError,
  isSilentStartShape,
  NEVER_STARTED_ERROR,
  SILENT_START_ERROR,
  STALE_EXPIRED_ERROR,
} from './worker-exit-taxonomy';

describe('classifyReportedFailure', () => {
  it('prioritises budget over everything else', () => {
    expect(classifyReportedFailure({ budgetLimited: true, sandboxMountGap: true })).toBe('budget_limited');
  });

  it('classifies sandbox mount gaps', () => {
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: true })).toBe('sandbox_mount_gap');
  });

  it('classifies steering-delivery crashes as infra', () => {
    expect(
      classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false, steeringDelivery: true }),
    ).toBe('infra_failure');
  });

  // Regression: a worker killed by a server-side lost-update race is not a code
  // failure. Recording it as one pollutes the taxonomy and burns a retry cap.
  it('classifies a concurrency conflict as infra_failure, not code_failure', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      concurrencyConflict: true,
    });
    expect(cause).toBe('infra_failure');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  // Regression: the sequential-backend deferral ("Deferred: ...") is concurrency
  // control working as designed — the task is re-queued untouched and was never
  // attempted. It used to be detected only AFTER classification had already run,
  // so it fell through to code_failure and was charged a retry attempt.
  it('classifies an unmet precondition as condition_unmet and does not charge a retry', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      conditionUnmet: true,
    });
    expect(cause).toBe('condition_unmet');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  // The new input must not steal precedence from the causes that actually
  // diagnose the failure — a deferral report that also carries a budget,
  // sandbox, steering or concurrency signal is filed under that signal.
  it('keeps budget/sandbox/steering/concurrency ahead of conditionUnmet', () => {
    expect(classifyReportedFailure({
      budgetLimited: true, sandboxMountGap: false, conditionUnmet: true,
    })).toBe('budget_limited');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: true, conditionUnmet: true,
    })).toBe('sandbox_mount_gap');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: false, steeringDelivery: true, conditionUnmet: true,
    })).toBe('infra_failure');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: false, concurrencyConflict: true, conditionUnmet: true,
    })).toBe('infra_failure');
  });

  it('defaults to code_failure', () => {
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false })).toBe('code_failure');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: false, conditionUnmet: false,
    })).toBe('code_failure');
  });

  // Regression for the taxonomy bug: a worker that correctly stopped to ask a
  // human a question must never fall through to code_failure just because
  // classifyReportedFailure had no case for it.
  it('classifies a needs_input report as needs_input, not code_failure, and does not charge a retry', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      needsInput: true,
    });
    expect(cause).toBe('needs_input');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  it('keeps needsInput from stealing precedence from causes that actually diagnose the failure', () => {
    expect(classifyReportedFailure({
      budgetLimited: true, sandboxMountGap: false, needsInput: true,
    })).toBe('budget_limited');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: true, needsInput: true,
    })).toBe('sandbox_mount_gap');
  });
});

describe('isConcurrencyConflictError', () => {
  it('detects the runner fallback string for an unexplained server abort', () => {
    expect(isConcurrencyConflictError('Terminated by server')).toBe(true);
    expect(isConcurrencyConflictError('terminated by server')).toBe(true);
  });

  it('detects the server conflict message', () => {
    expect(isConcurrencyConflictError('Worker state changed concurrently')).toBe(true);
  });

  it('does not match real failures', () => {
    expect(isConcurrencyConflictError('TypeError: undefined is not a function')).toBe(false);
    expect(isConcurrencyConflictError('Interrupted — human takeover')).toBe(false);
    expect(isConcurrencyConflictError(null)).toBe(false);
    expect(isConcurrencyConflictError(undefined)).toBe(false);
  });
});

describe('classifyStaleExit', () => {
  it('books a worker no runner ever started as never_started, not infra_failure', () => {
    const result = classifyStaleExit({ startedAt: null, turns: 0, costUsd: '0.000000' });
    expect(result.exitCause).toBe('never_started');
    expect(result.error).toBe(NEVER_STARTED_ERROR);
    // The old text implied a runner timed out. It never ran.
    expect(result.error).not.toContain('no update for 15+ minutes');
  });

  it('books a started-but-outputless worker as silent_start with diagnosable text', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 2, costUsd: '0.000000' });
    expect(result.exitCause).toBe('silent_start');
    expect(result.error).toBe(SILENT_START_ERROR);
    expect(result.error).toContain('no output');
  });

  it('treats a worker that produced real turns as a plain infra_failure', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 37, costUsd: '0.140000' });
    expect(result.exitCause).toBe('infra_failure');
    expect(result.error).toBe(STALE_EXPIRED_ERROR);
  });

  it('treats a worker that spent money as a plain infra_failure even with few turns', () => {
    const result = classifyStaleExit({ startedAt: new Date(), turns: 1, costUsd: '0.010000' });
    expect(result.exitCause).toBe('infra_failure');
  });

  it('tolerates numeric and null cost/turn shapes', () => {
    expect(classifyStaleExit({ startedAt: new Date(), turns: null, costUsd: null }).exitCause).toBe('silent_start');
    expect(classifyStaleExit({ startedAt: new Date(), turns: 0, costUsd: 0 }).exitCause).toBe('silent_start');
  });

  // Regression: costUsd is never written on the reaper's kill path (only the
  // terminal PATCH prices a worker), so "costUsd === 0" is a tautology that is
  // true for every worker the reaper ever looks at — including ones that spent
  // real tokens on turn 1 or 2. inputTokens/outputTokens DO get live-synced by
  // the runner's periodic progress reports, so they are the signal that actually
  // discriminates "burned tokens" from "dead session".
  it('treats a worker with input tokens but $0 reported cost as infra_failure, not silent_start', () => {
    const result = classifyStaleExit({
      startedAt: new Date(), turns: 1, costUsd: '0.000000', inputTokens: 15000, outputTokens: 0,
    });
    expect(result.exitCause).toBe('infra_failure');
  });

  it('treats a worker with output tokens but $0 reported cost as infra_failure, not silent_start', () => {
    const result = classifyStaleExit({
      startedAt: new Date(), turns: 2, costUsd: '0.000000', inputTokens: 0, outputTokens: 300,
    });
    expect(result.exitCause).toBe('infra_failure');
  });

  it('still classifies as silent_start when tokens are zero or omitted', () => {
    expect(classifyStaleExit({ startedAt: new Date(), turns: 1, costUsd: '0' }).exitCause).toBe('silent_start');
    expect(
      classifyStaleExit({ startedAt: new Date(), turns: 1, costUsd: '0', inputTokens: 0, outputTokens: 0 }).exitCause,
    ).toBe('silent_start');
  });
});

describe('consumesRetryAttempt', () => {
  it('charges code failures and unknown (legacy null) causes', () => {
    expect(consumesRetryAttempt('code_failure')).toBe(true);
    expect(consumesRetryAttempt(null)).toBe(true);
    expect(consumesRetryAttempt(undefined)).toBe(true);
  });

  it('does not charge external-constraint causes', () => {
    expect(consumesRetryAttempt('budget_limited')).toBe(false);
    expect(consumesRetryAttempt('infra_failure')).toBe(false);
    expect(consumesRetryAttempt('sandbox_mount_gap')).toBe(false);
    expect(consumesRetryAttempt('condition_unmet')).toBe(false);
  });

  it('does not charge a worker that was never started or never produced output', () => {
    expect(consumesRetryAttempt('never_started')).toBe(false);
    expect(consumesRetryAttempt('silent_start')).toBe(false);
  });
});

// Regression for the fault-classification bug: the coordination server refusing
// a runner's PATCH (a 4xx) is a decision WE made, not an exception the session
// suffered. Until the runner could report it, the refusal unwound to the
// runner's crash handler, arrived back as a `failed` PATCH whose error was the
// stringified 4xx body, and landed on this function's code_failure default —
// charging the task a retry it never earned.
describe('server refusals', () => {
  it('classifies an output-gate refusal as output_unmet, and STILL charges the retry', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      serverRefused: true,
      outputGateRefused: true,
    });
    expect(cause).toBe('output_unmet');
    // Deliberate: this refusal only reaches the runner for a session that ended
    // without calling complete_task and shipped nothing reviewable. A fresh
    // attempt can plausibly open the PR, so the attempt is chargeable — it is
    // just not a code defect.
    expect(consumesRetryAttempt(cause)).toBe(true);
  });

  it('classifies a non-gate refusal as server_refused, and does NOT charge the retry', () => {
    const cause = classifyReportedFailure({
      budgetLimited: false,
      sandboxMountGap: false,
      serverRefused: true,
    });
    expect(cause).toBe('server_refused');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  it('keeps a refusal report from stealing precedence from a real diagnosis', () => {
    // Same rule the file already applies to conditionUnmet/needsInput: the
    // diagnosis beats the bookkeeping.
    expect(classifyReportedFailure({
      budgetLimited: true, sandboxMountGap: false, serverRefused: true, outputGateRefused: true,
    })).toBe('budget_limited');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: true, serverRefused: true,
    })).toBe('sandbox_mount_gap');
    expect(classifyReportedFailure({
      budgetLimited: false, sandboxMountGap: false, steeringDelivery: true, serverRefused: true,
    })).toBe('infra_failure');
  });

  it('does not blanket-exempt every refusal — only the non-gate ones', () => {
    // The whole point of two causes rather than one: exempting all 4xx would
    // launder a session that genuinely shipped nothing.
    expect(consumesRetryAttempt('server_refused')).toBe(false);
    expect(consumesRetryAttempt('output_unmet')).toBe(true);
  });
});

describe('crash-reconciled restarts', () => {
  it('books a runner restart as infra_failure, which does not consume a retry', () => {
    // The runner PATCHes every mid-session worker {failed, 'Process restarted',
    // crashReconciled:true} on boot — a self-update, not the work failing.
    const cause = classifyReportedFailure({ budgetLimited: false, sandboxMountGap: false, crashReconciled: true });
    expect(cause).toBe('infra_failure');
    expect(consumesRetryAttempt(cause)).toBe(false);
  });

  it('still lets budget and sandbox diagnoses win over a crash reconcile', () => {
    expect(classifyReportedFailure({ budgetLimited: true, sandboxMountGap: false, crashReconciled: true })).toBe('budget_limited');
    expect(classifyReportedFailure({ budgetLimited: false, sandboxMountGap: true, crashReconciled: true })).toBe('sandbox_mount_gap');
  });
});

describe('isBookkeepingExit', () => {
  it('is true only for exits the taxonomy itself calls bookkeeping', () => {
    expect(isBookkeepingExit('needs_input')).toBe(true);
    expect(isBookkeepingExit('never_started')).toBe(true);
    expect(isBookkeepingExit('condition_unmet')).toBe(true);
  });

  it('keeps infra_failure and silent_start visible as failures', () => {
    for (const cause of ['code_failure', 'infra_failure', 'silent_start', 'budget_limited', 'server_refused', 'output_unmet'] as const) {
      expect(isBookkeepingExit(cause)).toBe(false);
    }
    expect(isBookkeepingExit(null)).toBe(false);
    expect(isBookkeepingExit(undefined)).toBe(false);
  });
});

describe('isSilentStartShape', () => {
  const cases = [
    { turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    { turns: 2, costUsd: '0', inputTokens: null, outputTokens: null },
    { turns: 3, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    { turns: 1, costUsd: 0, inputTokens: 120, outputTokens: 0 },
    { turns: 1, costUsd: 0, inputTokens: 0, outputTokens: 5 },
    { turns: 1, costUsd: 0.02, inputTokens: 0, outputTokens: 0 },
    { turns: null, costUsd: null, inputTokens: null, outputTokens: null },
    { turns: 0, costUsd: 'not-a-number', inputTokens: 0, outputTokens: 0 },
  ];

  it('matches classifyStaleExit on every started worker shape', () => {
    for (const c of cases) {
      const stale = classifyStaleExit({ startedAt: new Date(), ...c });
      expect(isSilentStartShape(c)).toBe(stale.exitCause === 'silent_start');
    }
  });

  it('is true for a zero-output session and false once any work shows up', () => {
    expect(isSilentStartShape({ turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 })).toBe(true);
    expect(isSilentStartShape({ turns: 1, costUsd: 0, inputTokens: 900, outputTokens: 40 })).toBe(false);
  });
});
