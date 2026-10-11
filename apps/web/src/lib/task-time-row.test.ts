import { describe, expect, test } from 'bun:test';
import { agentMs, buildTimeRow } from './task-time-row';

const t = (min: number) => new Date(Date.UTC(2026, 9, 9, 12, 0) + min * 60_000);
const now = t(100).getTime();

describe('buildTimeRow', () => {
  test('running inside the estimate is not flagged', () => {
    const r = buildTimeRow({ sessions: [{ startedAt: t(52), completedAt: null }], finished: false, now, p50Minutes: 40, p80Minutes: 70, summary: '5 similar tasks' })!;
    expect(r.text).toBe('48m so far · est. 40m-1h 10m');
    expect(r.overUpper).toBe(false);
    expect(r.explanation).toBe('5 similar tasks');
  });
  test('running past p80 is flagged', () => {
    const r = buildTimeRow({ sessions: [{ startedAt: t(0), completedAt: null }], finished: false, now, p50Minutes: 40, p80Minutes: 70, summary: null })!;
    expect(r.text).toBe('1h 40m so far · est. 40m-1h 10m');
    expect(r.overUpper).toBe(true);
  });
  test('a finished task says Took and is never flagged', () => {
    const r = buildTimeRow({ sessions: [{ startedAt: t(0), completedAt: t(90) }], finished: true, now, p50Minutes: 40, p80Minutes: 70, summary: null })!;
    expect(r.text).toBe('Took 1h 30m · est. 40m-1h 10m');
    expect(r.overUpper).toBe(false);
  });
  test('sessions add and an open one counts to now', () => {
    expect(agentMs([{ startedAt: t(0), completedAt: t(10) }, { startedAt: t(90), completedAt: null }], now)).toBe(20 * 60_000);
  });
  test('nothing to show returns null; estimate alone still shows', () => {
    expect(buildTimeRow({ sessions: [], finished: false, now, p50Minutes: null, p80Minutes: null, summary: null })).toBeNull();
    expect(buildTimeRow({ sessions: [], finished: false, now, p50Minutes: 30, p80Minutes: 30, summary: null })!.text).toBe('est. 30m');
  });
});
