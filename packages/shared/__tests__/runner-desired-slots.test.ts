import { describe, expect, test } from 'bun:test';
import { reconcileDesiredSlots, parseRunnerSlots, describeSlotsOrigin, type DesiredSlots } from '../src/runner-desired-slots';

const dash = (slots: number, setAt: number): DesiredSlots => ({ slots, origin: 'dashboard', setBy: 'Max', setAt });

describe('reconcileDesiredSlots', () => {
  test('first report becomes the desired value, recorded as set on the machine', () => {
    const r = reconcileDesiredSlots({ desired: null, reported: 5, reportedChangedAt: 100, now: 999 });
    expect(r.write).toBe(true);
    expect(r.desired).toEqual({ slots: 5, origin: 'machine', setBy: null, setAt: 100 });
    expect(r.deliver).toBeNull();
  });

  test('first report with no change time stamps server now', () => {
    const r = reconcileDesiredSlots({ desired: null, reported: 5, reportedChangedAt: null, now: 999 });
    expect(r.desired?.setAt).toBe(999);
  });

  test('a dashboard change newer than the runner is handed back to it', () => {
    const r = reconcileDesiredSlots({ desired: dash(12, 200), reported: 5, reportedChangedAt: 100, now: 300 });
    expect(r.write).toBe(false);
    expect(r.deliver).toEqual(dash(12, 200));
  });

  test('a runner that never recorded a change does not override a person', () => {
    const r = reconcileDesiredSlots({ desired: dash(12, 200), reported: 5, reportedChangedAt: null, now: 300 });
    expect(r.deliver?.slots).toBe(12);
  });

  test('a local change made after the dashboard one wins and updates the desired value', () => {
    const r = reconcileDesiredSlots({ desired: dash(12, 200), reported: 4, reportedChangedAt: 250, now: 300 });
    expect(r.write).toBe(true);
    expect(r.desired).toEqual({ slots: 4, origin: 'machine', setBy: null, setAt: 250 });
    expect(r.deliver).toBeNull();
  });

  test('equal values change nothing', () => {
    const r = reconcileDesiredSlots({ desired: dash(12, 200), reported: 12, reportedChangedAt: 150, now: 300 });
    expect(r).toEqual({ desired: dash(12, 200), write: false, deliver: null });
  });

  test('a runner that reports no slots is left alone', () => {
    const r = reconcileDesiredSlots({ desired: dash(12, 200), reported: null, reportedChangedAt: null, now: 300 });
    expect(r.deliver).toBeNull();
    expect(r.write).toBe(false);
  });

  test('an offline runner gets the value when it next checks in', () => {
    // Saved while offline (setAt after the runner's last change), delivered on the first beat back.
    const r = reconcileDesiredSlots({ desired: dash(9, 5000), reported: 5, reportedChangedAt: 1000, now: 9000 });
    expect(r.deliver?.slots).toBe(9);
  });
});

describe('parseRunnerSlots / describeSlotsOrigin', () => {
  test('range', () => {
    expect(parseRunnerSlots(0)).toBeNull();
    expect(parseRunnerSlots(51)).toBeNull();
    expect(parseRunnerSlots(2.5)).toBeNull();
    expect(parseRunnerSlots('3')).toBeNull();
    expect(parseRunnerSlots(1)).toBe(1);
    expect(parseRunnerSlots(50)).toBe(50);
  });
  test('wording', () => {
    expect(describeSlotsOrigin(dash(5, 1), () => '14:02')).toBe('set on buildd.dev by Max, 14:02');
    expect(describeSlotsOrigin({ origin: 'machine', setBy: null, setAt: 1 }, () => '14:02')).toBe('set on this machine, 14:02');
  });
});
