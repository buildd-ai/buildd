import { describe, expect, test } from 'bun:test';
import { formatHour, isOverdue, getHeartbeatStatus, estimateCronIntervalMs } from './heartbeat-helpers';

describe('formatHour', () => {
  test('formats midnight as 12:00 AM', () => {
    expect(formatHour(0)).toBe('12:00 AM');
  });

  test('formats morning hours', () => {
    expect(formatHour(1)).toBe('1:00 AM');
    expect(formatHour(8)).toBe('8:00 AM');
    expect(formatHour(11)).toBe('11:00 AM');
  });

  test('formats noon as 12:00 PM', () => {
    expect(formatHour(12)).toBe('12:00 PM');
  });

  test('formats afternoon hours', () => {
    expect(formatHour(13)).toBe('1:00 PM');
    expect(formatHour(17)).toBe('5:00 PM');
    expect(formatHour(22)).toBe('10:00 PM');
    expect(formatHour(23)).toBe('11:00 PM');
  });

  test('handles out-of-range values gracefully', () => {
    expect(formatHour(-1)).toBe('-1:00');
    expect(formatHour(24)).toBe('24:00');
  });
});

describe('estimateCronIntervalMs', () => {
  test('every 5 minutes', () => {
    expect(estimateCronIntervalMs('*/5 * * * *')).toBe(5 * 60 * 1000);
  });

  test('every hour', () => {
    expect(estimateCronIntervalMs('0 * * * *')).toBe(60 * 60 * 1000);
  });

  test('every 6 hours', () => {
    expect(estimateCronIntervalMs('0 */6 * * *')).toBe(6 * 60 * 60 * 1000);
  });

  test('daily at specific time', () => {
    expect(estimateCronIntervalMs('0 9 * * *')).toBe(24 * 60 * 60 * 1000);
  });

  test('weekly', () => {
    expect(estimateCronIntervalMs('0 9 * * 1')).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('isOverdue', () => {
  test('not overdue when nextRunAt is in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isOverdue(future, '0 * * * *')).toBe(false);
  });

  test('not overdue when just past nextRunAt', () => {
    // 30 minutes past for an hourly cron — less than 2x interval
    const past = new Date(Date.now() - 30 * 60 * 1000);
    expect(isOverdue(past, '0 * * * *')).toBe(false);
  });

  test('overdue when past by more than 2x interval', () => {
    // 3 hours past for an hourly cron — more than 2x interval
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(isOverdue(past, '0 * * * *')).toBe(true);
  });

  test('works with string dates', () => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(isOverdue(past, '0 * * * *')).toBe(true);
  });
});

describe('getHeartbeatStatus', () => {
  test('returns null when no tasks', () => {
    expect(getHeartbeatStatus([])).toEqual({ lastStatus: null, lastAt: null });
  });

  test('returns null when no completed tasks', () => {
    const tasks = [
      { id: '1', createdAt: new Date(), status: 'running', result: null },
    ];
    expect(getHeartbeatStatus(tasks)).toEqual({ lastStatus: null, lastAt: null });
  });

  test('returns null when completed task has no structuredOutput', () => {
    const tasks = [
      { id: '1', createdAt: new Date(), status: 'completed', result: { summary: 'done' } },
    ];
    expect(getHeartbeatStatus(tasks)).toEqual({ lastStatus: null, lastAt: null });
  });

  test('returns ok status from most recent completed task', () => {
    const d = new Date('2026-01-15T10:00:00Z');
    const tasks = [
      { id: '1', createdAt: d, status: 'completed', result: { structuredOutput: { status: 'ok' } } },
      { id: '2', createdAt: new Date('2026-01-14'), status: 'completed', result: { structuredOutput: { status: 'error' } } },
    ];
    const result = getHeartbeatStatus(tasks);
    expect(result.lastStatus).toBe('ok');
    expect(result.lastAt).toBe(d.toISOString());
  });

  test('returns action_taken status', () => {
    const d = '2026-01-15T10:00:00Z';
    const tasks = [
      { id: '1', createdAt: d, status: 'completed', result: { structuredOutput: { status: 'action_taken' } } },
    ];
    const result = getHeartbeatStatus(tasks);
    expect(result.lastStatus).toBe('action_taken');
    expect(result.lastAt).toBe(d);
  });

  test('skips non-completed tasks to find status', () => {
    const tasks = [
      { id: '1', createdAt: new Date(), status: 'running', result: null },
      { id: '2', createdAt: '2026-01-15T10:00:00Z', status: 'completed', result: { structuredOutput: { status: 'error' } } },
    ];
    const result = getHeartbeatStatus(tasks);
    expect(result.lastStatus).toBe('error');
  });
});
