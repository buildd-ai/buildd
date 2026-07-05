import { describe, expect, test } from 'bun:test';
import { findDuplicateScheduleIds, type ScheduleCronKey } from './schedule-health';

function row(overrides: Partial<ScheduleCronKey> & { id: string }): ScheduleCronKey {
  return {
    workspaceId: 'ws-1',
    cronExpression: '0 10 * * *',
    timezone: 'America/New_York',
    enabled: true,
    ...overrides,
  };
}

describe('findDuplicateScheduleIds', () => {
  test('flags enabled schedules sharing workspace + cron + timezone', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b' })]);
    expect(dupes).toEqual(new Set(['a', 'b']));
  });

  test('flags all members of a three-way collision', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    expect(dupes.size).toBe(3);
  });

  test('ignores disabled schedules — they do not fire', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b', enabled: false })]);
    expect(dupes.size).toBe(0);
  });

  test('different timezone is not a collision', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b', timezone: 'UTC' })]);
    expect(dupes.size).toBe(0);
  });

  test('different workspace is not a collision', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b', workspaceId: 'ws-2' })]);
    expect(dupes.size).toBe(0);
  });

  test('different cron is not a collision', () => {
    const dupes = findDuplicateScheduleIds([row({ id: 'a' }), row({ id: 'b', cronExpression: '0 9 * * *' })]);
    expect(dupes.size).toBe(0);
  });

  test('empty input yields empty set', () => {
    expect(findDuplicateScheduleIds([]).size).toBe(0);
  });
});
