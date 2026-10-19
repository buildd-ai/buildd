import { describe, expect, it } from 'bun:test';
import { runAtStartingCommit, sendBackMessage, type ExecAtCommit } from './starting-commit-run';

const tests = [
  { checkId: 'AC-1', name: 'AC-1: refuses a stale version', command: 'bun test a' },
  { checkId: 'AC-2', name: 'AC-2: lists the tests', command: 'bun test b' },
  { checkId: 'AC-3', name: 'AC-3: holds building', command: 'bun test c' },
];

describe('runAtStartingCommit (R-78, AC-124)', () => {
  it('runs every test at the starting commit and maps exit codes: non-zero fails (wanted), 0 passes, no start is inconclusive', async () => {
    const seen: string[] = [];
    const exec: ExecAtCommit = async (command, sha) => {
      seen.push(`${sha}:${command}`);
      if (command.endsWith('a')) return { exitCode: 1, output: 'expected 1 got 2' };
      if (command.endsWith('b')) return { exitCode: 0, output: '1 pass' };
      return { exitCode: null, output: 'spawn failed' };
    };
    const out = await runAtStartingCommit({ startSha: 'abc123', tests, exec });
    expect(seen).toEqual(['abc123:bun test a', 'abc123:bun test b', 'abc123:bun test c']);
    expect(out.results.map((r) => [r.checkId, r.startingResult])).toEqual([['AC-1', 'fail'], ['AC-2', 'pass'], ['AC-3', 'inconclusive']]);
    expect(out.results[1].output).toBe('1 pass');
  });

  it('sends a passing test back with its output and holds building on that check only', async () => {
    const exec: ExecAtCommit = async (command) => (command.endsWith('b') ? { exitCode: 0, output: '1 pass' } : { exitCode: 1, output: 'red' });
    const out = await runAtStartingCommit({ startSha: 'abc123', tests, exec });
    expect(out.sendBack.map((s) => s.checkId)).toEqual(['AC-2']);
    expect(out.sendBack[0].message).toContain('AC-2');
    expect(out.sendBack[0].message).toContain('1 pass');
    expect(out.heldChecks).toEqual(['AC-2']);
    expect(out.buildable).toEqual(['AC-1', 'AC-3']);
    expect(out.allFail).toBe(false);
  });

  it('an exec that throws is inconclusive, not a pass', async () => {
    const out = await runAtStartingCommit({ startSha: 's', tests: [tests[0]], exec: async () => { throw new Error('boom'); } });
    expect(out.results[0]).toMatchObject({ startingResult: 'inconclusive', output: 'boom' });
    expect(out.heldChecks).toEqual(['AC-1']);
  });

  it('building starts when every test fails, and not for an empty set', async () => {
    const red: ExecAtCommit = async () => ({ exitCode: 2, output: '' });
    expect((await runAtStartingCommit({ startSha: 's', tests, exec: red })).allFail).toBe(true);
    expect((await runAtStartingCommit({ startSha: 's', tests: [], exec: red })).allFail).toBe(false);
  });

  it('holds a check whose tests include one that passes, even when another test for it fails', async () => {
    const two = [tests[0], { ...tests[0], name: 'AC-1: second', command: 'bun test b' }];
    const exec: ExecAtCommit = async (command) => (command.endsWith('b') ? { exitCode: 0, output: 'ok' } : { exitCode: 1, output: 'red' });
    const out = await runAtStartingCommit({ startSha: 's', tests: two, exec });
    expect(out.heldChecks).toEqual(['AC-1']);
    expect(out.buildable).toEqual([]);
  });
});

describe('sendBackMessage', () => {
  it('names the test, the commit and its output, truncating long output', () => {
    const m = sendBackMessage({ checkId: 'AC-2', name: 'AC-2: x', startSha: 'abc123', output: 'x'.repeat(5000) });
    expect(m).toContain('AC-2: x');
    expect(m).toContain('abc123');
    expect(m.length).toBeLessThan(3000);
  });
});
