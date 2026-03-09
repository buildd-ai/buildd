import { describe, it, expect } from 'bun:test';
import { PRESETS } from './CronPresets';

describe('CronPresets', () => {
  describe('PRESETS', () => {
    it('has expected preset entries', () => {
      expect(PRESETS).toHaveLength(4);
    });

    it('contains valid 5-field cron expressions', () => {
      for (const preset of PRESETS) {
        const parts = preset.cron.split(' ');
        expect(parts).toHaveLength(5);
      }
    });

    it('has "Every hour" preset as 0 * * * *', () => {
      const hourly = PRESETS.find(p => p.label === 'Every hour');
      expect(hourly).toBeDefined();
      expect(hourly!.cron).toBe('0 * * * *');
    });

    it('has "Every 4 hours" preset as 0 */4 * * *', () => {
      const every4h = PRESETS.find(p => p.label === 'Every 4 hours');
      expect(every4h).toBeDefined();
      expect(every4h!.cron).toBe('0 */4 * * *');
    });

    it('has "Daily at 9am" preset as 0 9 * * *', () => {
      const daily = PRESETS.find(p => p.label === 'Daily at 9am');
      expect(daily).toBeDefined();
      expect(daily!.cron).toBe('0 9 * * *');
    });

    it('has "Weekly Monday" preset as 0 9 * * 1', () => {
      const weekly = PRESETS.find(p => p.label === 'Weekly Monday');
      expect(weekly).toBeDefined();
      expect(weekly!.cron).toBe('0 9 * * 1');
    });

    it('has unique cron expressions', () => {
      const crons = PRESETS.map(p => p.cron);
      expect(new Set(crons).size).toBe(crons.length);
    });

    it('has unique labels', () => {
      const labels = PRESETS.map(p => p.label);
      expect(new Set(labels).size).toBe(labels.length);
    });
  });
});
