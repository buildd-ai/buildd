/**
 * The global "…needs your input" banner steps aside for a question whose own
 * sheet (or docked pane) is open — it is the same question, answered right
 * below it (demo capture: the banner sat on top of the sheet answering it).
 */
import { describe, expect, it } from 'bun:test';
import { bannerTasks, hideNeedsInputBannerOnPhone, hideNeedsInputFor, hiddenNeedsInputSnapshot, phoneBannerHiddenSnapshot, subscribeHiddenNeedsInput } from './needs-input-hidden';

describe('needs-input hidden set', () => {
  it('hides a task while held and releases it after', () => {
    const release = hideNeedsInputFor('t1');
    expect(hiddenNeedsInputSnapshot().has('t1')).toBe(true);
    release();
    expect(hiddenNeedsInputSnapshot().has('t1')).toBe(false);
  });

  it('is ref-counted: two holders of one task, one release keeps it hidden', () => {
    const a = hideNeedsInputFor('t2');
    const b = hideNeedsInputFor('t2');
    a();
    expect(hiddenNeedsInputSnapshot().has('t2')).toBe(true);
    b();
    expect(hiddenNeedsInputSnapshot().has('t2')).toBe(false);
  });

  it('a double release does not unhide a second holder', () => {
    const a = hideNeedsInputFor('t3');
    const b = hideNeedsInputFor('t3');
    a();
    a();
    expect(hiddenNeedsInputSnapshot().has('t3')).toBe(true);
    b();
  });

  it('notifies subscribers and hands out a new snapshot on change', () => {
    let calls = 0;
    const unsub = subscribeHiddenNeedsInput(() => { calls++; });
    const before = hiddenNeedsInputSnapshot();
    const release = hideNeedsInputFor('t4');
    expect(calls).toBe(1);
    expect(hiddenNeedsInputSnapshot()).not.toBe(before);
    release();
    expect(calls).toBe(2);
    unsub();
  });
});

describe('bannerTasks', () => {
  const tasks = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];

  it('drops the tasks whose question is open elsewhere, keeping order', () => {
    expect(bannerTasks(tasks, new Set(['a']))).toEqual([{ id: 'b', title: 'B' }]);
  });

  it('keeps everything when nothing is hidden', () => {
    expect(bannerTasks(tasks, new Set())).toBe(tasks);
  });
});

// The phone chat canvas in needs-you mood already says what waits on you, in
// its hero and copper row; the yellow banner above it only repeats it.
describe('phone banner suppression', () => {
  it('is held while any surface asks and released after, counted', () => {
    expect(phoneBannerHiddenSnapshot()).toBe(false);
    const a = hideNeedsInputBannerOnPhone();
    const b = hideNeedsInputBannerOnPhone();
    expect(phoneBannerHiddenSnapshot()).toBe(true);
    a();
    a();
    expect(phoneBannerHiddenSnapshot()).toBe(true);
    b();
    expect(phoneBannerHiddenSnapshot()).toBe(false);
  });

  it('notifies subscribers', () => {
    let n = 0;
    const off = subscribeHiddenNeedsInput(() => { n += 1; });
    hideNeedsInputBannerOnPhone()();
    off();
    expect(n).toBe(2);
  });
});
