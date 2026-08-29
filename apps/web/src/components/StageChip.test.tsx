import { describe, it, expect } from 'bun:test';
import { deriveStage } from './StageChip';

/**
 * deriveStage is the single source of truth for the row chip. These tests pin
 * the SUBJECT_DEAD stage: a task the subject-liveness claim gate excludes can
 * never be picked up, so it must never render as QUEUED — that identical-to-
 * healthy row is what hid a 5-day, 20-task stall.
 */
describe('deriveStage — SUBJECT_DEAD', () => {
  it('a pending subject-dead task is SUBJECT_DEAD, not QUEUED', () => {
    expect(deriveStage({ taskStatus: 'pending', isSubjectDead: true })).toBe('SUBJECT_DEAD');
  });

  it('SUBJECT_DEAD outranks BLOCKED (a blocked task can still clear on its own)', () => {
    expect(deriveStage({ taskStatus: 'pending', isSubjectDead: true, isBlocked: true })).toBe('SUBJECT_DEAD');
  });

  it('an assigned subject-dead task is SUBJECT_DEAD, not QUEUED', () => {
    expect(deriveStage({ taskStatus: 'assigned', isSubjectDead: true })).toBe('SUBJECT_DEAD');
  });

  it('a live worker outranks SUBJECT_DEAD — work in flight is real', () => {
    expect(deriveStage({ taskStatus: 'pending', isSubjectDead: true, workerStatus: 'running' })).toBe('RUNNING');
  });

  it('terminal statuses are unaffected', () => {
    expect(deriveStage({ taskStatus: 'failed', isSubjectDead: true })).toBe('FAILED');
    expect(deriveStage({ taskStatus: 'cancelled', isSubjectDead: true })).toBe('CANCELLED');
    expect(deriveStage({ taskStatus: 'completed', isSubjectDead: true })).toBe('DONE');
  });

  it('without the flag the existing behavior is unchanged', () => {
    expect(deriveStage({ taskStatus: 'pending' })).toBe('QUEUED');
    expect(deriveStage({ taskStatus: 'pending', isBlocked: true })).toBe('BLOCKED');
  });
});

/**
 * MISSION_BUDGET: the mission's cost budget is exhausted, so the claim loop
 * skips this task (and every sibling) until a human raises the budget. Same
 * class of failure as SUBJECT_DEAD — unclaimable, but rendered as QUEUED.
 */
describe('deriveStage — MISSION_BUDGET', () => {
  it('a pending task in a budget-exhausted mission is MISSION_BUDGET, not QUEUED', () => {
    expect(deriveStage({ taskStatus: 'pending', isMissionBudgetExhausted: true })).toBe('MISSION_BUDGET');
  });

  it('MISSION_BUDGET outranks BLOCKED', () => {
    expect(deriveStage({ taskStatus: 'pending', isMissionBudgetExhausted: true, isBlocked: true }))
      .toBe('MISSION_BUDGET');
  });

  it('SUBJECT_DEAD outranks MISSION_BUDGET', () => {
    expect(deriveStage({ taskStatus: 'pending', isSubjectDead: true, isMissionBudgetExhausted: true }))
      .toBe('SUBJECT_DEAD');
  });

  it('a live worker outranks MISSION_BUDGET', () => {
    expect(deriveStage({ taskStatus: 'pending', isMissionBudgetExhausted: true, workerStatus: 'running' }))
      .toBe('RUNNING');
  });

  it('terminal statuses are unaffected', () => {
    expect(deriveStage({ taskStatus: 'completed', isMissionBudgetExhausted: true })).toBe('DONE');
    expect(deriveStage({ taskStatus: 'cancelled', isMissionBudgetExhausted: true })).toBe('CANCELLED');
  });
});
