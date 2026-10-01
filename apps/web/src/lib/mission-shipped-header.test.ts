import { describe, expect, it } from 'bun:test';
import { buildShippedHeaderView, NO_SCREENSHOTS_LINE } from './mission-shipped-header';
import type { ShippedRecord } from './mission-shipped';

const COMPLETED_AT = '2026-01-02T00:00:00.000Z';

const record = (over: Partial<ShippedRecord> = {}): ShippedRecord => ({
  version: 1,
  lede: 'On a phone, the home screen now opens on what needs you. Checked at phone and desktop width.',
  changeType: 'frontend',
  heroShots: [{ artifactId: 'a1', route: '/app/home', viewport: 'mobile', verdict: 'ok' }],
  offPlan: [],
  authorTaskId: 't1',
  origin: 'author',
  completedAt: COMPLETED_AT,
  ...over,
});

const view = (r: unknown, at: string | null = COMPLETED_AT) => buildShippedHeaderView(r, at);

describe('record present', () => {
  it('shows the lede, the change type and the hero shots', () => {
    const v = view(record())!;
    expect(v.lede).toContain('home screen');
    expect(v.changeTypeLabel).toBe('Frontend');
    expect(v.heroShots).toHaveLength(1);
    expect(v.noScreenshotsLine).toBeNull();
    expect(v.offPlan).toEqual([]);
    expect(v.completedByHand).toBe(false);
  });

  it('labels each change type', () => {
    expect(view(record({ changeType: 'backend', heroShots: [] }))!.changeTypeLabel).toBe('Backend');
    expect(view(record({ changeType: 'both' }))!.changeTypeLabel).toBe('Frontend and backend');
    expect(view(record({ changeType: null }))!.changeTypeLabel).toBeNull();
  });

  it('keeps at most two off-plan lines', () => {
    expect(view(record({ offPlan: ['a', 'b', 'c'] }))!.offPlan).toEqual(['a', 'b']);
  });

  it('a backend change with no shots says nothing about screenshots', () => {
    expect(view(record({ changeType: 'backend', heroShots: [] }))!.noScreenshotsLine).toBeNull();
  });
});

describe('frontend change with no shots', () => {
  it('states factually that no screenshots were captured, keeping the lede', () => {
    const v = view(record({ heroShots: [] }))!;
    expect(v.noScreenshotsLine).toBe(NO_SCREENSHOTS_LINE);
    expect(v.lede).not.toBeNull();
  });

  it('applies to a change touching both sides', () => {
    expect(view(record({ changeType: 'both', heroShots: [] }))!.noScreenshotsLine).toBe(NO_SCREENSHOTS_LINE);
  });
});

describe('mechanical-only variant', () => {
  it('no lede: change type and shots only, and off-plan is not shown without a lede', () => {
    const v = view(record({ lede: null, origin: 'no_author', offPlan: ['x'] }))!;
    expect(v.lede).toBeNull();
    expect(v.changeTypeLabel).toBe('Frontend');
    expect(v.heroShots).toHaveLength(1);
    expect(v.offPlan).toEqual([]);
  });

  it('a hand-completed mission is labelled so, even with nothing else', () => {
    const v = view(record({ lede: null, origin: 'manual', changeType: null, heroShots: [] }))!;
    expect(v.completedByHand).toBe(true);
    expect(v.lede).toBeNull();
  });

  it('frontend with no lede and no shots still gets the no-screenshots line', () => {
    const v = view(record({ lede: null, origin: 'no_author', heroShots: [] }))!;
    expect(v.noScreenshotsLine).toBe(NO_SCREENSHOTS_LINE);
  });

  it('no facts and no lede: no header', () => {
    expect(view(record({ lede: null, origin: 'no_author', changeType: null, heroShots: [] }))).toBeNull();
    expect(view(record({ lede: '   ', origin: 'no_author', changeType: null, heroShots: [] }))).toBeNull();
  });
});

describe('no usable record: the page renders as before (D3 fallback)', () => {
  it('no record at all', () => {
    expect(view(undefined)).toBeNull();
    expect(view(null)).toBeNull();
  });

  it('not a version-1 record', () => {
    expect(view({ ...record(), version: 2 })).toBeNull();
    expect(view('text')).toBeNull();
    expect(view([])).toBeNull();
  });

  it('a record from before the mission was reopened and completed again', () => {
    expect(view(record(), '2026-02-01T00:00:00.000Z')).toBeNull();
  });

  it('a mission with no completion time', () => {
    expect(view(record(), null)).toBeNull();
  });
});
