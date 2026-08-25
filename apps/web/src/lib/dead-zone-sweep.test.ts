import { describe, it, expect } from 'bun:test';
import {
  classifyDeadZoneAction,
  isDeadZoneCandidate,
  isRedPr,
} from './dead-zone-sweep';

// ── classifyDeadZoneAction ────────────────────────────────────────────────────

describe('classifyDeadZoneAction', () => {
  it('sparks when no retries exist (dirty+terminal+no-worker)', () => {
    expect(classifyDeadZoneAction(0, 0)).toBe('spark');
  });

  it('skips when an active conflict retry is in flight (dirty+active-worker)', () => {
    expect(classifyDeadZoneAction(1, 0)).toBe('skip');
  });

  it('skips when an active conflict retry exists even if completed ones do too (dirty+already-has-open-conflict-task)', () => {
    expect(classifyDeadZoneAction(1, 2)).toBe('skip');
  });

  it('sparks when prior retries exist but cap not yet reached', () => {
    expect(classifyDeadZoneAction(0, 1)).toBe('spark');
    expect(classifyDeadZoneAction(0, 2)).toBe('spark');
  });

  it('exhausts when completed retries reach the cap (retries-exhausted)', () => {
    expect(classifyDeadZoneAction(0, 3)).toBe('exhaust');
    expect(classifyDeadZoneAction(0, 4)).toBe('exhaust');
  });

  it('exhausts when maxIterations is 1 and one retry is done', () => {
    expect(classifyDeadZoneAction(0, 1, 1)).toBe('exhaust');
  });

  it('sparks with a custom maxIterations', () => {
    expect(classifyDeadZoneAction(0, 1, 5)).toBe('spark');
    expect(classifyDeadZoneAction(0, 4, 5)).toBe('spark');
    expect(classifyDeadZoneAction(0, 5, 5)).toBe('exhaust');
  });

  it('skip beats exhaust: active retry takes precedence over cap', () => {
    // Active retry exists AND retries exhausted — still skip, let active run.
    expect(classifyDeadZoneAction(1, 3)).toBe('skip');
  });
});

// ── isDeadZoneCandidate ───────────────────────────────────────────────────────

describe('isDeadZoneCandidate', () => {
  const openPr = 'https://github.com/org/repo/pull/42';

  it('returns true for a terminal task with an open PR', () => {
    expect(isDeadZoneCandidate('completed', openPr, null, null)).toBe(true);
    expect(isDeadZoneCandidate('failed', openPr, null, null)).toBe(true);
    expect(isDeadZoneCandidate('cancelled', openPr, null, null)).toBe(true);
  });

  it('returns true when prLifecycleStatus is already "conflict" (repeat sweep run)', () => {
    expect(isDeadZoneCandidate('completed', openPr, null, 'conflict')).toBe(true);
  });

  it('returns false when task is still active (dirty+active-worker case)', () => {
    expect(isDeadZoneCandidate('in_progress', openPr, null, null)).toBe(false);
    expect(isDeadZoneCandidate('pending', openPr, null, null)).toBe(false);
    expect(isDeadZoneCandidate('assigned', openPr, null, null)).toBe(false);
  });

  it('returns false when there is no PR', () => {
    expect(isDeadZoneCandidate('completed', null, null, null)).toBe(false);
  });

  it('returns false when the PR is already merged', () => {
    expect(isDeadZoneCandidate('completed', openPr, new Date(), null)).toBe(false);
    expect(isDeadZoneCandidate('completed', openPr, null, 'merged')).toBe(false);
  });

  it('returns false when the PR is closed', () => {
    expect(isDeadZoneCandidate('completed', openPr, null, 'closed')).toBe(false);
  });
});

// ── isRedPr ───────────────────────────────────────────────────────────────────

describe('isRedPr', () => {
  const failedRun = { status: 'completed', conclusion: 'failure' };
  const actionRequiredRun = { status: 'completed', conclusion: 'action_required' };
  const timedOutRun = { status: 'completed', conclusion: 'timed_out' };
  const successRun = { status: 'completed', conclusion: 'success' };
  const skippedRun = { status: 'completed', conclusion: 'skipped' };
  const queuedRun = { status: 'queued', conclusion: null };
  const inProgressRun = { status: 'in_progress', conclusion: null };

  it('returns false when mergeable_state is not blocked', () => {
    expect(isRedPr('dirty', [failedRun])).toBe(false);
    expect(isRedPr('clean', [failedRun])).toBe(false);
    expect(isRedPr('unstable', [failedRun])).toBe(false);
    expect(isRedPr(null, [failedRun])).toBe(false);
  });

  it('returns false when checks are pending/queued — not yet green, not failing', () => {
    expect(isRedPr('blocked', [queuedRun])).toBe(false);
    expect(isRedPr('blocked', [inProgressRun])).toBe(false);
    expect(isRedPr('blocked', [queuedRun, inProgressRun])).toBe(false);
  });

  it('returns false when no check runs at all (blocked for another reason)', () => {
    expect(isRedPr('blocked', [])).toBe(false);
  });

  it('returns false when all completed checks passed or were skipped', () => {
    expect(isRedPr('blocked', [successRun])).toBe(false);
    expect(isRedPr('blocked', [skippedRun])).toBe(false);
    expect(isRedPr('blocked', [successRun, skippedRun])).toBe(false);
  });

  it('returns true when blocked and at least one check completed with failure', () => {
    expect(isRedPr('blocked', [failedRun])).toBe(true);
    expect(isRedPr('blocked', [actionRequiredRun])).toBe(true);
    expect(isRedPr('blocked', [timedOutRun])).toBe(true);
  });

  it('returns true when some checks pass but at least one fails', () => {
    expect(isRedPr('blocked', [successRun, failedRun])).toBe(true);
    expect(isRedPr('blocked', [skippedRun, timedOutRun])).toBe(true);
  });

  it('returns false when mergeable_state is dirty even if check runs are failing (dirty wins)', () => {
    // In practice GitHub returns one state, but guard: dirty takes the dirty path.
    expect(isRedPr('dirty', [failedRun])).toBe(false);
  });
});

// ── Red path: end-to-end predicate composition ────────────────────────────────

describe('dead zone red path (CI-failing)', () => {
  const redChecks = [{ status: 'completed', conclusion: 'failure' }];

  it('red + terminal + no active worker → spark (exactly once)', () => {
    expect(isRedPr('blocked', redChecks)).toBe(true);
    expect(classifyDeadZoneAction(0, 0)).toBe('spark');
  });

  it('red + active conflict retry in flight → no spark', () => {
    expect(isRedPr('blocked', redChecks)).toBe(true);
    expect(classifyDeadZoneAction(1, 0)).toBe('skip');
  });

  it('red + already-has-open-conflict-task → no spark', () => {
    expect(isRedPr('blocked', redChecks)).toBe(true);
    expect(classifyDeadZoneAction(1, 2)).toBe('skip');
  });

  it('checks pending/queued → isRedPr false, sweep skips', () => {
    const pendingChecks = [{ status: 'queued', conclusion: null }];
    expect(isRedPr('blocked', pendingChecks)).toBe(false);
  });

  it('red AND dirty simultaneously → isRedPr returns false (dirty path handles it)', () => {
    // GitHub returns one mergeable_state; if dirty, isRedPr is never consulted.
    // Guard: even if both flags were somehow set, dirty path fires first.
    expect(isRedPr('dirty', redChecks)).toBe(false);
    // dirty path via classifyDeadZoneAction:
    expect(classifyDeadZoneAction(0, 0)).toBe('spark');
  });

  it('retries exhausted on the red path → BLOCKED Home card', () => {
    expect(isRedPr('blocked', redChecks)).toBe(true);
    expect(classifyDeadZoneAction(0, 3)).toBe('exhaust');
  });
});

// ── Home card condition ───────────────────────────────────────────────────────

describe('dead zone BLOCKED card condition', () => {
  it('a PR is BLOCKED when: terminal + conflict + no active retry + exhausted', () => {
    // Verify via classifyDeadZoneAction the exhausted path
    const taskStatus = 'completed';
    const prLifecycleStatus = 'conflict';
    const isTerminal = isDeadZoneCandidate(taskStatus, 'https://github.com/o/r/pull/1', null, prLifecycleStatus);
    const activeRetries = 0;
    const completedRetries = 3;
    const action = classifyDeadZoneAction(activeRetries, completedRetries);
    expect(isTerminal).toBe(true);
    expect(action).toBe('exhaust');
    // Combined: should show BLOCKED card
    expect(isTerminal && action === 'exhaust').toBe(true);
  });

  it('a PR is NOT BLOCKED when retries are in flight (renders as RESOLVING)', () => {
    const activeRetries = 1;
    const completedRetries = 2;
    const action = classifyDeadZoneAction(activeRetries, completedRetries);
    expect(action).toBe('skip');
    expect(action === 'exhaust').toBe(false);
  });
});
