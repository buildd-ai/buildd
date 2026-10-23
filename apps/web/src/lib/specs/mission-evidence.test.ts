import { describe, expect, it } from 'bun:test';
import { loadMissionEvidence, repairFor, type MissionEvidenceDeps } from './mission-evidence';

const at = new Date('2026-10-23T10:00:00Z');

/** Deps that record every call, each returning nothing unless overridden. */
function deps(over: Partial<MissionEvidenceDeps> = {}) {
  const calls: Record<keyof MissionEvidenceDeps, unknown[]> = { verdictRows: [], repairRows: [], workerRows: [], deliveryRows: [] };
  const record = <K extends keyof MissionEvidenceDeps>(k: K) => (async (arg: never) => {
    calls[k].push(arg);
    return over[k] ? (over[k] as (a: never) => Promise<unknown>)(arg) : [];
  }) as unknown as MissionEvidenceDeps[K];
  const d: MissionEvidenceDeps = { verdictRows: record('verdictRows'), repairRows: record('repairRows'), workerRows: record('workerRows'), deliveryRows: record('deliveryRows') };
  return { deps: d, calls };
}

describe('loadMissionEvidence', () => {
  it('maps each cited verdict to its evidence in one read, whatever the number of criteria', async () => {
    const { deps: d, calls } = deps({
      verdictRows: async (ids) => ids.map((id, i) => ({
        id,
        verdict: i === 0 ? 'fail' : 'pass',
        createdAt: at,
        evidence: i === 0
          ? { kind: 'acceptance-test', exitCode: 1, stdout: 'x'.repeat(3000) + 'expected 3 got 2', recordedBy: 'check:acceptance:R-1', refs: [{ kind: 'artifact', ref: 'a1' }], readIds: ['r1'] }
          : { observed: '  Shows the list  ', recordedBy: 'final-verification:t-fv', refs: 'junk' },
      })),
    });
    const standings = [
      { standings: [{ criterionId: 'R-1', standing: 'fail', verdictId: 'v1' }, { criterionId: 'R-2', standing: 'pass', verdictId: 'v2' }, { criterionId: 'R-3', standing: 'missing' }] },
      { standings: [{ criterionId: 'AC-1', standing: 'pass', verdictId: 'v2' }] },
    ] as any;
    const e = await loadMissionEvidence('m', standings, d);
    expect(calls.verdictRows).toEqual([['v1', 'v2']]);
    const v1 = e.verdicts.get('v1')!;
    expect(v1).toMatchObject({ verdictId: 'v1', result: 'fail', observed: null, readIds: ['r1'], recordedBy: 'check:acceptance:R-1', at: at.toISOString() });
    expect(v1.refs).toEqual([{ kind: 'artifact', ref: 'a1' }]);
    expect(v1.stdoutExcerpt!.length).toBe(2000);
    expect(v1.stdoutExcerpt!.endsWith('expected 3 got 2')).toBe(true);
    expect(e.verdicts.get('v2')).toMatchObject({ result: 'pass', observed: 'Shows the list', refs: [], readIds: [], stdoutExcerpt: null });
  });

  it('reads no verdicts when no criterion has one, and no workers or PRs when no repair is in play', async () => {
    const { deps: d, calls } = deps();
    const e = await loadMissionEvidence('m', [{ standings: [{ criterionId: 'R-1', standing: 'missing' }] }] as any, d);
    expect(e.verdicts.size).toBe(0);
    expect(e.repairs).toEqual([]);
    expect(calls.verdictRows).toEqual([]);
    expect(calls.repairRows).toEqual(['m']);
    expect(calls.workerRows).toEqual([]);
    expect(calls.deliveryRows).toEqual([]);
  });

  it('names the live repair per criterion with its worker start and PR, and drops finished ones', async () => {
    const { deps: d, calls } = deps({
      repairRows: async () => [
        { id: 'r-run', title: '[spec repair] R-1: list empty', status: 'in_progress', context: { specRepair: { missionId: 'm', specId: 's1', criterionId: 'R-1', filedBy: 'fv' } } },
        { id: 'r-pr', title: '[spec repair] R-2: wrong words', status: 'completed', context: { specRepair: { missionId: 'm', specId: 's1', criterionId: 'R-2', filedBy: 'fv' } } },
        { id: 'r-merged', title: '[spec repair] R-4', status: 'completed', context: { specRepair: { missionId: 'm', specId: 's1', criterionId: 'R-4', filedBy: 'fv' } } },
        { id: 'r-legacy', title: '[spec repair] AC-1', status: 'pending', context: { specRepair: { missionId: 'm', filedBy: 'fv', criterionId: 'AC-1' } } },
        { id: 'r-nocrit', title: '[spec repair] ?', status: 'pending', context: { specRepair: { missionId: 'm', filedBy: 'fv' } } },
      ],
      workerRows: async () => [
        { taskId: 'r-run', startedAt: at, prNumber: null, prUrl: null },
        { taskId: 'r-run', startedAt: new Date('2026-10-22T00:00:00Z'), prNumber: null, prUrl: null },
        { taskId: 'r-pr', startedAt: at, prNumber: 41, prUrl: 'https://github.com/o/r/pull/41' },
      ],
      deliveryRows: async () => [
        { ownerTaskId: 'r-pr', state: 'AWAITING_REVIEW', prNumber: 41 },
        { ownerTaskId: 'r-merged', state: 'MERGED', prNumber: 40 },
      ],
    });
    const e = await loadMissionEvidence('m', [], d);
    expect(calls.workerRows).toEqual([['r-run', 'r-pr', 'r-merged', 'r-legacy', 'r-nocrit']]);
    expect(e.repairs.map((r) => r.taskId)).toEqual(['r-run', 'r-pr', 'r-legacy']);
    expect(repairFor(e, 's1', 'R-1')).toMatchObject({ title: '[spec repair] R-1: list empty', workerStartedAt: at.toISOString(), pr: null });
    expect(repairFor(e, 's1', 'R-2')!.pr).toEqual({ number: 41, url: 'https://github.com/o/r/pull/41', state: 'AWAITING_REVIEW' });
    expect(repairFor(e, 's2', 'R-1')).toBeNull();
    expect(repairFor(e, 's2', 'AC-1')!.taskId).toBe('r-legacy');
    expect(repairFor(e, 's1', 'R-4')).toBeNull();
  });
});
