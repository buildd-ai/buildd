/**
 * Start-commit gate (R-78, AC-124), run in isolation: pure decision over the
 * result of running each acceptance test on the mission's starting commit.
 */
import { describe, expect, it } from 'bun:test';
import { gateOnStartCommit, type StartCommitRun } from '../../src/lib/start-commit-gate';

const run = (criterionId: string, exitCode: number | null, output = ''): StartCommitRun => ({ criterionId, testName: `${criterionId}: t`, exitCode, output });

describe('start-commit gate', () => {
  it('AC-124 a test that passes on the starting commit is sent back with its output and its check does not start', () => {
    const g = gateOnStartCommit(['AC-1', 'AC-2'], [run('AC-1', 0, 'ok 1 passed'), run('AC-2', 1, 'expected 2 got 3')]);
    expect(g.sendBack).toEqual([{ criterionId: 'AC-1', testName: 'AC-1: t', output: 'ok 1 passed' }]);
    expect(g.startable).toEqual(['AC-2']);
    expect(g.allStartable).toBe(false);
  });

  it('AC-124 building starts when every test fails on the starting commit', () => {
    const g = gateOnStartCommit(['AC-1', 'AC-2'], [run('AC-1', 1), run('AC-2', 2)]);
    expect(g.sendBack).toEqual([]);
    expect(g.startable).toEqual(['AC-1', 'AC-2']);
    expect(g.allStartable).toBe(true);
  });

  it('a check with no run, or a run that could not start, is not startable and is not sent back as passing', () => {
    const g = gateOnStartCommit(['AC-1', 'AC-2'], [run('AC-2', null, 'spawn failed')]);
    expect(g.sendBack).toEqual([]);
    expect(g.startable).toEqual([]);
    expect(g.unrun).toEqual(['AC-1', 'AC-2']);
    expect(g.allStartable).toBe(false);
  });

  it('any passing run for a check sends it back, even beside a failing one', () => {
    const g = gateOnStartCommit(['AC-1'], [run('AC-1', 1), run('AC-1', 0, 'green')]);
    expect(g.sendBack.map((s) => s.criterionId)).toEqual(['AC-1']);
    expect(g.startable).toEqual([]);
  });
});
