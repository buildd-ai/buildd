/** Spec 47c97f48 (r1) R-2 / AC-2: the estimates a runner reads when an update opens its window. */
import { describe, expect, it, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { loadWorkerEstimates } = await import('./worker-estimates');

const deps = (over: Partial<Parameters<typeof loadWorkerEstimates>[2]> = {}) => ({
  workers: async () => [
    { workerId: 'w-short', taskId: 't-short', teamId: 'team-1' },
    { workerId: 'w-none', taskId: 't-none', teamId: 'team-1' },
    { workerId: 'w-off', taskId: 't-off', teamId: 'team-off' },
  ],
  enabled: async (teamId: string) => teamId !== 'team-off',
  // Newest first: the first row per task is its estimate.
  estimates: async () => [{ taskId: 't-short', p50Minutes: 29.6 }, { taskId: 't-short', p50Minutes: 90 }],
  calibrated: () => true,
  ...over,
});

describe('loadWorkerEstimates', () => {
  it('the newest p50 per task, rounded; no estimate or estimates off read null', async () => {
    expect(await loadWorkerEstimates('acct', ['w-short', 'w-none', 'w-off'], deps())).toEqual({ 'w-short': 30, 'w-none': null, 'w-off': null });
  });

  it('a worker of another account is not answered (null)', async () => {
    expect(await loadWorkerEstimates('acct', ['w-short', 'w-foreign'], deps({ workers: async () => [{ workerId: 'w-short', taskId: 't-short', teamId: 'team-1' }] })))
      .toEqual({ 'w-short': 30, 'w-foreign': null });
  });

  it('estimates not calibrated: every one null, nothing read', async () => {
    let read = false;
    expect(await loadWorkerEstimates('acct', ['w-short'], deps({ calibrated: () => false, workers: async () => { read = true; return []; } }))).toEqual({ 'w-short': null });
    expect(read).toBe(false);
  });

  it('caps the ids', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `w-${i}`);
    expect(Object.keys(await loadWorkerEstimates('acct', ids, deps({ workers: async () => [] })))).toHaveLength(50);
  });
});
