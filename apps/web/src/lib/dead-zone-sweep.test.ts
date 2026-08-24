import { describe, it, expect } from 'bun:test';
import {
  classifyDeadZoneAction,
  isDeadZoneCandidate,
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
