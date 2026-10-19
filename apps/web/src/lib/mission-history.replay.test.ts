/**
 * Replay: the activity-delivery fixture's one delivery (claim → build → PR →
 * review asks for changes → automatic repair → late stale approval → renewed
 * approval → merge), step by step, read through Mission History's two lenses.
 * The fixture rows are the same ones Activity's replay uses; nothing here
 * derives delivery state, it only checks what the lenses make of it.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import { ACTIVITY_SEQUENCE, activityFixture } from '@/app/app/dev/fixtures/activity-delivery-fixtures';
import { buildActivityEpisodes } from './activity-delivery';
import { buildMissionHistory, type HistoryItem } from './mission-history-episodes';
import type { FeedEvent } from './mission-event-feed';
import { boardFixture, BOARD_T0 } from './mission-board.fixtures';

const MIN = 60_000;
const model = boardFixture('long-open');
const BILLING = 'fx-billing';

function episodesAt(step: number) {
  const f = activityFixture(step);
  return buildActivityEpisodes({
    tasks: f.tasks.filter(t => t.missionId === BILLING),
    missions: f.missions.filter(m => m.id === BILLING),
    rules,
  }).filter(e => e.id === 'fx-t34');
}

const ev = (i: number, kind: FeedEvent['kind'], taskId: string | null, at: number, over: Partial<FeedEvent> = {}): FeedEvent =>
  ({ id: `e${i}`, kind, at, time: '00:00', actor: 'kernel', title: 'T', detail: kind, taskId, ...over });

const items = (h: ReturnType<typeof buildMissionHistory>): HistoryItem[] => h.days.flatMap(d => d.items);
const history = (lens: 'highlights' | 'all', events: FeedEvent[], episodes = episodesAt(7)) =>
  buildMissionHistory({ model, feed: [{ events }], episodes, lens, timeZone: 'UTC' });

describe('replay: claim → retries → PR → review → merge in Mission History', () => {
  it('Highlights keeps one story for the delivery at every step, its steps only growing at the end', () => {
    let prev: string[] = [];
    for (let s = 0; s < ACTIVITY_SEQUENCE.length; s++) {
      const eps = episodesAt(s).filter(e => e.id === 'fx-t34');
      expect(`${ACTIVITY_SEQUENCE[s]}: ${eps.length}`).toBe(`${ACTIVITY_SEQUENCE[s]}: 1`);
      const hi = items(history('highlights', [], eps)).filter(i => i.type === 'episode');
      expect(hi).toHaveLength(1);
      const steps = hi[0].type === 'episode' ? hi[0].steps.map(x => x.text) : [];
      expect(steps.slice(0, prev.length)).toEqual(prev);
      prev = steps;
    }
    expect(prev[prev.length - 1]).toBe('Merged');
  });

  it('the episode lists its steps in chronological order and heads with the newest', () => {
    const hi = items(history('highlights', [])).find(i => i.type === 'episode' && i.taskId === 'fx-t34')!;
    if (hi.type !== 'episode') throw new Error('unreachable');
    const ats = hi.steps.map(x => x.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(hi.headline).toBe(hi.steps[hi.steps.length - 1].text);
    expect(hi.deliveryKind).toBe('landed');
    expect(hi.prNumber).toBe(34);
  });

  it('a late approval for a superseded head stays visible as a struck step on a delivery that has not landed', () => {
    const hi = items(history('highlights', [], episodesAt(5))).find(i => i.type === 'episode' && i.taskId === 'fx-t34')!;
    if (hi.type !== 'episode') throw new Error('unreachable');
    const late = hi.steps.find(x => x.text.startsWith('Late approval'))!;
    expect(late.void).toBe(true);
    // Voided steps are not counted toward anything: the delivery is still not landed.
    expect(hi.deliveryKind).not.toBe('landed');
  });

  it('All activity folds nothing: claims, retries and the merge are separate rows, in time order', () => {
    const events = [
      ev(1, 'claim', 'fx-t34', BOARD_T0 + 1 * MIN), ev(2, 'claim', 'fx-t34', BOARD_T0 + 2 * MIN, { retry: true, nest: true }),
      ev(3, 'pr', 'fx-t34', BOARD_T0 + 3 * MIN, { detail: 'opened PR #34' }), ev(4, 'merged', 'fx-t34', BOARD_T0 + 4 * MIN, { detail: '#34 merged' }),
    ];
    const all = items(history('all', events));
    expect(all.map(i => i.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(items(history('highlights', events)).filter(i => i.type === 'event')).toHaveLength(0);
  });
});

describe('replay: owner action versus non-action', () => {
  const events = [
    ev(1, 'claim', 'fx-t34', BOARD_T0 + MIN),
    ev(2, 'failed', 'fx-t34', BOARD_T0 + 2 * MIN, { nest: true, detail: 'CI failed' }),
    ev(3, 'question', null, BOARD_T0 + 3 * MIN, { detail: 'escalated to you: Retry for 4 hours or 24?' }),
    ev(4, 'answered', null, BOARD_T0 + 4 * MIN, { detail: 'answered' }),
    ev(5, 'friction', null, BOARD_T0 + 5 * MIN),
  ];

  it('only the question, the answer and the end are standalone highlights; retries, CI and friction fold or stay in All', () => {
    const kinds = items(history('highlights', events)).map(i => (i.type === 'event' ? i.event.kind : 'episode'));
    expect(kinds).toContain('question');
    expect(kinds).toContain('answered');
    for (const k of ['claim', 'friction', 'plan']) expect(kinds).not.toContain(k);
    // A CI failure of a task that has an episode is a step of it, not a second row.
    expect(kinds).not.toContain('failed');
  });

  it('counts are of what each lens lists', () => {
    const h = history('highlights', events);
    expect(h.counts.all).toBe(events.length);
    expect(h.counts.highlights).toBe(items(h).length);
    expect(items(history('all', events))).toHaveLength(h.counts.all);
  });
});

describe('replay: title provenance', () => {
  it('a title is the task\'s own, with the scope as context; an untitled task gets a plain label, never generated text', () => {
    const [real] = episodesAt(7).filter(e => e.id === 'fx-t34');
    const hi = items(history('highlights', [], [real, { ...real, id: 'untitled', title: '' }]));
    const titled = hi.find(i => i.id === 'episode:fx-t34')!;
    expect(titled.title).toBe('Scheduled export email');
    expect(titled.title).not.toContain('feat');
    expect(hi.find(i => i.id === 'episode:untitled')!.title).toBe('Untitled task');
  });
});

describe('replay: density (296 events)', () => {
  const dense = Array.from({ length: 296 }, (_, i) => ev(i, i % 37 === 36 ? 'merged' : 'claim', 'fx-t34', BOARD_T0 + i * MIN, { detail: '#34 merged' }));

  it('All activity lists every one once, chronologically, with day counts that add up', () => {
    const h = history('all', dense);
    const all = items(h);
    expect(all).toHaveLength(296);
    expect(new Set(all.map(i => i.id)).size).toBe(296);
    expect(all.map(i => i.at)).toEqual([...all.map(i => i.at)].sort((a, b) => a - b));
    expect(h.days.reduce((n, d) => n + d.count, 0)).toBe(296);
    expect(h.counts.all).toBe(296);
  });

  it('Highlights stays a handful: the delivery is one story whatever the event volume', () => {
    const h = history('highlights', dense);
    expect(items(h)).toHaveLength(1);
    expect(h.counts).toEqual({ highlights: 1, all: 296 });
  });
});
