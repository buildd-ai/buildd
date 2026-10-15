import { describe, expect, it } from 'bun:test';
import { countQuietMissions, quietMissionCauses, type MissionDelivery } from './delivery-projection';

// Spec 8e137fdb I-4: Home names the real hold of each quiet mission, never an invented one.
const m = (over: Partial<MissionDelivery>): MissionDelivery => ({
  id: over.id ?? 'm', title: 't', href: '/m', kind: 'waiting', open: true, landed: 0, total: 1, inAudit: 0,
  executing: false, repairRounds: 0,
  milestones: { agentsDone: true, allLanded: false, onTrunk: null, complete: false, released: null },
  focus: null, evidence: '', next: 'Next in line for a runner', exception: null, visual: null, tasks: [], ...over,
});

describe('quietMissionCauses', () => {
  it('groups the quiet missions by what each waits on, largest group first', () => {
    const causes = quietMissionCauses([
      m({ id: 'a' }),
      m({ id: 'b' }),
      m({ id: 'c', visualOpen: { text: 'Visual review unable to run', hold: 'it needs a runner with a browser' } }),
      m({ id: 'd', kind: 'planning', next: 'A plan' }),
    ]);
    expect(causes).toEqual([
      { cause: 'next in line for a runner', count: 2 },
      { cause: 'waiting on visual review', count: 1 },
      { cause: 'being planned', count: 1 },
    ]);
  });

  it('names dependency, local-session and held waits by their own cause', () => {
    const causes = quietMissionCauses([
      m({ id: 'a', next: 'After its dependencies land' }),
      m({ id: 'b', next: 'Waiting for a local session (none for 33h)' }),
      m({ id: 'c', kind: 'held', next: 'Starts when armed' }),
    ]).map(c => c.cause);
    expect(causes).toEqual(['waiting on earlier work', 'waiting for a local session', 'held by their owner']);
  });

  it('never says capacity or another mission', () => {
    const all = quietMissionCauses([m({}), m({ kind: 'planning' }), m({ kind: 'held' })]).map(c => c.cause).join(' ');
    expect(all).not.toContain('capacity');
    expect(all).not.toContain('another mission');
  });

  it('counts exactly the missions countQuietMissions counts', () => {
    const list = [m({}), m({ kind: 'landed' }), m({ kind: 'build' }), m({ kind: 'planning' }), m({ open: false })];
    const total = quietMissionCauses(list).reduce((n, c) => n + c.count, 0);
    expect(total).toBe(countQuietMissions(list));
    expect(total).toBe(2);
  });
});
