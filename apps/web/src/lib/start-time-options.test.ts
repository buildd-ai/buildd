import { describe, expect, it } from 'bun:test';
import { canReschedule, startTimeBody, startTimeLabel, tomorrowMorning } from './start-time-options';

const NOW = new Date(2030, 0, 15, 14, 30); // local 14:30

describe('startTimeBody', () => {
  it('ASAP clears the start time', () => {
    expect(startTimeBody({ kind: 'asap' }, NOW)).toEqual({ startAt: null });
  });
  it('relative choices send startIn', () => {
    expect(startTimeBody({ kind: 'in', duration: '1h' }, NOW)).toEqual({ startIn: '1h' });
    expect(startTimeBody({ kind: 'in', duration: '4h' }, NOW)).toEqual({ startIn: '4h' });
  });
  it('tomorrow is 9:00 local the next day', () => {
    const body = startTimeBody({ kind: 'tomorrow' }, NOW) as { startAt: string };
    const d = new Date(body.startAt);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2030, 0, 16, 9, 0]);
  });
  it('a picked time is sent as ISO; an empty or past pick is refused', () => {
    const picked = new Date(2030, 0, 20, 8, 0);
    expect(startTimeBody({ kind: 'pick', at: picked }, NOW)).toEqual({ startAt: picked.toISOString() });
    expect(startTimeBody({ kind: 'pick', at: new Date(2030, 0, 1) }, NOW)).toBeNull();
    expect(startTimeBody({ kind: 'pick', at: new Date('nope') }, NOW)).toBeNull();
  });
});

describe('tomorrowMorning', () => {
  it('rolls over month ends', () => {
    const d = tomorrowMorning(new Date(2030, 0, 31, 23, 0));
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([1, 1, 9]);
  });
});

describe('startTimeLabel', () => {
  it('no time or a past time reads as soon as possible', () => {
    expect(startTimeLabel(null, NOW)).toBe('As soon as possible');
    expect(startTimeLabel(new Date(2030, 0, 1).toISOString(), NOW)).toBe('As soon as possible');
  });
  it('a future time names it', () => {
    expect(startTimeLabel(new Date(2030, 0, 15, 18, 0).toISOString(), NOW)).toMatch(/^Starts /);
  });
});

describe('canReschedule', () => {
  it('only a waiting, unclaimed task', () => {
    expect(canReschedule('pending', null)).toBe(true);
    expect(canReschedule('pending', 'worker-1')).toBe(false);
    expect(canReschedule('in_progress', null)).toBe(false);
    expect(canReschedule('completed', null)).toBe(false);
  });
});
