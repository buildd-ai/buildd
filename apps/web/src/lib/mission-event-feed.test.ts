import { describe, expect, it } from 'bun:test';
import { buildMissionEventFeed } from './mission-event-feed';
import { boardFixture, BOARD_T0 } from './mission-board.fixtures';

const MIN = 60_000;

describe('buildMissionEventFeed — a mission open for weeks', () => {
  const model = boardFixture('long-open');
  const days = buildMissionEventFeed({
    model,
    notes: [
      { id: 'q1', type: 'question', authorType: 'agent', title: 'Retry for 4 hours or 24?', taskId: 'retry', createdAt: BOARD_T0 + 12 * MIN },
      { id: 'a1', type: 'reply', authorType: 'user', title: '24 hours', taskId: 'retry', createdAt: BOARD_T0 + 15 * MIN },
      { id: 'n1', type: 'decision', authorType: 'agent', title: 'Plan', taskId: null, createdAt: BOARD_T0 + 2 * MIN },
    ],
    completionText: 'Webhooks retry for a day, then park.',
    timeZone: 'UTC',
  });
  const all = days.flatMap(d => d.events);

  it('is chronological, one group per day, and says how long it went quiet', () => {
    const ats = all.map(e => e.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(days[0].label).toBe('Jan 1');
    expect(days.map(d => d.quietDays).some(q => q >= 20)).toBe(true);
  });

  it('carries claimed, PR opened, escalated, answered, merged and completed', () => {
    const kinds = new Set(all.map(e => e.kind));
    for (const k of ['claim', 'pr', 'question', 'answered', 'merged', 'mission'] as const) expect(kinds.has(k)).toBe(true);
    expect(all.find(e => e.kind === 'question')!.detail).toBe('escalated to you: Retry for 4 hours or 24?');
    expect(all.find(e => e.kind === 'answered')).toMatchObject({ actor: 'you', detail: 'answered: 24 hours', taskId: 'retry' });
    expect(all[all.length - 1]).toMatchObject({ kind: 'mission', detail: 'completed · Webhooks retry for a day, then park.' });
  });

  it('names the friction report as such, and leaves other agent notes out', () => {
    expect(all.find(e => e.kind === 'friction')).toMatchObject({ actor: 'no admin API', detail: 'friction report filed · not mission work' });
    expect(all.some(e => e.id === 'note:n1')).toBe(false);
    expect(all.find(e => e.id.startsWith('side-end:'))).toMatchObject({ kind: 'failed', detail: 'friction run orphaned; its runner went away' });
  });

  it('formats times in the given zone', () => {
    expect(all.find(e => e.kind === 'question')!.time).toBe('12:12');
  });

  it('groups by the team zone’s calendar day', () => {
    // UTC+14: the mission's first minutes fall on the next calendar day there.
    const ahead = buildMissionEventFeed({ model, timeZone: 'Pacific/Kiritimati' });
    expect(ahead[0].key).toBe(new Date(BOARD_T0 + 14 * 3_600_000).toISOString().slice(0, 10));
  });
});
