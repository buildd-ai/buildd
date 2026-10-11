import { describe, it, expect, mock } from 'bun:test';
import { scheduleTaskEstimate } from './task-estimate-hook';

/**
 * The task-estimates post-insert hook: schedules the write, never awaits it,
 * never throws, and only for work rows.
 */

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('scheduleTaskEstimate', () => {
  it('schedules the write for a work task and returns synchronously', async () => {
    const write = mock(async () => 'written');
    const scheduled: Array<() => Promise<unknown>> = [];
    const out = scheduleTaskEstimate({ id: 't-1', taskClass: 'work' }, fn => { scheduled.push(fn); }, { write });
    expect(out).toBe(true);
    // Nothing ran yet: the write belongs to after(), not to the request.
    expect(write).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(write).toHaveBeenCalledWith('t-1');
  });

  it('a missing taskClass is a work row', () => {
    expect(scheduleTaskEstimate({ id: 't-1' }, () => {}, { write: async () => 'skipped' })).toBe(true);
  });

  it('skips attempt and bookkeeping rows, and a row without an id', () => {
    const schedule = mock(() => {});
    expect(scheduleTaskEstimate({ id: 't-1', taskClass: 'attempt' }, schedule)).toBe(false);
    expect(scheduleTaskEstimate({ id: 't-1', taskClass: 'bookkeeping' }, schedule)).toBe(false);
    expect(scheduleTaskEstimate({ id: '' }, schedule)).toBe(false);
    expect(scheduleTaskEstimate(null, schedule)).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a rejecting write is swallowed inside the scheduled run', async () => {
    const write = mock(async () => { throw new Error('boom'); });
    let run: (() => Promise<unknown>) | null = null;
    scheduleTaskEstimate({ id: 't-1' }, fn => { run = fn; }, { write });
    await expect(run!()).resolves.toBeUndefined();
  });

  it('outside a request scope (after() throws) it runs detached and still never throws', async () => {
    const write = mock(() => Promise.reject(new Error('boom')));
    const out = scheduleTaskEstimate({ id: 't-1' }, () => { throw new Error('after() outside request scope'); }, { write });
    expect(out).toBe(true);
    await tick();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a write that never settles does not hold the caller', () => {
    const write = mock(() => new Promise<string>(() => {}));
    const out = scheduleTaskEstimate({ id: 't-1' }, fn => { void fn(); }, { write });
    expect(out).toBe(true);
  });
});
