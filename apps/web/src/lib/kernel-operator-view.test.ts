import { describe, it, expect } from 'bun:test';
import { describeFloorResult, evidenceLine, parseKernelQuery } from './kernel-operator-view';

describe('parseKernelQuery', () => {
  it('defaults to the last day and no filter', () => {
    expect(parseKernelQuery({})).toMatchObject({ window: '24h', workspace: undefined, team: undefined, command: undefined, pr: undefined });
  });
  it('reads the filters, trimmed, and takes the first of a repeated param', () => {
    expect(parseKernelQuery({ kwindow: '7d', kworkspace: ' alpha ', kteam: ['t1', 't2'], kcommand: 'open_delivery', kpr: '42' }))
      .toMatchObject({ window: '7d', workspace: 'alpha', team: 't1', command: 'open_delivery', pr: 42 });
  });
  it('falls back on a window it does not know and a PR number that is not one', () => {
    expect(parseKernelQuery({ kwindow: '90d', kpr: '-3' })).toMatchObject({ window: '24h', pr: undefined });
    expect(parseKernelQuery({ kpr: 'abc' }).pr).toBeUndefined();
    expect(parseKernelQuery({ kpr: '99999999999' }).pr).toBeUndefined();
    expect(parseKernelQuery({ kworkspace: 'x'.repeat(500) }).workspace).toHaveLength(120);
  });
});

describe('describeFloorResult', () => {
  it('says what each step repaired in plain words', () => {
    const { repaired, problems } = describeFloorResult({
      kernelOutbox: { claimed: 2, done: 2, failed: 0 },
      kernelFloor: { checked: 9, imported: 1, enqueued: 2, errors: 0 },
      trunk: { checked: 1, resolved: 1, recovered: 0, stillRed: 0, errors: 0 },
      treadmillCycles: { checked: 1, restarted: 1, refused: 0, errors: 0 },
      parkedCommands: { claimed: 1, done: 1, retried: 0, dead: 0, pruned: 0 },
      openPrStatuses: { repos: 1, checked: 5, published: 1, republished: 1, unchanged: 3, candidates: 0, errors: 0, coverage: { missing: [] } },
    });
    expect(repaired).toEqual([
      'sent 2 owed effects', 'took in 1 change GitHub had already made', 're-queued 2 effects a PR was owed',
      'cleared 1 base-branch incident', 'restarted 1 spent merge cycle', 're-sent 1 parked command', 'wrote the approval check on 2 PR heads',
    ]);
    expect(problems).toEqual([]);
  });
  it('a quiet run repaired nothing and reports no problem', () => {
    expect(describeFloorResult({ kernelOutbox: { done: 0, failed: 0 }, kernelFloor: { checked: 3, imported: 0, enqueued: 0, errors: 0 } })).toEqual({ repaired: [], problems: [] });
    expect(describeFloorResult(null)).toEqual({ repaired: [], problems: [] });
  });
  it('a step that threw, a given-up command and a head without the check are problems, not repairs', () => {
    const { repaired, problems } = describeFloorResult({
      kernelOutbox: { error: 'db timed out' },
      parkedCommands: { done: 0, dead: 2 },
      openPrStatuses: { published: 0, republished: 0, errors: 1, coverage: { missing: [1, 2] } },
      commandsPruned: { error: 'prune failed' },
    });
    expect(repaired).toEqual([]);
    expect(problems).toEqual([
      'kernelOutbox could not run: db timed out', 'gave up on 2 parked commands',
      '2 open PR heads still without the approval check', '1 open PR head could not be read', 'pruning old commands failed: prune failed',
    ]);
  });
});

describe('evidenceLine', () => {
  it('is key: value pairs, long values cut', () => {
    expect(evidenceLine({ verdict: 'approve', round: 2 })).toBe('verdict: approve; round: 2');
    expect(evidenceLine({ note: 'x'.repeat(200) }).length).toBeLessThan(100);
    expect(evidenceLine(null)).toBe('');
  });
});
