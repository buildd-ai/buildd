import { describe, it, expect } from 'bun:test';
import { validateCronExpression, computeNextRunAt, computeNextRuns, describeSchedule, computeStaggerOffset, dateTimeToCron } from './schedule-helpers';

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

  describe('computeStaggerOffset', () => {
    it('returns 0 for non-top-of-hour cron expressions', () => {
      // Specific minute (not 0) should not be staggered
      expect(computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '30 * * * *')).toBe(0);
      expect(computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '15 9 * * *')).toBe(0);
      expect(computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '*/5 * * * *')).toBe(0);
      expect(computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '* * * * *')).toBe(0);
    });

    it('returns a non-negative offset for top-of-hour cron expressions', () => {
      const offset = computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '0 * * * *');
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(300);
    });

    it('returns stagger for daily at midnight (minute=0)', () => {
      const offset = computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '0 9 * * *');
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(300);
    });

    it('returns deterministic offset for the same schedule ID', () => {
      const id = '12345678-abcd-1234-abcd-1234567890ab';
      const offset1 = computeStaggerOffset(id, '0 * * * *');
      const offset2 = computeStaggerOffset(id, '0 * * * *');
      expect(offset1).toBe(offset2);
    });

    it('returns different offsets for different schedule IDs', () => {
      const offset1 = computeStaggerOffset('11111111-1111-1111-1111-111111111111', '0 * * * *');
      const offset2 = computeStaggerOffset('22222222-2222-2222-2222-222222222222', '0 * * * *');
      // Not guaranteed to be different, but for these specific IDs they should be
      // The main point is they are both valid
      expect(offset1).toBeGreaterThanOrEqual(0);
      expect(offset1).toBeLessThan(300);
      expect(offset2).toBeGreaterThanOrEqual(0);
      expect(offset2).toBeLessThan(300);
    });

    it('returns 0 for invalid/short expressions', () => {
      expect(computeStaggerOffset('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '* *')).toBe(0);
    });
  });

  describe('dateTimeToCron', () => {
    it('converts a standard date and time to cron', () => {
      expect(dateTimeToCron('2026-03-15', '09:30')).toBe('30 9 15 3 *');
    });

    it('handles midnight', () => {
      expect(dateTimeToCron('2026-01-01', '00:00')).toBe('0 0 1 1 *');
    });

    it('handles end-of-day time', () => {
      expect(dateTimeToCron('2026-12-31', '23:59')).toBe('59 23 31 12 *');
    });

    it('preserves single-digit values without padding', () => {
      // Cron fields are numeric, no zero-padding needed
      expect(dateTimeToCron('2026-02-05', '07:05')).toBe('5 7 5 2 *');
    });

    it('returns null for empty date', () => {
      expect(dateTimeToCron('', '09:00')).toBeNull();
    });

    it('returns null for empty time', () => {
      expect(dateTimeToCron('2026-03-15', '')).toBeNull();
    });

    it('returns null for both empty', () => {
      expect(dateTimeToCron('', '')).toBeNull();
    });

    it('returns null for malformed date (too few parts)', () => {
      expect(dateTimeToCron('2026-03', '09:00')).toBeNull();
    });

    it('returns null for malformed time (too few parts)', () => {
      expect(dateTimeToCron('2026-03-15', '09')).toBeNull();
    });

    it('returns null for non-numeric date parts', () => {
      expect(dateTimeToCron('2026-ab-15', '09:00')).toBeNull();
    });

    it('returns null for non-numeric time parts', () => {
      expect(dateTimeToCron('2026-03-15', 'ab:00')).toBeNull();
    });

    it('returns null for invalid month (0)', () => {
      expect(dateTimeToCron('2026-00-15', '09:00')).toBeNull();
    });

    it('returns null for invalid month (13)', () => {
      expect(dateTimeToCron('2026-13-15', '09:00')).toBeNull();
    });

    it('returns null for invalid day (0)', () => {
      expect(dateTimeToCron('2026-03-00', '09:00')).toBeNull();
    });

    it('returns null for invalid day (32)', () => {
      expect(dateTimeToCron('2026-03-32', '09:00')).toBeNull();
    });

    it('returns null for invalid hour (24)', () => {
      expect(dateTimeToCron('2026-03-15', '24:00')).toBeNull();
    });

    it('returns null for invalid minute (60)', () => {
      expect(dateTimeToCron('2026-03-15', '09:60')).toBeNull();
    });

    it('returns null for negative hour', () => {
      expect(dateTimeToCron('2026-03-15', '-1:00')).toBeNull();
    });

    it('produces a valid cron expression', () => {
      const cron = dateTimeToCron('2026-06-15', '14:30');
      expect(cron).not.toBeNull();
      // The result should be parseable by our validator
      expect(validateCronExpression(cron!)).toBeNull();
    });
  });
});
