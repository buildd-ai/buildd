import { describe, expect, it } from 'bun:test';
import { missionListExecutorFixture } from './mission-list-executor-fixtures';

describe('mission-list-executor fixture', () => {
  const cards = missionListExecutorFixture(Date.UTC(2026, 0, 1, 12));

  it('shows each executor reading the list must render', () => {
    expect(cards.map(c => c.model.status.label)).toEqual(['Local', 'Local', 'Stalled', 'Held']);
    expect(cards[0].model.sentence).toContain('Waiting for a local session');
    expect(cards[3].model.kind).toBe('held');
  });
});
