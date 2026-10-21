import { describe, expect, it } from 'bun:test';
import { boardFixture } from './mission-board.fixtures';
import { buildMissionEventFeed } from './mission-event-feed';
import { buildMissionHistory } from './mission-history-episodes';
import { QA_HISTORY_NOTES, qaHistoryNotes } from './mission-history-qa';

describe('QA History fixture', () => {
  const model = boardFixture('long-open');
  const feed = buildMissionEventFeed({ model: { ...model, merges: [], ciFails: [], tasks: {} } as typeof model, notes: QA_HISTORY_NOTES, timeZone: 'UTC' });

  for (const lens of ['highlights', 'all'] as const) {
    it(`renders event rows in the ${lens} lens with no mission activity`, () => {
      const items = buildMissionHistory({ model, feed, episodes: [], lens, timeZone: 'UTC' }).days.flatMap(d => d.items);
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  }

  it('is gated to development builds with the param', () => {
    expect(qaHistoryNotes('1', 'development')).toBe(QA_HISTORY_NOTES);
    expect(qaHistoryNotes('1', 'production')).toBeNull();
    expect(qaHistoryNotes(undefined, 'development')).toBeNull();
  });
});
