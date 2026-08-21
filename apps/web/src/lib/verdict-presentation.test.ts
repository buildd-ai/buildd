import { describe, it, expect } from 'bun:test';
import {
  partitionInitiativeZones,
  verdictChip,
  VERDICT_LABEL,
  NOT_WINNING_ORDER,
  type InitiativePulse,
  type Verdict,
} from './verdict-presentation';

function pulse(id: string, verdict: Verdict, partial: Partial<InitiativePulse> = {}): InitiativePulse {
  return {
    id,
    title: id,
    progress: 50,
    effortDays: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-08-${String(i + 3).padStart(2, '0')}`,
      tokens: 0,
      merged: 0,
      failed: 0,
      open: 0,
    })),
    awaitingVerification: 0,
    blocked: 0,
    held: 0,
    shippedThisWeek: 0,
    verdict,
    confidence: 'unverified',
    merges7d: 0,
    attempts7d: 0,
    tokens7d: 0,
    criteriaFail: 0,
    completedMissions: 0,
    totalMissions: 2,
    completedTasks: 0,
    totalTasks: 4,
    ...partial,
  };
}

const ids = (items: InitiativePulse[]) => items.map((i) => i.id);

describe('partitionInitiativeZones', () => {
  // AC-14a
  it('puts a losing arc first, ahead of every other not-winning verdict', () => {
    const zones = partitionInitiativeZones([
      pulse('stuck', 'stuck', { held: 9 }),
      pulse('grinding', 'grinding'),
      pulse('losing', 'losing'),
      pulse('ready', 'won_unclaimed'),
    ]);

    // Ladder order, and pending count cannot promote a lesser verdict past it:
    // the stuck arc has nine held missions and still sorts third.
    expect(ids(zones.notWinning)).toEqual(['losing', 'grinding', 'stuck', 'ready']);
    expect(zones.notWinning[0].verdict).toBe('losing');
  });

  // AC-14
  it('separates not-winning from winning', () => {
    const zones = partitionInitiativeZones([
      pulse('b', 'winning', { merges7d: 4 }),
      pulse('a', 'stuck', { awaitingVerification: 2, blocked: 1 }),
    ]);

    expect(ids(zones.notWinning)).toEqual(['a']);
    expect(ids(zones.winning)).toEqual(['b']);
  });

  it('breaks a verdict tie by pending count, then by progress', () => {
    const zones = partitionInitiativeZones([
      pulse('few', 'stuck', { blocked: 1, progress: 90 }),
      pulse('many', 'stuck', { blocked: 3, progress: 10 }),
      pulse('tie-low', 'stuck', { blocked: 1, progress: 20 }),
    ]);

    expect(ids(zones.notWinning)).toEqual(['many', 'few', 'tie-low']);
  });

  it('sorts the winning zone by merges, then by window tokens', () => {
    const busy = pulse('busy', 'winning', { merges7d: 1 });
    busy.effortDays = busy.effortDays.map((d) => ({ ...d, tokens: 1000 }));

    const zones = partitionInitiativeZones([
      pulse('quiet', 'winning', { merges7d: 1 }),
      pulse('shipper', 'winning', { merges7d: 5 }),
      busy,
    ]);

    expect(ids(zones.winning)).toEqual(['shipper', 'busy', 'quiet']);
  });

  // AC-15
  it('routes dormant and empty arcs out of both visible zones', () => {
    const zones = partitionInitiativeZones([
      pulse('sleeping', 'dormant'),
      pulse('nothing', 'empty'),
      pulse('active', 'winning'),
    ]);

    expect(ids(zones.dormant).sort()).toEqual(['nothing', 'sleeping']);
    expect(ids(zones.notWinning)).toEqual([]);
    expect(ids(zones.winning)).toEqual(['active']);
  });

  // AC-18
  it('returns three empty zones for no initiatives', () => {
    const zones = partitionInitiativeZones([]);
    expect(zones).toEqual({ notWinning: [], winning: [], dormant: [] });
  });

  it('does not mutate or reorder its input', () => {
    const items = [pulse('z', 'winning'), pulse('a', 'losing')];
    const before = ids(items);

    partitionInitiativeZones(items);

    expect(ids(items)).toEqual(before);
  });

  it('assigns every verdict to exactly one zone', () => {
    const all = (Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => pulse(v, v));
    const zones = partitionInitiativeZones(all);
    const placed = [...zones.notWinning, ...zones.winning, ...zones.dormant];

    expect(placed).toHaveLength(all.length);
    expect(new Set(ids(placed)).size).toBe(all.length);
  });
});

describe('verdictChip', () => {
  it('gives every verdict its spec label', () => {
    for (const verdict of Object.keys(VERDICT_LABEL) as Verdict[]) {
      expect(verdictChip(verdict).label).toBe(VERDICT_LABEL[verdict]);
    }
  });

  it('reserves the error palette for losing alone', () => {
    // If three verdicts shouted, none would.
    const loud = (Object.keys(VERDICT_LABEL) as Verdict[]).filter((v) =>
      verdictChip(v).className.includes('bg-status-error'),
    );
    expect(loud).toEqual(['losing']);
  });

  it('uses only palette tokens, never raw hex', () => {
    for (const verdict of Object.keys(VERDICT_LABEL) as Verdict[]) {
      expect(verdictChip(verdict).className).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});

describe('NOT_WINNING_ORDER', () => {
  it('is the ladder order from §6.5', () => {
    expect(NOT_WINNING_ORDER).toEqual(['losing', 'grinding', 'stuck', 'won_unclaimed']);
  });
});
