import { describe, expect, it } from 'bun:test';
import type { InitiativeTriageItem } from './triage-types';
import type { EffortDay } from '@/components/SparklineBar';

// Pure helper extracted from the component for unit testing
function isDormant(item: InitiativeTriageItem): boolean {
  const hasPending = item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
  const hasActivity = item.effortDays.some(d => d.tokens > 0);
  return !hasPending && !hasActivity;
}

function isNeedsYou(item: InitiativeTriageItem): boolean {
  return item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
}

function totalTokens(item: InitiativeTriageItem): number {
  return item.effortDays.reduce((s, d) => s + d.tokens, 0);
}

function partitionAndSort(items: InitiativeTriageItem[]) {
  const zone1: InitiativeTriageItem[] = [];
  const zone2: InitiativeTriageItem[] = [];
  const zone3: InitiativeTriageItem[] = [];

  for (const item of items) {
    if (isNeedsYou(item)) zone1.push(item);
    else if (!isDormant(item)) zone2.push(item);
    else zone3.push(item);
  }

  zone1.sort((a, b) => {
    const aC = a.awaitingVerification + a.blocked + a.held;
    const bC = b.awaitingVerification + b.blocked + b.held;
    if (bC !== aC) return bC - aC;
    return b.progress - a.progress;
  });

  zone2.sort((a, b) => {
    if (b.shippedThisWeek !== a.shippedThisWeek) return b.shippedThisWeek - a.shippedThisWeek;
    return totalTokens(b) - totalTokens(a);
  });

  return { zone1, zone2, zone3 };
}

const emptyDays: EffortDay[] = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  tokens: 0,
  merged: 0,
  failed: 0,
  open: 0,
}));

function makeItem(overrides: Partial<InitiativeTriageItem>): InitiativeTriageItem {
  return {
    id: 'test-id',
    title: 'Test',
    progress: 50,
    effortDays: emptyDays,
    awaitingVerification: 0,
    blocked: 0,
    held: 0,
    shippedThisWeek: 0,
    ...overrides,
  };
}

describe('InitiativeTriage zone sorting', () => {
  // AC-12
  it('puts initiatives with pending actions in Zone 1, activity-only in Zone 2, with divider implied', () => {
    const A = makeItem({ id: 'a', awaitingVerification: 2 });
    const B = makeItem({
      id: 'b',
      shippedThisWeek: 3,
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 13 ? 100 : 0 })),
    });
    const { zone1, zone2, zone3 } = partitionAndSort([A, B]);
    expect(zone1.map(x => x.id)).toEqual(['a']);
    expect(zone2.map(x => x.id)).toEqual(['b']);
    expect(zone3).toHaveLength(0);
  });

  // AC-13: dormant ends up in zone3, not zone1 or zone2
  it('puts all-zero initiatives in Zone 3 (dormant)', () => {
    const dormant = makeItem({ id: 'd', progress: 10 });
    const { zone1, zone2, zone3 } = partitionAndSort([dormant]);
    expect(zone1).toHaveLength(0);
    expect(zone2).toHaveLength(0);
    expect(zone3.map(x => x.id)).toEqual(['d']);
  });

  it('sorts Zone 1 by action count descending, then progress descending', () => {
    const highCount = makeItem({ id: 'high', awaitingVerification: 3, blocked: 2, progress: 30 });
    const lowCount = makeItem({ id: 'low', awaitingVerification: 1, progress: 80 });
    const { zone1 } = partitionAndSort([lowCount, highCount]);
    expect(zone1.map(x => x.id)).toEqual(['high', 'low']);
  });

  it('sorts Zone 1 by progress when action counts tie', () => {
    const highProg = makeItem({ id: 'hp', awaitingVerification: 1, progress: 70 });
    const lowProg = makeItem({ id: 'lp', awaitingVerification: 1, progress: 20 });
    const { zone1 } = partitionAndSort([lowProg, highProg]);
    expect(zone1.map(x => x.id)).toEqual(['hp', 'lp']);
  });

  it('sorts Zone 2 by shippedThisWeek desc, then total tokens desc', () => {
    const moreShipped = makeItem({
      id: 'ms',
      shippedThisWeek: 5,
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 13 ? 10 : 0 })),
    });
    const lessShipped = makeItem({
      id: 'ls',
      shippedThisWeek: 1,
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 13 ? 500 : 0 })),
    });
    const { zone2 } = partitionAndSort([lessShipped, moreShipped]);
    expect(zone2.map(x => x.id)).toEqual(['ms', 'ls']);
  });

  it('isDormant returns false when item has pending actions', () => {
    expect(isDormant(makeItem({ awaitingVerification: 1 }))).toBe(false);
    expect(isDormant(makeItem({ blocked: 1 }))).toBe(false);
    expect(isDormant(makeItem({ held: 1 }))).toBe(false);
  });

  it('isDormant returns false when item has recent token activity', () => {
    const active = makeItem({
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 10 ? 100 : 0 })),
    });
    expect(isDormant(active)).toBe(false);
  });

  it('isDormant returns true when no actions and no token activity', () => {
    expect(isDormant(makeItem({}))).toBe(true);
  });
});
