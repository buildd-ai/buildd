import { describe, expect, it } from 'bun:test';
import { ESTIMATOR_VERSION } from '@buildd/core/task-estimate';
import { loadBuildEstimateRows } from './mission-build-estimates';

const row = { estimatorVersion: ESTIMATOR_VERSION, taskId: 't1', p50Minutes: 10, p80Minutes: 20 };

describe('loadBuildEstimateRows: the Overview estimate follows the team switch, like the Plan page', () => {
  it('does not expose raw numbers when the running calibration is unknown', async () => {
    let reads = 0;
    expect(await loadBuildEstimateRows({ teamId: 'team', taskIds: ['t1'], finished: false }, {
      enabled: async () => true, calibrated: () => false,
      read: async () => { reads++; return [row]; },
    })).toEqual([]);
    expect(reads).toBe(0);
  });
  it('does not mix older versions into a calibrated projection', async () => {
    expect(await loadBuildEstimateRows({ teamId: 'team', taskIds: ['t1'], finished: false }, {
      enabled: async () => true, calibrated: () => true,
      read: async () => [{ ...row, estimatorVersion: 'older' }, row],
    })).toEqual([row]);
  });

  it('reads nothing for a team with estimates off, even when rows exist', async () => {
    let read = 0;
    const rows = await loadBuildEstimateRows({ teamId: 'team', taskIds: ['t1'], finished: false }, {
      enabled: async () => false, read: async () => { read++; return [row]; },
    });
    expect(rows).toEqual([]);
    expect(read).toBe(0);
  });

  it('reads the mission task estimates for a team with estimates on', async () => {
    let asked: string[] = [];
    const rows = await loadBuildEstimateRows({ teamId: 'team', taskIds: ['t1', 't2'], finished: false }, {
      calibrated: () => true, enabled: async () => true, read: async (ids) => { asked = ids; return [row]; },
    });
    expect(rows).toEqual([row]);
    expect(asked).toEqual(['t1', 't2']);
  });

  it('skips the switch and the read for a finished or empty mission, or one with no team', async () => {
    const never = { enabled: async () => { throw new Error('asked'); }, read: async () => { throw new Error('read'); } };
    expect(await loadBuildEstimateRows({ teamId: 'team', taskIds: ['t1'], finished: true }, never)).toEqual([]);
    expect(await loadBuildEstimateRows({ teamId: 'team', taskIds: [], finished: false }, never)).toEqual([]);
    expect(await loadBuildEstimateRows({ teamId: null, taskIds: ['t1'], finished: false }, never)).toEqual([]);
  });
});
