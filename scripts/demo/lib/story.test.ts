import { describe, expect, test } from 'bun:test';
import { claimColumns, relFuture, shiftTimestampsSql, scheduleBaseline, SCHEDULE_INTERVAL_MS, type Story } from './story';

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

  test('a far-future schedule honours _nextRunIn / _lastRunAgo', () => {
    const story: Story = { timeline: [], taskSchedules: [{ key: 'Q', _nextRunIn: '111d', _lastRunAgo: '20d' }] };
    const { lastRunAt, nextRunAt } = scheduleBaseline(story, 'Q', anchor);
    expect(nextRunAt.getTime()).toBe(anchor + 111 * 86_400_000);
    expect(lastRunAt.getTime()).toBe(anchor - 20 * 86_400_000);
  });
});

describe('relFuture', () => {
  test('parses the same units forward from the anchor', () => {
    expect(relFuture(anchor, '90m').getTime()).toBe(anchor + 90 * 60_000);
    expect(relFuture(anchor, '+2h').getTime()).toBe(anchor + 2 * 3_600_000);
    expect(relFuture(anchor, undefined, 5).getTime()).toBe(anchor + 5);
  });
});

describe('claimColumns', () => {
  const story = { runners: [{ key: 'atlas', runner: 'atlas', localUiUrl: 'http://atlas.local:8766' }] } as unknown as Story;
  test('a runner claim reports its URL as both runner and localUiUrl', () => {
    expect(claimColumns(story, 'atlas')).toEqual({ runner: 'http://atlas.local:8766', localUiUrl: 'http://atlas.local:8766' });
  });
  test("a person's own session (claim_task over MCP) is runner 'mcp' with no localUiUrl, as the platform writes it", () => {
    expect(claimColumns(story, 'mcp')).toEqual({ runner: 'mcp', localUiUrl: null });
  });
});

describe('shiftTimestampsSql', () => {
  const q = shiftTimestampsSql('9.491');
  test('moves every public timestamp column by the delta', () => {
    expect(q).toContain("interval ''9.491 seconds''");
    expect(q).toContain("data_type like 'timestamp%'");
  });
  test('runs with user triggers off, so an append-only table (artifact_revisions) does not refuse the clock move', () => {
    const off = q.indexOf("set_config('session_replication_role', 'replica', true)");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(q.indexOf('execute format'));
  });
});
