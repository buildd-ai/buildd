import { describe, expect, it } from 'bun:test';
import type { Episode } from '@/lib/activity-delivery';
import { dayTally, groupEpisodesByDay } from './history-days';

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

  it('shows only the page asked for, and a day’s tally still counts its hidden episodes', () => {
    const days = groupEpisodesByDay(eps, 1, NOW, 'UTC');
    expect(days).toHaveLength(1);
    expect(days[0].episodes.map(e => e.id)).toEqual(['a']);
    expect(days[0].tally).toBe('2 landed · 1 repaired');
  });
});

describe('dayTally', () => {
  it('names landed, repaired and sent to you, leaving zeros out', () => {
    expect(dayTally([ep('a', 1), ep('b', 1, { kind: 'needs', repairRounds: 1 })])).toBe('1 landed · 1 repaired · 1 to you');
  });
  it('falls back to a plain count when none of those apply', () => {
    expect(dayTally([ep('a', 1, { kind: 'notlanded' })])).toBe('1 delivery');
  });
});
