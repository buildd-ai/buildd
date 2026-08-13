import { describe, expect, it } from 'bun:test';
import type { InitiativeTriageItem } from './triage-types';
import type { EffortDay } from '@/components/SparklineBar';

// Mirror the zone-partition logic from InitiativeTriage.tsx as a pure function
// so it can be tested without a DOM environment.
function isDormant(item: InitiativeTriageItem): boolean {
  const hasPending = item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
  const hasActivity = item.effortDays.some(d => d.tokens > 0);
  return !hasPending && !hasActivity;
}

function isNeedsYou(item: InitiativeTriageItem): boolean {
  return item.awaitingVerification > 0 || item.blocked > 0 || item.held > 0;
}

function partitionZones(
  items: InitiativeTriageItem[],
  dismissed: Set<string> = new Set(),
) {
  const zone1: InitiativeTriageItem[] = [];
  const zone2: InitiativeTriageItem[] = [];
  const zone3: InitiativeTriageItem[] = [];

  for (const item of items) {
    if (dismissed.has(item.id)) continue;
    if (isNeedsYou(item)) zone1.push(item);
    else if (!isDormant(item)) zone2.push(item);
    else zone3.push(item);
  }

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

describe('InitiativeTriage partitionZones()', () => {
  it('places initiative with blocked > 0 into Zone 1', () => {
    const item = makeItem({ id: 'b', blocked: 2 });
    const { zone1, zone2, zone3 } = partitionZones([item]);
    expect(zone1.map(x => x.id)).toContain('b');
    expect(zone2).toHaveLength(0);
    expect(zone3).toHaveLength(0);
  });

  it('places initiative with recent token activity (and no pending) into Zone 2', () => {
    const item = makeItem({
      id: 'active',
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 13 ? 500 : 0 })),
    });
    const { zone1, zone2, zone3 } = partitionZones([item]);
    expect(zone1).toHaveLength(0);
    expect(zone2.map(x => x.id)).toContain('active');
    expect(zone3).toHaveLength(0);
  });

  it('places dormant initiative (no pending, no activity) into Zone 3 tail', () => {
    const item = makeItem({ id: 'dormant' });
    const { zone1, zone2, zone3 } = partitionZones([item]);
    expect(zone1).toHaveLength(0);
    expect(zone2).toHaveLength(0);
    expect(zone3.map(x => x.id)).toContain('dormant');
  });

  it('excludes dismissed IDs from all zones and the tail', () => {
    const needsYou = makeItem({ id: 'nyu', awaitingVerification: 1 });
    const active = makeItem({
      id: 'act',
      effortDays: emptyDays.map((d, i) => ({ ...d, tokens: i === 13 ? 100 : 0 })),
    });
    const dormant = makeItem({ id: 'dorm' });

    const dismissed = new Set(['nyu', 'act', 'dorm']);
    const { zone1, zone2, zone3 } = partitionZones([needsYou, active, dormant], dismissed);

    expect(zone1).toHaveLength(0);
    expect(zone2).toHaveLength(0);
    expect(zone3).toHaveLength(0);
  });

  it('only excludes the dismissed ID, not others in the same zone', () => {
    const a = makeItem({ id: 'a', blocked: 1 });
    const b = makeItem({ id: 'b', blocked: 2 });

    const { zone1 } = partitionZones([a, b], new Set(['a']));
    expect(zone1.map(x => x.id)).toEqual(['b']);
  });
});
