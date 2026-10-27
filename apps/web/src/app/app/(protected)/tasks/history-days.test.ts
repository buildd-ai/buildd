import { describe, expect, it } from 'bun:test';
import type { Episode } from '@/lib/activity-delivery';
import { barOf, dayTotals, groupEpisodesByDay, outcomeOf } from './history-days';

const NOW = Date.parse('2026-10-09T15:00:00Z');
const H = 3_600_000;
function ep(id: string, hoursAgo: number, over: Partial<Episode> = {}): Episode {
  return { id, title: id, href: `/app/tasks/${id}`, missionId: null, missionTitle: null, kind: 'landed', repairRounds: 0, at: NOW - hoursAgo * H, steps: [], ...over };
}

describe('groupEpisodesByDay', () => {
  const eps = [ep('a', 1), ep('b', 2, { repairRounds: 2 }), ep('c', 20, { kind: 'needs' }), ep('d', 50), ep('e', 51, { kind: 'notlanded' })];

  it('cuts episodes into local days, newest first, labelled Today / Yesterday / a date', () => {
    const days = groupEpisodesByDay(eps, 10, NOW, 'UTC');
    expect(days.map(d => d.label)).toEqual(['Today', 'Yesterday', 'Wed, Oct 7']);
    expect(days.map(d => d.episodes.map(e => e.id))).toEqual([['a', 'b'], ['c'], ['d', 'e']]);
  });

  it('uses the reader’s time zone, not the server’s', () => {
    // 14h before 15:00Z is 01:00Z today, but still 18:00 the previous evening in Los Angeles.
    expect(groupEpisodesByDay([ep('x', 14)], 10, NOW, 'UTC')[0].label).toBe('Today');
    expect(groupEpisodesByDay([ep('x', 14)], 10, NOW, 'America/Los_Angeles')[0].label).toBe('Yesterday');
  });

  it('pages by whole days, so a day\u2019s totals are always the bars shown', () => {
    const days = groupEpisodesByDay(eps, 1, NOW, 'UTC');
    expect(days).toHaveLength(1);
    expect(days[0].episodes.map(e => e.id)).toEqual(['a', 'b']);
    expect(days[0].totals).toEqual({ merged: 2, retried: 1, review: 0, closed: 0 });
  });

  it('gives a creation event no bar', () => {
    const days = groupEpisodesByDay([ep('m', 1, { event: 'created' }), ep('a', 2)], 10, NOW, 'UTC');
    expect(days[0].episodes.map(e => e.id)).toEqual(['a']);
  });
});

describe('dayTotals', () => {
  it('equals the bars by end mark; retried counts bars with a fix round', () => {
    const list = [ep('a', 1), ep('b', 1, { kind: 'needs', repairRounds: 1 }), ep('c', 1, { kind: 'notlanded' })];
    expect(dayTotals(list)).toEqual({ merged: 1, retried: 1, review: 1, closed: 1 });
    expect(list.map(outcomeOf)).toEqual(['delivered', 'came-to-you', 'not-delivered']);
  });
});

describe('barOf', () => {
  it('puts the start, fix ticks and end on the day axis', () => {
    const e = ep('a', 1, { steps: [
      { at: NOW - 3 * H, text: 'Build started', tone: 'ink', void: false },
      { at: NOW - 2 * H, text: 'Automatic repair 1', tone: 'warning', void: false, repair: true },
      { at: NOW - 1.5 * H, text: 'Repair 1 failed', tone: 'error', void: false, repair: true },
    ] });
    const axis = { from: NOW - 4 * H, to: NOW };
    const b = barOf(e, axis);
    expect(b.start).toBeCloseTo(0.25);
    expect(b.end).toBeCloseTo(0.75);
    expect(b.fixRounds).toEqual([0.5]);
    expect(b.outcome).toBe('delivered');
  });
});
