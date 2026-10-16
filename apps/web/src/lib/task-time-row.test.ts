import { describe, expect, test } from 'bun:test';
import { agentMs, buildTimeRow } from './task-time-row';
import { formatTaskEstimate, type TaskEstimatePayload } from '@buildd/shared';
const t = (min: number) => new Date(Date.UTC(2026, 0, 1) + min * 60_000);
const now = t(100).getTime();
const estimate: TaskEstimatePayload = {
  estimatorVersion: 'test-v1', p50Minutes: 6.2, p80Minutes: 14.2, p50Tokens: 1_640_000, p80Tokens: 7_000_000,
  expectedRepairs: 0, explanation: { priorWeight: 1, clusterLabel: null,
    sources: [{ source: 'prior', n: 30, weight: 1 }], summary: '5m (5-15m), no history in this repo.' },
};
const input = { sessions: [], finished: false, now, estimate };
describe('buildTimeRow', () => {
  test('headline and detail use the exact same canonical range, without duplicated uncertainty', () => {
    const r = buildTimeRow(input)!;
    const d = formatTaskEstimate(estimate);
    expect(r.text).toBe(d.headline);
    expect(r.breakdown).toBe(d.breakdown);
    expect(r.explanation).toBe(d.provenance);
    expect(r.text).not.toContain('rough');
    expect(r.explanation).not.toContain('no history');
    expect(r.text).not.toContain('tokens');
  });
  test('running beyond displayed upper range flags once; finished never flags', () => {
    const sessions = [{ startedAt: t(0), completedAt: null }];
    expect(buildTimeRow({ ...input, sessions })!.text).toBe('1h 40m so far · About 5–15 min');
    expect(buildTimeRow({ ...input, sessions })!.overUpper).toBe(true);
    expect(buildTimeRow({ ...input, sessions, finished: true })!.overUpper).toBe(false);
    expect(buildTimeRow({ ...input, now: t(14.5).getTime(), sessions })!.overUpper).toBe(false);
  });
  test('no forecast or elapsed time returns null; elapsed alone still shows', () => {
    expect(buildTimeRow({ ...input, estimate: null })).toBeNull();
    expect(buildTimeRow({ ...input, estimate: null, sessions: [{ startedAt: t(90), completedAt: null }] })!.text).toBe('10m so far');
  });
  test('unsupported default does not present a made-up numeric range', () => {
    const r = buildTimeRow({ ...input, estimate: { ...estimate, explanation: { ...estimate.explanation, sources: [] } } })!;
    expect(r.text).toBe('Estimate unavailable');
    expect(r.overUpper).toBe(false);
  });
  test('sessions add and an open one counts to now', () => {
    expect(agentMs([{ startedAt: t(0), completedAt: t(10) }, { startedAt: t(90), completedAt: null }], now)).toBe(20 * 60_000);
  });
});
