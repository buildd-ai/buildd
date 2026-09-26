import { describe, expect, test } from 'bun:test';
import { scheduleBaseline, SCHEDULE_INTERVAL_MS, type Story } from './story';

const anchor = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('scheduleBaseline', () => {
  test('next run is due when the timeline fires the schedule, last run one interval before', () => {
    const story: Story = { timeline: [{ t: 60, op: 'claim' }, { t: 1260, op: 'schedule_fire', schedule: 'S2' }] };
    const { lastRunAt, nextRunAt } = scheduleBaseline(story, 'S2', anchor);
    expect(nextRunAt.getTime()).toBe(anchor + 1_260_000);
    expect(lastRunAt.getTime()).toBe(anchor + 1_260_000 - SCHEDULE_INTERVAL_MS);
    // Mid-story (t=11:50) it counts down instead of reading "due now".
    expect(nextRunAt.getTime() - (anchor + 710_000)).toBeGreaterThan(0);
  });

  test('uses the first fire of that schedule only', () => {
    const story: Story = {
      timeline: [
        { t: 30, op: 'schedule_fire', schedule: 'OTHER' },
        { t: 400, op: 'schedule_fire', schedule: 'S2' },
        { t: 900, op: 'schedule_fire', schedule: 'S2' },
      ],
    };
    expect(scheduleBaseline(story, 'S2', anchor).nextRunAt.getTime()).toBe(anchor + 400_000);
  });

  test('a schedule the story never fires is due at t=0', () => {
    const { lastRunAt, nextRunAt } = scheduleBaseline({ timeline: [] }, 'S9', anchor, 3_600_000);
    expect(nextRunAt.getTime()).toBe(anchor);
    expect(lastRunAt.getTime()).toBe(anchor - 3_600_000);
  });
});
