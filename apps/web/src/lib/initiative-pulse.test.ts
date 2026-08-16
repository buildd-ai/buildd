import { describe, it, expect, mock } from 'bun:test';

// Only the pure half of the module is under test here (`loadInitiativeEffort`'s
// SQL is covered by the route test). Stub the db/schema/orm modules so importing
// the module never opens a connection.
mock.module('@buildd/core/db', () => ({ db: { select: () => { throw new Error('not used'); } } }));
mock.module('@buildd/core/db/schema', () => ({
  workers: { completedAt: 'completedAt', updatedAt: 'updatedAt', inputTokens: 'inputTokens', outputTokens: 'outputTokens', status: 'status', prUrl: 'prUrl', taskId: 'taskId' },
  tasks: { id: 'id', missionId: 'missionId' },
  missions: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId', initiativeId: 'initiativeId' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));

import {
  buildEffortWindow,
  zeroEffortWindow,
  derivePendingCounts,
  noPendingCounts,
  UNASSIGNED_INITIATIVE_KEY,
  EFFORT_WINDOW_DAYS,
  type EffortRow,
  type PulseMission,
} from './initiative-pulse';

// Fixed clock so window arithmetic is assertable. 2026-08-16 UTC.
const TODAY = new Date('2026-08-16T12:00:00Z');

function row(partial: Partial<EffortRow>): EffortRow {
  return { initiativeId: 'init-1', day: '2026-08-16', tokens: 0, merged: 0, failed: 0, open: 0, ...partial };
}

describe('buildEffortWindow', () => {
  it('back-fills a sparse input to exactly 14 entries, oldest first', () => {
    const out = buildEffortWindow([row({ day: '2026-08-10', tokens: '1500' })], { today: TODAY });
    const days = out.get('init-1')!;

    expect(days).toHaveLength(EFFORT_WINDOW_DAYS);
    expect(days[0].date).toBe('2026-08-03');
    expect(days[13].date).toBe('2026-08-16');
    expect(days.filter((d) => d.tokens > 0)).toHaveLength(1);
  });

  it('anchors the window on today, not on the latest row present', () => {
    // Activity that stopped 6 days ago must NOT land at the right-hand edge —
    // that is what made a silent initiative read as busy.
    const out = buildEffortWindow([row({ day: '2026-08-10', tokens: '900' })], { today: TODAY });
    const days = out.get('init-1')!;

    expect(days[13].tokens).toBe(0);
    expect(days.find((d) => d.date === '2026-08-10')!.tokens).toBe(900);
  });

  it('sums input_tokens and output_tokens per day as numbers, not strings', () => {
    const out = buildEffortWindow(
      [row({ day: '2026-08-14', tokens: '1000', merged: '2', failed: '1', open: '0' })],
      { today: TODAY },
    );
    const day = out.get('init-1')!.find((d) => d.date === '2026-08-14')!;

    expect(day).toMatchObject({ tokens: 1000, merged: 2, failed: 1, open: 0 });
  });

  it('sums a day that appears twice for one initiative rather than overwriting it', () => {
    const out = buildEffortWindow(
      [
        row({ day: '2026-08-15', tokens: '100', merged: '1' }),
        row({ day: '2026-08-15', tokens: '250', merged: '2' }),
      ],
      { today: TODAY },
    );
    const day = out.get('init-1')!.find((d) => d.date === '2026-08-15')!;

    expect(day.tokens).toBe(350);
    expect(day.merged).toBe(3);
  });

  it('buckets a null initiativeId under __unassigned__', () => {
    const out = buildEffortWindow([row({ initiativeId: null, tokens: '75' })], { today: TODAY });

    expect(out.has(UNASSIGNED_INITIATIVE_KEY)).toBe(true);
    expect(out.has('unassigned')).toBe(false);
    expect(out.get(UNASSIGNED_INITIATIVE_KEY)![13].tokens).toBe(75);
  });

  it('omits initiatives with no rows rather than inventing them', () => {
    const out = buildEffortWindow([], { today: TODAY });
    expect(out.size).toBe(0);
  });

  it('normalises a timestamp-shaped day value to its date part', () => {
    const out = buildEffortWindow([row({ day: '2026-08-16T00:00:00.000Z', tokens: '10' })], { today: TODAY });
    expect(out.get('init-1')![13].tokens).toBe(10);
  });
});

describe('zeroEffortWindow', () => {
  it('is a dense all-zero window ending today', () => {
    const days = zeroEffortWindow({ today: TODAY });

    expect(days).toHaveLength(EFFORT_WINDOW_DAYS);
    expect(days[13].date).toBe('2026-08-16');
    expect(days.every((d) => d.tokens === 0)).toBe(true);
  });
});

describe('derivePendingCounts', () => {
  const NOW = TODAY.getTime();

  function mission(partial: Partial<PulseMission>): PulseMission {
    return { initiativeId: 'init-1', ...partial };
  }

  it('counts a completed task with an open PR as awaiting verification', () => {
    const out = derivePendingCounts(
      [
        mission({
          tasks: [{ status: 'completed', workers: [{ prUrl: 'https://x/1', mergedAt: null, prLifecycleStatus: 'open' }] }],
        }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.awaitingVerification).toBe(1);
  });

  it('does not count a merged or closed PR as awaiting verification', () => {
    const out = derivePendingCounts(
      [
        mission({
          tasks: [
            { status: 'completed', workers: [{ prUrl: 'https://x/1', mergedAt: new Date(), prLifecycleStatus: 'merged' }] },
            { status: 'completed', workers: [{ prUrl: 'https://x/2', mergedAt: null, prLifecycleStatus: 'closed' }] },
            { status: 'pending', workers: [{ prUrl: 'https://x/3', mergedAt: null, prLifecycleStatus: 'open' }] },
          ],
        }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.awaitingVerification).toBe(0);
  });

  it('sums blocked counts and held missions across an initiative', () => {
    const out = derivePendingCounts(
      [
        mission({ blockedPRCount: 2, isHeld: true }),
        mission({ blockedPRCount: 1, isHeld: false }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')).toMatchObject({ blocked: 3, held: 1 });
  });

  it('counts a shipped mission only when its activity is inside 7 days', () => {
    const out = derivePendingCounts(
      [
        mission({ health: 'shipped', lastActivityAt: new Date(NOW - 2 * 86_400_000).toISOString() }),
        mission({ health: 'shipped', lastActivityAt: new Date(NOW - 9 * 86_400_000).toISOString() }),
        mission({ health: 'idle', lastActivityAt: new Date(NOW).toISOString() }),
      ],
      { now: NOW },
    );

    expect(out.get('init-1')!.shippedThisWeek).toBe(1);
  });

  it('buckets missions with no initiative under __unassigned__', () => {
    const out = derivePendingCounts([mission({ initiativeId: null, blockedPRCount: 4 })], { now: NOW });

    expect(out.get(UNASSIGNED_INITIATIVE_KEY)!.blocked).toBe(4);
    expect(out.has('init-1')).toBe(false);
  });

  it('tolerates missions with no tasks and no counts', () => {
    const out = derivePendingCounts([mission({ tasks: null })], { now: NOW });

    expect(out.get('init-1')).toEqual(noPendingCounts());
  });
});
