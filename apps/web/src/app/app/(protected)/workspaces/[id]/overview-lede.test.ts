import { describe, expect, it } from 'bun:test';
import { taskCountLede } from './overview-lede';

describe('taskCountLede', () => {
  it('says nothing is queued when every count is zero', () => {
    expect(taskCountLede({})).toBe('Nothing queued.');
    expect(taskCountLede({ pending: 0, completed: 0 })).toBe('Nothing queued.');
  });

  it('lists only the nonzero parts, assigned and in progress reading as running', () => {
    expect(taskCountLede({ pending: 3, assigned: 1, failed: 2, completed: 9 })).toBe('3 pending, 1 running, 2 failed.');
    expect(taskCountLede({ assigned: 1, in_progress: 2 })).toBe('3 running.');
    expect(taskCountLede({ failed: 1 })).toBe('1 failed.');
  });

  it('ignores completed and cancelled work', () => {
    expect(taskCountLede({ completed: 40, cancelled: 2 })).toBe('Nothing queued.');
  });
});
