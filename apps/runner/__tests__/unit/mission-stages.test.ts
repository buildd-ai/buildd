import { describe, it, expect, mock } from 'bun:test';
import { attachMissionStages, listedMissionIds, withMissionStages } from '../../src/mission-stages';

const verifying = { step: 'verifying' as const, waitingOn: 'Unit tests pass: not checked' };

const tasks = () => [
  { id: 't1', missionId: 'm1', mission: { id: 'm1', title: 'One', taskCounts: { done: 1, total: 3 } } },
  { id: 't2', missionId: 'm2', mission: { id: 'm2', title: 'Two' } },
  { id: 't3', missionId: 'm1', mission: { id: 'm1', title: 'One' } },
  { id: 't4', missionId: null, mission: null },
];

describe('mission stages on the runner task list (R-18)', () => {
  it('asks for each listed mission once', () => {
    expect(listedMissionIds(tasks())).toEqual(['m1', 'm2']);
  });

  it('puts the stage on every task of a mission that has one, and nowhere else', () => {
    const out = attachMissionStages(tasks(), { m1: verifying });
    expect((out[0]!.mission as any).stage).toEqual(verifying);
    expect((out[0]!.mission as any).taskCounts).toEqual({ done: 1, total: 3 });
    expect((out[2]!.mission as any).stage).toEqual(verifying);
    expect((out[1]!.mission as any).stage).toBeUndefined();
    expect(out[3]!.mission).toBeNull();
  });

  it('fetches the stages of exactly the listed missions', async () => {
    const load = mock(async (_ids: string[]) => ({ m2: { step: 'delivered' as const, waitingOn: null } }));
    const out = await withMissionStages(tasks(), load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toEqual(['m1', 'm2']);
    expect((out[1]!.mission as any).stage).toEqual({ step: 'delivered', waitingOn: null });
  });

  it('a list with no missions asks for nothing', async () => {
    const load = mock(async () => ({}));
    await withMissionStages([{ id: 't', missionId: null, mission: null }], load);
    expect(load).not.toHaveBeenCalled();
  });

  it('a failed stage read leaves the list as it was, without stage', async () => {
    const before = tasks();
    const out = await withMissionStages(before, async () => { throw new Error('404 from an older server'); });
    expect(out).toEqual(tasks());
  });
});
