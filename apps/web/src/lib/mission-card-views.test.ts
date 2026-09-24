/**
 * loadMissionCardViews: one batched steering read, capped to the missions the
 * surface shows (docs/design/mission-feed-mobile-continuity.md, S5).
 * Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';

const calls: string[][] = [];
mock.module('./mission-steering-notes', () => ({
  loadHumanSteeringMarksByMission: async (ids: string[]) => {
    calls.push(ids);
    return new Map();
  },
}));

const { loadMissionCardViews, MISSION_CARD_VIEW_CAP } = await import('./mission-card-views');

const row = (id: string, status = 'active') => ({
  id,
  title: `Mission ${id}`,
  status,
  tasks: [{
    id: `${id}-t`, title: 'Work', status: 'in_progress', taskClass: 'work', createdAt: new Date(),
    workers: [{ id: `${id}-w`, status: 'running', startedAt: new Date(Date.now() - 60_000) }],
  }],
});

describe('loadMissionCardViews', () => {
  it('reads steering once for the unfinished visible missions and builds a view per mission', async () => {
    calls.length = 0;
    const views = await loadMissionCardViews([row('a'), row('b'), row('c', 'completed')], { from: 'home' });
    expect(calls).toEqual([['a', 'b']]);
    expect([...views.keys()]).toEqual(['a', 'b', 'c']);
    expect(views.get('a')!.flightStrip).not.toBeNull();
    expect(views.get('c')!.compact).toBe(true);
    expect(views.get('a')!.href).toBe('/app/missions/a?from=home');
  });

  it('never builds more than the cap', async () => {
    calls.length = 0;
    const many = Array.from({ length: MISSION_CARD_VIEW_CAP + 5 }, (_, i) => row(`m${i}`));
    const views = await loadMissionCardViews(many, { from: 'home' });
    expect(views.size).toBe(MISSION_CARD_VIEW_CAP);
    expect(calls[0]).toHaveLength(MISSION_CARD_VIEW_CAP);
  });

  it('skips the read entirely when nothing visible is unfinished', async () => {
    calls.length = 0;
    await loadMissionCardViews([row('x', 'completed')], { from: 'missions' });
    expect(calls).toEqual([]);
  });
});

describe('card query shape', () => {
  it('the nested workers are latest-first, so the live attempt is inside the limit', () => {
    const { MISSION_CARD_WORKERS_WITH } = require('./mission-card-views');
    expect(MISSION_CARD_WORKERS_WITH.limit).toBe(5);
    const order = MISSION_CARD_WORKERS_WITH.orderBy(
      { startedAt: 'startedAt', updatedAt: 'updatedAt' },
      { desc: (c: string) => `${c} desc` },
    );
    expect(order).toEqual(['startedAt desc', 'updatedAt desc']);
  });

  it('the card task columns carry no task.result jsonb', () => {
    const { MISSION_CARD_TASK_COLUMNS } = require('./mission-card-views');
    expect('result' in MISSION_CARD_TASK_COLUMNS).toBe(false);
  });
});
