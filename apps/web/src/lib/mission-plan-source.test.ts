import { describe, expect, it } from 'bun:test';
import { missionPlanInputs, planBlock } from './mission-plan-source';

describe('planBlock', () => {
  it('a mission the list files under Needs you waits on you; held is held; the rest are free', () => {
    expect(planBlock('needs', false)).toBe('you');
    expect(planBlock('notlanded', false)).toBe('you');
    expect(planBlock('held', false)).toBe('held');
    expect(planBlock('build', true)).toBe('held');
    expect(planBlock('build', false)).toBeNull();
    expect(planBlock('waiting', false)).toBeNull();
  });
});

describe('missionPlanInputs', () => {
  it('carries the newest estimate, first run and merge time onto each task', () => {
    const [m] = missionPlanInputs([{
      id: 'm1', title: 'M', workspaceId: 'w', dependsOnMissionId: 'm0', isHeld: false,
      tasks: [
        { id: 't1', status: 'completed', dependsOn: null, updatedAt: '2026-10-06T10:00:00Z', workers: [{ startedAt: '2026-10-06T08:00:00Z', completedAt: '2026-10-06T09:00:00Z' }] },
        { id: 't2', status: 'pending', dependsOn: ['t1'], updatedAt: null },
      ],
    }], new Map([['t2', { p50Minutes: 30, p80Minutes: 60 }]]), new Map([['m1', 'build']]));
    expect(m).toMatchObject({ href: '/app/missions/m1', blocked: null, dependsOnMissionId: 'm0' });
    expect(m.tasks[0]).toMatchObject({ startedAt: Date.parse('2026-10-06T08:00:00Z'), endedAt: Date.parse('2026-10-06T09:00:00Z'), p50Minutes: null });
    expect(m.tasks[1]).toMatchObject({ startedAt: null, endedAt: null, dependsOn: ['t1'], p50Minutes: 30, p80Minutes: 60 });
  });
});
