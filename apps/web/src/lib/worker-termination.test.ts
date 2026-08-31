import { describe, it, expect } from 'bun:test';
import {
  REASSIGNED_WORKER_ERROR,
  NON_REACTIVATABLE_ERROR_PHRASES,
  isNonReactivatableError,
} from './worker-termination';

describe('isNonReactivatableError', () => {
  it('treats a reassignment as non-reactivatable', () => {
    // C4 regression: '/api/tasks/[id]/reassign' fails live workers with this
    // exact string. It matched none of the phrases the PATCH route checked, so
    // a reassigned worker could be resurrected (and answered) after its task
    // had moved on. The phrase is now a shared constant, not prose.
    expect(REASSIGNED_WORKER_ERROR).toBe('Task was reassigned');
    expect(isNonReactivatableError(REASSIGNED_WORKER_ERROR)).toBe(true);
    expect(NON_REACTIVATABLE_ERROR_PHRASES).toContain(REASSIGNED_WORKER_ERROR);
  });

  it('keeps matching every phrase the PATCH route already rejected', () => {
    for (const phrase of [
      'Interrupted — human takeover',
      'Worker expired after 30m without a heartbeat',
      'Session timed out',
      'Runner went offline',
      'Killed because the runner restarted',
    ]) {
      expect(isNonReactivatableError(phrase)).toBe(true);
    }
  });

  it('does not match a clean completion or an ordinary agent failure', () => {
    expect(isNonReactivatableError(null)).toBe(false);
    expect(isNonReactivatableError(undefined)).toBe(false);
    expect(isNonReactivatableError('')).toBe(false);
    expect(isNonReactivatableError('Build failed: tsc exited 2')).toBe(false);
  });
});
