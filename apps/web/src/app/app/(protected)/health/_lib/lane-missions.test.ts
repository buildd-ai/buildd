import { describe, expect, it } from 'bun:test';
import type { FleetSnapshot } from '@buildd/shared';
import { laneMissionIds, summarizeLaneMissions } from './lane-missions';

describe('laneMissionIds', () => {
  it('the distinct missions of every bar in the window, standalone bars skipped', () => {
    const bar = (id: string, missionId: string | null) => ({ id, start: 0, end: 1, label: id, color: null, state: 'done', missionId });
    const fleet = {
      runners: [{ slots: [{ lane: { bars: [bar('a', 'm1'), bar('b', null)] } }, { lane: { bars: [bar('c', 'm1'), bar('d', 'm2')] } }] }],
      sessions: { slots: [{ lane: { bars: [bar('e', 'm3')] } }] },
    } as unknown as FleetSnapshot;
    expect(laneMissionIds(fleet).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('summarizeLaneMissions', () => {
  it('title and the Missions list\'s landed count per mission', () => {
    const merged = { status: 'completed', prUrl: 'https://github.com/o/r/pull/1', mergedAt: new Date(0) };
    const out = summarizeLaneMissions([{
      id: 'm1', title: 'Delivery UX', status: 'active', isHeld: false, integrationBranchEnabled: false,
      tasks: [
        { id: 't1', title: 'feat: a', status: 'completed', workers: [merged] },
        { id: 't2', title: 'feat: b', status: 'pending', workers: [] },
        { id: 't3', title: 'feat: c', status: 'cancelled', workers: [] },
      ],
    }]);
    expect(out).toEqual({ m1: { title: 'Delivery UX', landed: 1, total: 2 } });
  });
});
