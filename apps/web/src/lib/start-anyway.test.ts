import { describe, it, expect } from 'bun:test';
import { startAnywayView, startAnywayAdmits, lastStartAnyway } from './start-anyway';

// Start anyway (spec 36df686b R-12, AC-16): one derivation of the observed phase
// from the task row's own facts, for the task page, sheet, Queue, explain and runner views.
const NOW = new Date('2026-10-24T12:00:00Z');
const future = new Date(NOW.getTime() + 3_600_000).toISOString();
const intent = { id: 'f1', at: '2026-10-24T11:00:00Z', kinds: ['dep_declared'], loopKeys: [], assessDependsOn: ['up-1'], expiresAt: future, reasonsDigest: 'abc', blockers: [], userId: 'u1', accountId: null };
const consumed = { ...intent, claimedAt: '2026-10-24T11:05:00Z', bypassed: [] };

describe('startAnywayView', () => {
  it('is null for a task nobody started anyway', () => {
    expect(startAnywayView({ context: {}, status: 'pending', now: NOW })).toBeNull();
    expect(startAnywayView({ context: { forceStart: { ...intent, assessDependsOn: undefined } }, status: 'pending', now: NOW })).toBeNull();
  });

  it('an accepted, unclaimed request is requested, never running', () => {
    const v = startAnywayView({ context: { forceStart: intent }, status: 'pending', now: NOW })!;
    expect(v.phase).toBe('requested');
    expect(v.label.toLowerCase()).not.toContain('running');
    expect(v.executing).toBe(false);
  });

  it('an expired request is no request', () => {
    expect(startAnywayView({ context: { forceStart: { ...intent, expiresAt: '2026-10-24T11:30:00Z' } }, status: 'pending', now: NOW })).toBeNull();
  });

  it('a claimed task is assessing and counts as executing', () => {
    const v = startAnywayView({ context: { forceStartHistory: [consumed] }, status: 'in_progress', now: NOW })!;
    expect(v.phase).toBe('assessing');
    expect(v.executing).toBe(true);
  });

  it('after the wait exit it is blocked on the named prerequisite with its next step, and holds no slot', () => {
    const v = startAnywayView({
      context: { forceStartHistory: [consumed], waitExit: { blockerTaskId: 'up-1', reason: 'Needs the new API', at: '2026-10-24T11:30:00Z' } },
      status: 'pending', now: NOW, prerequisiteTitle: 'Upstream task',
    })!;
    expect(v.phase).toBe('blocked');
    expect(v.label).toContain('Upstream task');
    expect(v.label).toContain('Needs the new API');
    expect(v.executing).toBe(false);
    expect(v.taskStatus).toBe('pending');
  });

  it('a wait exit from before this claim is history, not the current state', () => {
    const v = startAnywayView({
      context: { forceStartHistory: [consumed], waitExit: { blockerTaskId: 'up-1', reason: 'old', at: '2026-10-24T10:00:00Z' } },
      status: 'in_progress', now: NOW,
    })!;
    expect(v.phase).toBe('assessing');
  });

  it('a finished task has no live phase', () => {
    expect(startAnywayView({ context: { forceStartHistory: [consumed] }, status: 'completed', now: NOW })).toBeNull();
  });
});

describe('startAnywayAdmits / lastStartAnyway', () => {
  it('admits while an unexpired intent names declared edges', () => {
    expect(startAnywayAdmits({ forceStart: intent }, NOW)).toBe(true);
    expect(startAnywayAdmits({ forceStart: { ...intent, expiresAt: '2026-10-24T11:30:00Z' } }, NOW)).toBe(false);
    expect(startAnywayAdmits({}, NOW)).toBe(false);
  });
  it('finds the newest consumed Start anyway', () => {
    expect(lastStartAnyway({ forceStartHistory: [{ ...consumed, assessDependsOn: undefined }, consumed] })?.id).toBe('f1');
    expect(lastStartAnyway({ forceStartHistory: [] })).toBeNull();
  });
});
