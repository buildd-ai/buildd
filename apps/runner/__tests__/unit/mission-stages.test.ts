import { describe, it, expect, mock } from 'bun:test';
import { attachMissionStages, listedMissionIds, readTaskListWithStages, withMissionStages } from '../../src/mission-stages';

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

describe('one combined read for top (spec 3ef37387 AC-5)', () => {
  const realFetch = globalThis.fetch;
  const client = async () => {
    const { BuilddClient } = await import('../../src/buildd');
    return new BuilddClient({ apiKey: 'bld_test', builddServer: 'http://127.0.0.1:1' } as any);
  };
  const answer = (body: unknown, urls: string[]) => (async (url: string) => {
    urls.push(String(url));
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body };
  }) as any;

  it('asks the task list with its missions\' stages in the same request', async () => {
    const urls: string[] = [];
    globalThis.fetch = answer({ tasks: [{ id: 't1' }], missionStages: { m1: verifying } }, urls);
    try {
      const out = await (await client()).listTasksWithStages();
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/api/tasks?include=missionStages');
      expect(out).toEqual({ tasks: [{ id: 't1' }] as any, missionStages: { m1: verifying } });
    } finally { globalThis.fetch = realFetch; }
  });

  it('an older server answers without stages: null, so the caller asks for them separately', async () => {
    const urls: string[] = [];
    globalThis.fetch = answer({ tasks: [] }, urls);
    try {
      expect((await (await client()).listTasksWithStages()).missionStages).toBeNull();
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('openMissionIds', () => {
  it('watches open missions only, not the delivered ones', async () => {
    const { openMissionIds } = await import('../../src/mission-stages');
    expect(openMissionIds([
      { id: 'open', status: 'active', completedAt: null },
      { id: 'done', status: 'completed', completedAt: '2026-10-18T10:00:00Z' },
      { id: 'arch', status: 'archived', completedAt: null },
      { id: 7 as any, status: 'active', completedAt: null },
    ])).toEqual(['open']);
  });
});

describe('readTaskListWithStages', () => {
  it('one read when the server sends the stages with the list', async () => {
    let stageReads = 0;
    const tasks = await readTaskListWithStages({
      listTasksWithStages: async () => ({ tasks: [{ id: 't', missionId: 'm', mission: { id: 'm' } }], missionStages: { m: { step: 'building' } } }),
      listMissionStages: async () => { stageReads++; return {}; },
    });
    expect(tasks[0].mission.stage).toEqual({ step: 'building' });
    expect(stageReads).toBe(0);
  });
  it('an older server without the include: the stages are asked separately', async () => {
    const asked: string[][] = [];
    const tasks = await readTaskListWithStages({
      listTasksWithStages: async () => ({ tasks: [{ id: 't', missionId: 'm', mission: { id: 'm' } }], missionStages: null }),
      listMissionStages: async (ids: string[]) => { asked.push(ids); return { m: { step: 'verifying' } }; },
    });
    expect(asked).toEqual([['m']]);
    expect(tasks[0].mission.stage).toEqual({ step: 'verifying' });
  });
});
