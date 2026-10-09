import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'bun:test';
import { InsightsStats, insightsStats } from './InsightsStats';
import { readoutIndex } from './FlowChart';

const base = {
  shippedShare: 0.7,
  shippedHours: 74,
  lostHours: 32,
  inFlightHours: 5,
  otherHours: 37,
  shippedTasks: 175,
  releases: 35,
  medianStartToProdMs: 4.2 * 3_600_000,
};

describe('insightsStats', () => {
  it('is four cells in a fixed order', () => {
    expect(insightsStats(base as any).map(s => s.id)).toEqual(['shipped-share', 'tasks-shipped', 'to-production', 'lost']);
  });

  it('puts the share over settled time and the release count under tasks', () => {
    const [share, tasks] = insightsStats(base as any);
    expect(share.value).toBe('70%');
    expect(share.detail).toContain('of 106h');
    expect(tasks.value).toBe('175');
    expect(tasks.detail).toBe('in 35 releases');
  });

  it('says None instead of a fake 0% when nothing finished', () => {
    const [share, , toProd] = insightsStats({ ...base, shippedHours: 0, lostHours: 0, shippedShare: 0, medianStartToProdMs: null, releases: 0, shippedTasks: 0 } as any);
    expect(share.value).toBe('None');
    expect(toProd.value).toBe('None');
  });

  it('never explains itself: no history of how a number used to work', () => {
    const copy = insightsStats(base as any).flatMap(s => [s.label, s.detail]).join(' ');
    expect(copy).not.toMatch(/\b(now|earlier|used to|left out|so there is)\b/i);
  });
});

describe('readoutIndex', () => {
  it('shows the hovered time, else the tapped one, else the latest', () => {
    expect(readoutIndex(3, 5, 9)).toBe(3);
    expect(readoutIndex(null, 5, 9)).toBe(5);
    expect(readoutIndex(null, null, 9)).toBe(9);
  });

  it('shows nothing when there are no buckets', () => {
    expect(readoutIndex(null, null, -1)).toBeNull();
  });
});

it('stat labels use sentence case without tracked caps', () => {
  const html = renderToStaticMarkup(createElement(InsightsStats, { headline: base as any }));
  expect(html).not.toContain('uppercase');
  expect(html).not.toContain('tracking-[2px]');
});
