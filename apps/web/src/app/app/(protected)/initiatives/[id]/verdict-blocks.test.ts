import { describe, it, expect, mock } from 'bun:test';

// `@/lib/initiative-pulse` imports the database. `verdict-blocks.ts` only takes
// *types* from it (erased at compile time), but this file also exercises the
// real `derivePendingCounts` to prove the strip's per-mission attribution sums
// to the aggregate the Initiatives list renders (§5.2). Stub the db/orm modules
// so importing the loader never opens a connection.
mock.module('@buildd/core/db', () => ({ db: { select: () => { throw new Error('not used'); } } }));
mock.module('@buildd/core/db/schema', () => ({
  workers: { completedAt: 'completedAt', updatedAt: 'updatedAt', inputTokens: 'inputTokens', outputTokens: 'outputTokens', status: 'status', prUrl: 'prUrl', taskId: 'taskId', mergedAt: 'mergedAt' },
  tasks: { id: 'id', missionId: 'missionId', title: 'title', parentTaskId: 'parentTaskId', createdAt: 'createdAt', mode: 'mode' },
  missions: { id: 'id', teamId: 'teamId', workspaceId: 'workspaceId', initiativeId: 'initiativeId', status: 'status', goalCriteriaState: 'goalCriteriaState' },
  initiatives: { id: 'id', teamId: 'teamId', status: 'status', kpiState: 'kpiState' },
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  gte: (a: any, b: any) => ({ a, b }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));

import {
  derivePendingCounts,
  zeroEffortWindow,
  noPendingCounts,
  EFFORT_WINDOW_DAYS,
  VERDICT_WINDOW_DAYS,
  type EffortDay,
  type PendingCounts,
  type PulseMission,
} from '@/lib/initiative-pulse';

import {
  buildPendingChips,
  formatVerdictEvidence,
  formatEffortTotal,
  latestWorkerPerTask,
  verdictEvidenceAnchor,
  missionContributions,
  DETAIL_SPARKLINE_WIDTH,
  DETAIL_SPARKLINE_HEIGHT,
  MISSIONS_ANCHOR,
  KPI_ANCHOR,
  PENDING_CHIP_ORDER,
  type MissionContribution,
} from './verdict-blocks';

const INITIATIVE = 'i-1';

function counts(partial: Partial<PendingCounts>): PendingCounts {
  return { ...noPendingCounts(), ...partial };
}

function contribution(missionId: string, partial: Partial<PendingCounts>): MissionContribution {
  return { missionId, counts: counts(partial) };
}

describe('buildPendingChips (§5.1 pending-action strip)', () => {
  it('AC-19: renders exactly one chip per non-zero count and none for a zero', () => {
    const chips = buildPendingChips(
      [contribution('m-1', { awaitingVerification: 2, shippedThisWeek: 5 })],
      { initiativeId: INITIATIVE },
    );

    expect(chips.map((c) => c.label)).toEqual(['2 awaiting merge', '5 shipped this week']);
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.count > 0)).toBe(true);
  });

  it('renders no chip at all when every count is zero — absence is the empty state', () => {
    expect(buildPendingChips([contribution('m-1', {})], { initiativeId: INITIATIVE })).toEqual([]);
    expect(buildPendingChips([], { initiativeId: INITIATIVE })).toEqual([]);
  });

  it('orders chips awaiting → blocked → held → shipped, never by size', () => {
    const chips = buildPendingChips(
      [contribution('m-1', { awaitingVerification: 1, blocked: 9, held: 4, shippedThisWeek: 7 })],
      { initiativeId: INITIATIVE },
    );
    expect(chips.map((c) => c.key)).toEqual([...PENDING_CHIP_ORDER]);
  });

  it('every chip carries a link — the strip is links, not text (§1)', () => {
    const chips = buildPendingChips(
      [contribution('m-1', { awaitingVerification: 1, blocked: 2 })],
      { initiativeId: INITIATIVE },
    );
    expect(chips.every((c) => typeof c.href === 'string' && c.href.length > 0)).toBe(true);
  });

  it('links a chip to the one mission that owns the count, carrying initiative context', () => {
    const chips = buildPendingChips(
      [contribution('m-1', { held: 1 }), contribution('m-2', {})],
      { initiativeId: INITIATIVE },
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].href).toBe('/app/missions/m-1?from=initiative&initiativeId=i-1');
  });

  it('falls back to the on-page missions list when several missions own the count', () => {
    const chips = buildPendingChips(
      [contribution('m-1', { blocked: 1 }), contribution('m-2', { blocked: 2 })],
      { initiativeId: INITIATIVE },
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].count).toBe(3);
    expect(chips[0].href).toBe(MISSIONS_ANCHOR);
  });

  it('sums each count across missions so the strip totals match the loader', () => {
    const chips = buildPendingChips(
      [
        contribution('m-1', { awaitingVerification: 2, held: 1 }),
        contribution('m-2', { awaitingVerification: 3 }),
      ],
      { initiativeId: INITIATIVE },
    );
    const byKey = new Map(chips.map((c) => [c.key, c.count]));
    expect(byKey.get('awaitingVerification')).toBe(5);
    expect(byKey.get('held')).toBe(1);
  });
});

describe('§5.2 agreement — per-mission attribution cannot drift from the aggregate', () => {
  const missionRows: Array<PulseMission & { id: string }> = [
    {
      id: 'm-1',
      initiativeId: INITIATIVE,
      isHeld: true,
      health: 'active',
      lastActivityAt: null,
      blockedPRCount: 2,
      tasks: [
        { status: 'completed', workers: [{ prUrl: 'https://example.test/pr/1', mergedAt: null, prLifecycleStatus: 'open' }] },
        { status: 'completed', workers: [{ prUrl: null, mergedAt: null, prLifecycleStatus: null }] },
      ],
    },
    {
      id: 'm-2',
      initiativeId: INITIATIVE,
      isHeld: false,
      health: 'shipped',
      lastActivityAt: new Date().toISOString(),
      blockedPRCount: 0,
      tasks: [
        { status: 'completed', workers: [{ prUrl: 'https://example.test/pr/2', mergedAt: null, prLifecycleStatus: null }] },
      ],
    },
  ];

  it('missionContributions sums to one aggregate derivePendingCounts call', () => {
    const aggregate = derivePendingCounts(missionRows).get(INITIATIVE) ?? noPendingCounts();
    const perMission = missionContributions(missionRows, INITIATIVE);

    const summed = perMission.reduce<PendingCounts>(
      (acc, c) => ({
        awaitingVerification: acc.awaitingVerification + c.counts.awaitingVerification,
        blocked: acc.blocked + c.counts.blocked,
        held: acc.held + c.counts.held,
        shippedThisWeek: acc.shippedThisWeek + c.counts.shippedThisWeek,
      }),
      noPendingCounts(),
    );

    expect(summed).toEqual(aggregate);
  });

  it('chip counts equal the aggregate loader counts (AC-20, AC-29)', () => {
    const aggregate = derivePendingCounts(missionRows).get(INITIATIVE) ?? noPendingCounts();
    const chips = buildPendingChips(missionContributions(missionRows, INITIATIVE), { initiativeId: INITIATIVE });
    for (const chip of chips) {
      expect(chip.count).toBe(aggregate[chip.key]);
    }
  });
});

describe('formatVerdictEvidence (§5.1 — a verdict a reader cannot audit is a slogan)', () => {
  it('renders merges, attempts, tokens and the window', () => {
    expect(formatVerdictEvidence({ merges7d: 3, attempts7d: 11, tokens7d: 240_000 }))
      .toBe('3 merged · 11 attempts · 240k tokens · 7d');
  });

  it('is never absent — an all-zero arc still states its evidence', () => {
    expect(formatVerdictEvidence({ merges7d: 0, attempts7d: 0, tokens7d: 0 }))
      .toBe('0 merged · 0 attempts · 0 tokens · 7d');
  });

  it('states the verdict window, not the effort window', () => {
    expect(formatVerdictEvidence({ merges7d: 1, attempts7d: 1, tokens7d: 0 }))
      .toContain(`${VERDICT_WINDOW_DAYS}d`);
  });

  it('singularises one attempt without changing the number', () => {
    expect(formatVerdictEvidence({ merges7d: 1, attempts7d: 1, tokens7d: 1_000 }))
      .toBe('1 merged · 1 attempt · 1k tokens · 7d');
  });
});

describe('formatEffortTotal (§5.1 window total)', () => {
  it('AC-21: an inactive arc reads 0 tokens · 14d, never an absent element', () => {
    expect(formatEffortTotal(zeroEffortWindow())).toBe('0 tokens · 14d');
  });

  it('sums the whole window and labels its length', () => {
    const days: EffortDay[] = zeroEffortWindow().map((d, i) =>
      i >= 12 ? { ...d, tokens: 600_000 } : d,
    );
    expect(formatEffortTotal(days)).toBe('1.2M tokens · 14d');
  });

  it('labels the window from its own length, not a constant', () => {
    expect(formatEffortTotal(zeroEffortWindow())).toContain(`${EFFORT_WINDOW_DAYS}d`);
    expect(formatEffortTotal(zeroEffortWindow({ windowDays: 7 }))).toBe('0 tokens · 7d');
  });
});

describe('detail sparkline mount (§6.4, §1)', () => {
  it('mounts at ≥168×32 — the list default 84×24 is a violation here', () => {
    expect(DETAIL_SPARKLINE_WIDTH).toBeGreaterThanOrEqual(168);
    expect(DETAIL_SPARKLINE_HEIGHT).toBeGreaterThanOrEqual(32);
  });

  it('gives every one of the 14 slots more than a hairline', () => {
    expect(DETAIL_SPARKLINE_WIDTH / EFFORT_WINDOW_DAYS).toBeGreaterThan(4);
  });
});

describe('latestWorkerPerTask', () => {
  it('keeps only the newest worker, preserving the segment nuance the page had', () => {
    const tasks = [
      { id: 't-1', status: 'completed', workers: [{ status: 'completed' }, { status: 'error' }, { status: 'running' }] },
      { id: 't-2', status: 'pending', workers: [] },
      { id: 't-3', status: 'pending' },
    ];
    const out = latestWorkerPerTask(tasks as any);
    expect(out[0].workers).toEqual([{ status: 'completed' }]);
    expect(out[1].workers).toEqual([]);
    expect(out[2].workers).toEqual([]);
  });

  it('does not mutate its input', () => {
    const tasks = [{ id: 't-1', status: 'completed', workers: [{ status: 'a' }, { status: 'b' }] }];
    latestWorkerPerTask(tasks as any);
    expect(tasks[0].workers).toHaveLength(2);
  });
});

describe('verdictEvidenceAnchor (§5.1 — unverified links to the fix)', () => {
  it('points an unverified verdict at the KPI panel when the arc has KPIs', () => {
    expect(verdictEvidenceAnchor({ confidence: 'unverified', kpiCount: 2 })).toBe(KPI_ANCHOR);
  });

  it('offers no link when there is no KPI surface to land on', () => {
    expect(verdictEvidenceAnchor({ confidence: 'unverified', kpiCount: 0 })).toBeNull();
  });

  it('offers no link when the verdict is already verified', () => {
    expect(verdictEvidenceAnchor({ confidence: 'verified', kpiCount: 3 })).toBeNull();
  });
});
