import { describe, expect, test } from 'bun:test';
import { idleStretchLabel, idleStretchSentence, idleWhileQueued } from './idle-while-queued';

const H = 3_600_000;
const M = 60_000;

describe('idleWhileQueued', () => {
  test('finds the stretch where nothing ran and work waited', () => {
    const out = idleWhileQueued({
      from: 0, to: 6 * H,
      runs: [{ start: 0, end: 1 * H }, { start: 3 * H, end: 4 * H }],
      queued: [{ from: 1 * H, to: 3 * H }, { from: 90 * M, to: 3 * H }],
    });
    expect(out).toEqual([{ from: 1 * H, to: 3 * H, waited: 2 }]);
  });

  test('no stretch while any slot is busy, or when nothing waits', () => {
    expect(idleWhileQueued({ from: 0, to: 4 * H, runs: [{ start: 0, end: null }], queued: [{ from: H, to: null }] })).toEqual([]);
    expect(idleWhileQueued({ from: 0, to: 4 * H, runs: [], queued: [] })).toEqual([]);
  });

  test('a task still waiting runs the stretch to the window end', () => {
    expect(idleWhileQueued({ from: 0, to: 2 * H, runs: [], queued: [{ from: 30 * M, to: null }] }))
      .toEqual([{ from: 30 * M, to: 2 * H, waited: 1 }]);
  });

  test('drops a stretch shorter than the minimum', () => {
    expect(idleWhileQueued({ from: 0, to: 2 * H, runs: [], queued: [{ from: 0, to: 5 * M }] })).toEqual([]);
  });

  test('a run ending exactly as the task starts leaves no gap', () => {
    expect(idleWhileQueued({ from: 0, to: 2 * H, runs: [{ start: 0, end: H }], queued: [{ from: 0, to: H }] })).toEqual([]);
  });
});

describe('labels', () => {
  test('home line and health sentence', () => {
    expect(idleStretchLabel({ from: 0, to: 2 * H, waited: 3 })).toBe('idle 2h while 3 tasks waited');
    expect(idleStretchSentence({ from: 0, to: 65 * M, waited: 1 })).toBe('every slot sat idle 1h 05m while 1 task waited');
  });
});
