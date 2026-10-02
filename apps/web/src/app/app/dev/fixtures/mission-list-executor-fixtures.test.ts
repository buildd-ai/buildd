import { describe, expect, it } from 'bun:test';
import { missionListExecutorFixture } from './mission-list-executor-fixtures';

describe('mission-list-executor fixture', () => {
  const cards = missionListExecutorFixture(Date.UTC(2026, 0, 1, 12));

  it('shows each executor reading the list must render', () => {
    expect(cards.map(c => c.model.status.label)).toEqual([
      'Local', 'Local', 'Stranded', 'Stranded', 'Stalled', 'Held', 'In CI', 'Needs you',
    ]);
    expect(cards[0].model.sentence).toContain('Waiting for a local session');
    expect(cards[5].model.kind).toBe('held');
  });

  it('stranded cards carry the runner CTA; a refused flip carries its reason', () => {
    expect(cards[2].model.strand).toMatchObject({ blockedReason: null });
    expect(cards[3].model.strand?.blockedReason).toMatch(/no workspace/);
  });

  it('dependency-blocked work is not an ask; a green PR nobody is on is', () => {
    expect(cards[6].model.sentence).toBe('1 task is waiting on #2 and #3 to merge.');
    expect(cards[6].model.ask).toBeNull();
    expect(cards[7].model.ask?.label).toMatch(/^Merge:/);
  });
});
