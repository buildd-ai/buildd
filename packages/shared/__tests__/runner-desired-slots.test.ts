import { describe, expect, test } from 'bun:test';
import { reconcileDesiredSlots, reconcileDesiredPause, parseRunnerSlots, describeSlotsOrigin, describePauseOrigin, reportedRunnerPause, type DesiredSlots, type DesiredPause } from '../src/runner-desired-slots';

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
    expect(parseRunnerSlots(-1)).toBeNull();
    expect(parseRunnerSlots(51)).toBeNull();
    expect(parseRunnerSlots(2.5)).toBeNull();
    expect(parseRunnerSlots('3')).toBeNull();
    expect(parseRunnerSlots(1)).toBe(1);
    // 0 is a real setting: the runner claims nothing (spec 97b1bd0b R-18).
    expect(parseRunnerSlots(0)).toBe(0);
    expect(parseRunnerSlots(50)).toBe(50);
  });
  test('wording', () => {
    expect(describeSlotsOrigin(dash(5, 1), () => '14:02')).toBe('set on buildd.dev by Max, 14:02');
    expect(describeSlotsOrigin({ origin: 'machine', setBy: null, setAt: 1 }, () => '14:02')).toBe('set on this machine, 14:02');
  });
});

describe('reconcileDesiredSlots at 0', () => {
  test('a dashboard 0 is handed to the runner like any other value', () => {
    const r = reconcileDesiredSlots({ desired: dash(0, 200), reported: 5, reportedChangedAt: 100, now: 300 });
    expect(r.deliver?.slots).toBe(0);
  });
  test('a runner reporting 0 is recorded, not treated as missing', () => {
    const r = reconcileDesiredSlots({ desired: null, reported: 0, reportedChangedAt: 100, now: 300 });
    expect(r.desired).toEqual({ slots: 0, origin: 'machine', setBy: null, setAt: 100 });
  });
});

const pauseBy = (paused: boolean, setAt: number): DesiredPause => ({ paused, origin: 'dashboard', setBy: 'Max', setAt });

describe('reconcileDesiredPause', () => {
  test('first report is recorded as the machine\'s', () => {
    const r = reconcileDesiredPause({ desired: null, reported: false, reportedChangedAt: null, now: 999 });
    expect(r.write).toBe(true);
    expect(r.desired).toEqual({ paused: false, origin: 'machine', setBy: null, setAt: 999 });
    expect(r.deliver).toBeNull();
  });

  test('a dashboard pause newer than the runner\'s own change is delivered', () => {
    const r = reconcileDesiredPause({ desired: pauseBy(true, 200), reported: false, reportedChangedAt: 100, now: 300 });
    expect(r.deliver).toEqual(pauseBy(true, 200));
    expect(r.write).toBe(false);
  });

  test('saved while offline, delivered on the first beat back', () => {
    const r = reconcileDesiredPause({ desired: pauseBy(true, 5000), reported: false, reportedChangedAt: 1000, now: 9000 });
    expect(r.deliver?.paused).toBe(true);
  });

  test('a local resume after the dashboard pause wins', () => {
    const r = reconcileDesiredPause({ desired: pauseBy(true, 200), reported: false, reportedChangedAt: 250, now: 300 });
    expect(r.write).toBe(true);
    expect(r.desired).toEqual({ paused: false, origin: 'machine', setBy: null, setAt: 250 });
    expect(r.deliver).toBeNull();
  });

  test('a dashboard resume is delivered to a runner held before it', () => {
    const r = reconcileDesiredPause({ desired: pauseBy(false, 400), reported: true, reportedChangedAt: 300, now: 500 });
    expect(r.deliver?.paused).toBe(false);
  });

  test('agreement changes nothing; an older runner that says nothing is left alone', () => {
    expect(reconcileDesiredPause({ desired: pauseBy(true, 200), reported: true, reportedChangedAt: 100, now: 300 })).toEqual({ desired: pauseBy(true, 200), write: false, deliver: null });
    expect(reconcileDesiredPause({ desired: pauseBy(true, 200), reported: null, reportedChangedAt: null, now: 300 }).deliver).toBeNull();
  });
});

describe('reportedRunnerPause / describePauseOrigin', () => {
  test('reads the hold the runner sends; no hold key is unknown', () => {
    expect(reportedRunnerPause({ hold: { since: '2026-10-27T10:00:00.000Z', until: null } }, Date.parse('2026-10-27T11:00:00Z'))).toBe(true);
    expect(reportedRunnerPause({ hold: null }, 0)).toBe(false);
    // A timed hold that ran out is not a pause.
    expect(reportedRunnerPause({ hold: { since: '2026-10-27T10:00:00.000Z', until: '2026-10-27T10:30:00.000Z' } }, Date.parse('2026-10-27T11:00:00Z'))).toBe(false);
    expect(reportedRunnerPause({ envKeys: [] }, 0)).toBeNull();
    expect(reportedRunnerPause(null, 0)).toBeNull();
  });
  test('wording', () => {
    expect(describePauseOrigin(pauseBy(true, 1), () => '10:44')).toBe('paused on buildd.dev by Max, 10:44');
    expect(describePauseOrigin(pauseBy(false, 1), () => '10:44')).toBe('resumed on buildd.dev by Max, 10:44');
    expect(describePauseOrigin({ paused: true, origin: 'machine', setBy: null, setAt: 1 }, () => '10:44')).toBe('paused on this machine, 10:44');
  });
});
