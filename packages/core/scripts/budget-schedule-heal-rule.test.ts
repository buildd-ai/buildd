import { describe, it, expect } from 'bun:test';
import {
  RESUME_STAGGER_MINUTES,
  disableIsConsistentWithBudgetBug,
  staggeredResumeAt,
} from './budget-schedule-heal-rule';

/**
 * The predicate that decides whether a disabled schedule gets re-enabled.
 *
 * Getting this wrong in the permissive direction resumes work a human
 * deliberately stopped, so every "no" case is asserted, including the
 * missing-timestamp ones.
 */
describe('disableIsConsistentWithBudgetBug', () => {
  const exhausted = new Date('2026-08-01T00:00:00.000Z');

  it('accepts a disable after the exhaustion note', () => {
    expect(disableIsConsistentWithBudgetBug(new Date('2026-08-01T00:05:00.000Z'), exhausted)).toBe(true);
  });

  // The cron tick that disables can land in the same second as the note.
  it('accepts a disable in the same instant as the exhaustion', () => {
    expect(disableIsConsistentWithBudgetBug(new Date(exhausted), exhausted)).toBe(true);
  });

  // The case that protects a human decision: this schedule was already off
  // before the mission ever ran out of budget, so the bug did not disable it.
  it('rejects a disable that predates the exhaustion note', () => {
    expect(disableIsConsistentWithBudgetBug(new Date('2026-07-31T23:59:00.000Z'), exhausted)).toBe(false);
  });

  it('rejects a missing schedule timestamp rather than assuming innocence', () => {
    expect(disableIsConsistentWithBudgetBug(null, exhausted)).toBe(false);
    expect(disableIsConsistentWithBudgetBug(undefined, exhausted)).toBe(false);
  });

  it('rejects a missing exhaustion timestamp', () => {
    expect(disableIsConsistentWithBudgetBug(new Date(), null)).toBe(false);
    expect(disableIsConsistentWithBudgetBug(new Date(), undefined)).toBe(false);
  });

  it('rejects when both timestamps are missing', () => {
    expect(disableIsConsistentWithBudgetBug(null, null)).toBe(false);
  });
});

describe('staggeredResumeAt', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');

  // The first heal must be due immediately, so the operator sees it resume on
  // the next tick rather than waiting out a stagger interval.
  it('makes the first schedule due right away', () => {
    expect(staggeredResumeAt(now, 0).toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });

  it('spaces each subsequent schedule by the stagger interval', () => {
    expect(staggeredResumeAt(now, 1).toISOString()).toBe('2026-09-04T12:05:00.000Z');
    expect(staggeredResumeAt(now, 3).toISOString()).toBe('2026-09-04T12:15:00.000Z');
  });

  it('derives the spacing from RESUME_STAGGER_MINUTES', () => {
    const delta = staggeredResumeAt(now, 1).getTime() - staggeredResumeAt(now, 0).getTime();
    expect(delta).toBe(RESUME_STAGGER_MINUTES * 60_000);
  });

  it('never schedules a resume in the past', () => {
    for (const i of [0, 1, 10]) {
      expect(staggeredResumeAt(now, i).getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });
});
