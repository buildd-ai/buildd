import { describe, test, expect } from 'bun:test';
import { hasVisibleWorkerChange, type WorkerProgressSnapshot } from './pusher';

describe('hasVisibleWorkerChange', () => {
  const base: WorkerProgressSnapshot = { status: 'running', currentAction: 'Building feature' };

  test('returns false for identical state and no taskProgress', () => {
    expect(hasVisibleWorkerChange(base, { ...base }, null)).toBe(false);
    expect(hasVisibleWorkerChange(base, { ...base }, undefined)).toBe(false);
    expect(hasVisibleWorkerChange(base, { ...base }, [])).toBe(false);
  });

  test('returns true when status changes', () => {
    expect(hasVisibleWorkerChange(base, { status: 'waiting_input', currentAction: base.currentAction }, null)).toBe(true);
  });

  test('returns true when currentAction changes', () => {
    expect(hasVisibleWorkerChange(base, { status: base.status, currentAction: 'Running tests' }, null)).toBe(true);
  });

  test('returns true when taskProgress is present', () => {
    expect(hasVisibleWorkerChange(base, { ...base }, [{ step: 1, label: 'Subagent' }])).toBe(true);
  });

  test('treats null and undefined currentAction as equivalent (no spurious diff)', () => {
    const prev: WorkerProgressSnapshot = { status: 'running', currentAction: null };
    const next: WorkerProgressSnapshot = { status: 'running', currentAction: undefined };
    expect(hasVisibleWorkerChange(prev, next, null)).toBe(false);
    expect(hasVisibleWorkerChange(next, prev, null)).toBe(false);
  });

  test('returns true when currentAction goes from null to a string', () => {
    const prev: WorkerProgressSnapshot = { status: 'running', currentAction: null };
    const next: WorkerProgressSnapshot = { status: 'running', currentAction: 'Working on it' };
    expect(hasVisibleWorkerChange(prev, next, null)).toBe(true);
  });

  test('returns true when currentAction goes from a string to null', () => {
    const prev: WorkerProgressSnapshot = { status: 'running', currentAction: 'Working on it' };
    const next: WorkerProgressSnapshot = { status: 'running', currentAction: null };
    expect(hasVisibleWorkerChange(prev, next, null)).toBe(true);
  });

  test('returns false when both status and currentAction are undefined', () => {
    const prev: WorkerProgressSnapshot = { status: undefined, currentAction: undefined };
    const next: WorkerProgressSnapshot = { status: undefined, currentAction: undefined };
    expect(hasVisibleWorkerChange(prev, next, null)).toBe(false);
  });
});
