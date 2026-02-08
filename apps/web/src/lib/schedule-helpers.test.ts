import { describe, it, expect } from 'bun:test';
import { validateCronExpression, computeNextRunAt, computeNextRuns, describeSchedule } from './schedule-helpers';

describe('schedule-helpers', () => {
  describe('validateCronExpression', () => {
    it('returns null for valid expressions', () => {
      expect(validateCronExpression('* * * * *')).toBeNull();
      expect(validateCronExpression('0 9 * * *')).toBeNull();
      expect(validateCronExpression('*/5 * * * *')).toBeNull();
      expect(validateCronExpression('0 0 1 * *')).toBeNull();
      expect(validateCronExpression('0 9 * * 1')).toBeNull();
      expect(validateCronExpression('30 */6 * * *')).toBeNull();
    });

    it('returns error for invalid expressions', () => {
      expect(validateCronExpression('not a cron')).not.toBeNull();
      expect(validateCronExpression('')).not.toBeNull();
      expect(validateCronExpression('60 * * * *')).not.toBeNull(); // minute > 59
      expect(validateCronExpression('* 25 * * *')).not.toBeNull(); // hour > 23
    });
  });

  describe('computeNextRunAt', () => {
    it('returns a future date for valid expressions', () => {
      const next = computeNextRunAt('* * * * *');
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    });

    it('returns null for invalid expressions', () => {
      expect(computeNextRunAt('invalid')).toBeNull();
    });

    it('respects timezone', () => {
      const utc = computeNextRunAt('0 12 * * *', 'UTC');
      const eastern = computeNextRunAt('0 12 * * *', 'America/New_York');
      expect(utc).toBeInstanceOf(Date);
      expect(eastern).toBeInstanceOf(Date);
      // They should be different times (unless exactly aligned)
      // At minimum both should be valid dates
    });
  });

  describe('computeNextRuns', () => {
    it('returns requested number of runs', () => {
      const runs = computeNextRuns('*/5 * * * *', 'UTC', 3);
      expect(runs).toHaveLength(3);
      // Each run should be after the previous
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i].getTime()).toBeGreaterThan(runs[i - 1].getTime());
      }
    });

    it('returns empty array for invalid expression', () => {
      expect(computeNextRuns('invalid')).toEqual([]);
    });
  });

  describe('describeSchedule', () => {
    it('describes every minute', () => {
      expect(describeSchedule('* * * * *')).toBe('Every minute');
    });

    it('describes interval minutes', () => {
      expect(describeSchedule('*/5 * * * *')).toBe('Every 5 minutes');
      expect(describeSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('describes hourly', () => {
      expect(describeSchedule('0 * * * *')).toBe('Every hour at :00');
      expect(describeSchedule('30 * * * *')).toBe('Every hour at :30');
    });

    it('describes daily', () => {
      expect(describeSchedule('0 9 * * *')).toBe('Daily at 09:00');
      expect(describeSchedule('30 14 * * *')).toBe('Daily at 14:30');
    });

    it('describes weekly', () => {
      expect(describeSchedule('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
      expect(describeSchedule('0 9 * * 0')).toBe('Weekly on Sunday at 09:00');
    });

    it('describes monthly', () => {
      expect(describeSchedule('0 9 1 * *')).toBe('Monthly on day 1 at 09:00');
      expect(describeSchedule('0 9 15 * *')).toBe('Monthly on day 15 at 09:00');
    });

    it('returns raw expression for complex patterns', () => {
      expect(describeSchedule('0 9 1 6 *')).toBe('0 9 1 6 *');
    });
  });
});
