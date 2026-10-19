import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { boardFixture, BOARD_T0 } from './mission-board.fixtures';
import { buildMissionEventFeed, type FeedEvent } from './mission-event-feed';
import { buildActivityEpisodes, type ActivityTaskInput, type Episode } from './activity-delivery';
import { buildMissionHistory } from './mission-history-episodes';

const MIN = 60_000;
const model = boardFixture('long-open');

function episode(over: Partial<Episode> & { id: string }): Episode {
  return {
    title: 'feat(kernel): Fold retries into the delivery', href: `/app/tasks/${over.id}`, missionId: 'mission-1', missionTitle: 'M',
    kind: 'landed', repairRounds: 1, prNumber: 7, at: BOARD_T0 + 40 * MIN,
    steps: [
      { at: BOARD_T0 + 10 * MIN, text: 'Build started', tone: 'ink', void: false },
      { at: BOARD_T0 + 20 * MIN, text: 'Built; PR #7 opened', tone: 'ink', void: false },
      { at: BOARD_T0 + 30 * MIN, text: 'Review requested changes', tone: 'error', void: false },
      { at: BOARD_T0 + 40 * MIN, text: 'Merged', tone: 'success', void: false },
    ],
    ...over,
  };
}

const ev = (i: number, kind: FeedEvent['kind'], taskId: string | null, at: number, detail = kind): FeedEvent =>
  ({ id: `e${i}`, kind, at, time: '00:00', actor: 'kernel', title: 'T', detail, taskId });

describe('buildMissionHistory', () => {
  const feed = buildMissionEventFeed({
    model,
    notes: [{ id: 'q1', type: 'question', authorType: 'agent', title: 'Retry for 4 hours or 24?', taskId: 'retry', createdAt: BOARD_T0 + 12 * MIN }],
    timeZone: 'UTC',
  });
  const all = feed.flatMap(d => d.events);

  it('All activity lists every event once, flat and chronological', () => {
    const h = buildMissionHistory({ model, feed, episodes: [], lens: 'all', timeZone: 'UTC' });
    const items = h.days.flatMap(d => d.items);
    expect(items.map(i => i.id)).toEqual(all.map(e => e.id));
    expect(h.counts.all).toBe(all.length);
    expect(h.days.reduce((n, d) => n + d.count, 0)).toBe(all.length);
  });

  it('keeps all 296 events in All activity while Highlights is a compact story (AC-1)', () => {
    const dense: FeedEvent[] = [];
    for (let i = 0; i < 296; i++) dense.push(ev(i, i % 37 === 36 ? 'merged' : 'claim', 'a', BOARD_T0 + i * MIN, '#9 merged'));
    const eps = [episode({ id: 'a' })];
    const lens = (l: 'all' | 'highlights') => buildMissionHistory({ model, feed: [{ events: dense }], episodes: eps, lens: l, timeZone: 'UTC' });
    expect(lens('all').days.flatMap(d => d.items)).toHaveLength(296);
    expect(lens('highlights').days.flatMap(d => d.items)).toHaveLength(1);
    expect(lens('highlights').counts).toEqual({ highlights: 1, all: 296 });
  });

  it('folds claims, retries and the merge into one episode with every step in order (AC-2)', () => {
    const feedEvents = [
      ev(1, 'claim', 'a', BOARD_T0 + 10 * MIN), ev(2, 'claim', 'a', BOARD_T0 + 15 * MIN), ev(3, 'pr', 'a', BOARD_T0 + 20 * MIN, 'opened PR #7'), ev(4, 'merged', 'a', BOARD_T0 + 40 * MIN, '#7 merged'),
    ];
    const args = { model, feed: [{ events: feedEvents }], episodes: [episode({ id: 'a' })], timeZone: 'UTC' };
    const hi = buildMissionHistory({ ...args, lens: 'highlights' }).days.flatMap(d => d.items);
    expect(hi).toHaveLength(1);
    expect(hi[0]).toMatchObject({ type: 'episode', headline: 'Merged', prNumber: 7, taskId: 'a' });
    if (hi[0].type === 'episode') expect(hi[0].steps.map(s => s.text)).toEqual(['Build started', 'Built; PR #7 opened', 'Review requested changes', 'Merged']);
    const all = buildMissionHistory({ ...args, lens: 'all' }).days.flatMap(d => d.items);
    expect(all.map(i => i.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('titles an episode from the task and keeps the scope as context (AC-3)', () => {
    const t = Object.values(model.tasks)[0];
    const hi = buildMissionHistory({ model, feed: [], episodes: [episode({ id: t.id })], lens: 'highlights', timeZone: 'UTC' });
    const item = hi.days[0].items[0];
    expect(item.title).toBe('Fold retries into the delivery');
    expect(item.title).not.toContain('kernel');
    expect(item.context).toBe(t.scope);
  });

  it('falls back to a plain label when the source has no title (AC-5)', () => {
    const hi = buildMissionHistory({ model, feed: [], episodes: [episode({ id: 'x', title: '' })], lens: 'highlights', timeZone: 'UTC' });
    expect(hi.days[0].items[0].title).toBe('Untitled task');
  });

  it('keeps a question, an answer and the mission end as their own highlights; claims and plans stay out', () => {
    const kinds = buildMissionHistory({ model, feed, episodes: [], lens: 'highlights', timeZone: 'UTC' }).days.flatMap(d => d.items).map(i => i.type === 'event' ? i.event.kind : 'episode');
    expect(kinds).toContain('question');
    expect(kinds).not.toContain('claim');
    expect(kinds).not.toContain('plan');
  });

  it('keeps a delivery event whose task has no episode, so the projection hiding a task loses nothing', () => {
    const feedEvents = [ev(1, 'merged', 'ghost', BOARD_T0 + MIN, '#3 merged')];
    const items = buildMissionHistory({ model, feed: [{ events: feedEvents }], episodes: [], lens: 'highlights', timeZone: 'UTC' }).days.flatMap(d => d.items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'event', prNumber: 3 });
  });

  it('the Highlights count is the number of items listed, whatever the lens', () => {
    for (const lens of ['highlights', 'all'] as const) {
      const h = buildMissionHistory({ model, feed, episodes: [episode({ id: 'a' })], lens, timeZone: 'UTC' });
      expect(h.counts.highlights).toBe(buildMissionHistory({ model, feed, episodes: [episode({ id: 'a' })], lens: 'highlights', timeZone: 'UTC' }).days.flatMap(d => d.items).length);
    }
  });
});

describe('episodes from the shared delivery projection', () => {
  const NOW = Date.parse('2026-10-08T12:00:00.000Z');
  const ago = (m: number) => new Date(NOW - m * MIN).toISOString();
  const rows: ActivityTaskInput[] = [{
    id: 'building', title: 'fix(copy): Reword the empty state', status: 'in_progress', taskClass: 'work', missionId: null, createdAt: ago(60), updatedAt: ago(1),
    workers: [{ status: 'running', startedAt: ago(5), updatedAt: ago(1) }],
  }, {
    id: 'merged', title: 'feat(kernel): Fold retries', status: 'completed', taskClass: 'work', missionId: null, createdAt: ago(90), updatedAt: ago(30),
    workers: [{ status: 'completed', prUrl: 'https://github.com/example/project/pull/2', prNumber: 2, mergedAt: ago(30), completedAt: ago(40), startedAt: ago(50) }],
  }];

  it('the all-states builder adds in-flight deliveries and leaves the finished view unchanged', () => {
    const everything = buildActivityEpisodes({ tasks: rows, missions: [], rules });
    expect(everything.map(e => e.id).sort()).toEqual(['building', 'merged']);
    expect(everything.find(e => e.id === 'merged')).toMatchObject({ prNumber: 2, kind: 'landed' });
  });
});
