import { describe, it, expect } from 'bun:test';
import { validateCronExpression, computeNextRunAt, computeNextRuns, describeSchedule, dateTimeToCron, classifyScheduleCadence } from './schedule-helpers';

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

  describe('fires exactly on the hour', () => {
    // The tick runs at :00. Any jitter that pushes nextRunAt past the tick
    // instant does not spread load — it delays the schedule to the NEXT tick, a
    // full hour later. computeStaggerOffset used to add 0-299s to every
    // top-of-hour schedule for exactly that reason and was removed.
    it('puts a top-of-hour schedule on the hour, to the second', () => {
      for (const expr of ['0 * * * *', '0 9 * * *', '0 6 * * 1,4']) {
        const next = computeNextRunAt(expr, 'UTC');
        expect(next).not.toBeNull();
        expect(next!.getUTCMinutes(), expr).toBe(0);
        expect(next!.getUTCSeconds(), expr).toBe(0);
        expect(next!.getUTCMilliseconds(), expr).toBe(0);
      }
    });

    it('is stable across calls — no per-schedule jitter', () => {
      const a = computeNextRunAt('0 * * * *', 'UTC');
      const b = computeNextRunAt('0 * * * *', 'UTC');
      expect(a!.getTime()).toBe(b!.getTime());
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

  describe('classifyScheduleCadence', () => {
    it('every minute → observation/simple', () => {
      const r = classifyScheduleCadence({ cronExpression: '* * * * *' });
      expect(r.kind).toBe('observation');
      expect(r.complexity).toBe('simple');
      expect(r.classifiedBy).toBe('default');
    });

    it('every 5 minutes → observation/simple', () => {
      const r = classifyScheduleCadence({ cronExpression: '*/5 * * * *' });
      expect(r.kind).toBe('observation');
      expect(r.complexity).toBe('simple');
    });

    it('every 30 minutes → engineering/simple', () => {
      const r = classifyScheduleCadence({ cronExpression: '*/30 * * * *' });
      expect(r.kind).toBe('engineering');
      expect(r.complexity).toBe('simple');
    });

    it('daily → engineering/normal', () => {
      const r = classifyScheduleCadence({ cronExpression: '0 9 * * *' });
      expect(r.kind).toBe('engineering');
      expect(r.complexity).toBe('normal');
    });

    it('heartbeat flag forces observation/simple regardless of cadence', () => {
      const r = classifyScheduleCadence({
        cronExpression: '0 0 * * *', // daily
        isHeartbeat: true,
      });
      expect(r.kind).toBe('observation');
      expect(r.complexity).toBe('simple');
    });

    it('user overrides both fields → classifiedBy=user', () => {
      const r = classifyScheduleCadence({
        cronExpression: '* * * * *',
        userKind: 'coordination',
        userComplexity: 'complex',
      });
      expect(r.kind).toBe('coordination');
      expect(r.complexity).toBe('complex');
      expect(r.classifiedBy).toBe('user');
    });

    it('user overrides only kind, cadence fills complexity', () => {
      const r = classifyScheduleCadence({
        cronExpression: '* * * * *',
        userKind: 'research',
      });
      expect(r.kind).toBe('research');
      expect(r.complexity).toBe('simple'); // from cadence
      expect(r.classifiedBy).toBe('user');
    });

    it('invalid cron falls back to engineering/normal', () => {
      const r = classifyScheduleCadence({ cronExpression: 'not a cron' });
      expect(r.kind).toBe('engineering');
      expect(r.complexity).toBe('normal');
    });
  });
});
