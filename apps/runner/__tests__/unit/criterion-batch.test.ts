import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CRITERION_BATCH_CHECKOUT_FAILED_EXIT, type CriterionBatchMarker } from '@buildd/shared';
import { runCriterionBatch, type BatchExec } from '../../src/criterion-batch';
import { VERIFICATION_COMMAND_TIMEOUT_MS } from '../../src/runner-verification';

const SHA = 'a'.repeat(40);
const marker = (checks: CriterionBatchMarker['checks']): CriterionBatchMarker => ({
  subjectTaskId: 's', missionId: 'm', specRevisionId: 'r', headSha: SHA, commandSet: 'set', checks,
});

describe('one runner job checks every criterion of a mission target', () => {
  it('checks the head out once, then runs each criterion in order with its own timeout', async () => {
    const calls: Array<{ command: string; timeoutMs: number }> = [];
    const exec: BatchExec = async (command, _cwd, timeoutMs) => {
      calls.push({ command, timeoutMs });
      return { outcome: 'ok', exitCode: 0, durationMs: 4_100, stdout: `ran ${command}` };
    };
    const ev = await runCriterionBatch({ workerId: 'w', cwd: '/x', marker: marker([
      { criterionId: 'AC-1', command: 'bun run a', timeoutMs: 300_000 },
      { criterionId: 'AC-2', command: 'bun run b', timeoutMs: 180_000 },
    ]) }, exec);
    expect(calls.map((c) => c.command)).toEqual([expect.stringContaining(`git checkout -q --detach ${SHA}`), 'bun run a', 'bun run b']);
    expect(calls.slice(1).map((c) => c.timeoutMs)).toEqual([300_000, 180_000]);
    expect(ev).toMatchObject({ conditionType: 'criterion_batch', workerId: 'w', headSha: SHA, checkout: 'ok' });
    expect(ev.results).toEqual([
      expect.objectContaining({ criterionId: 'AC-1', command: 'bun run a', outcome: 'ok', exitCode: 0, timeoutMs: 300_000, stdout: 'ran bun run a' }),
      expect.objectContaining({ criterionId: 'AC-2', command: 'bun run b', outcome: 'ok', exitCode: 0, timeoutMs: 180_000 }),
    ]);
  });

  it('a criterion whose test passes in 4s passes, however long the run as a whole took', async () => {
    // The old single verification command had one 60s limit for everything.
    const exec: BatchExec = async (command) => command.startsWith('git ')
      ? { outcome: 'ok', exitCode: 0, durationMs: 50 }
      : command === 'slow' ? { outcome: 'ok', exitCode: 0, durationMs: VERIFICATION_COMMAND_TIMEOUT_MS + 30_000 }
      : { outcome: 'ok', exitCode: 0, durationMs: 4_100 };
    const ev = await runCriterionBatch({ workerId: 'w', cwd: '/x', marker: marker([
      { criterionId: 'R-1', command: 'slow', timeoutMs: 600_000 },
      { criterionId: 'AC-19', command: 'fast', timeoutMs: 120_000 },
    ]) }, exec);
    expect(ev.results.map((r) => [r.criterionId, r.outcome])).toEqual([['R-1', 'ok'], ['AC-19', 'ok']]);
  });

  it('one criterion timing out leaves the others to run under their own limits (real shell)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'criterion-batch-'));
    const realExec: BatchExec = async (command, dir, timeoutMs) => {
      const { runVerificationCommand } = await import('../../src/runner-verification');
      // Checkout is not under test here: the tmp dir is no repo.
      if (command.startsWith('git ')) return { outcome: 'ok', exitCode: 0, durationMs: 0 };
      return runVerificationCommand({ workerId: 'w', iteration: 0, command, cwd: dir, timeoutMs });
    };
    const ev = await runCriterionBatch({ workerId: 'w', cwd, marker: marker([
      { criterionId: 'R-1', command: 'sleep 5', timeoutMs: 200 },
      { criterionId: 'R-2', command: 'echo passed', timeoutMs: 5_000 },
      { criterionId: 'R-3', command: 'exit 3', timeoutMs: 5_000 },
    ]) }, realExec);
    expect(ev.results.map((r) => [r.criterionId, r.outcome, r.exitCode])).toEqual([['R-1', 'timeout', undefined], ['R-2', 'ok', 0], ['R-3', 'failed', 3]]);
    expect(ev.results[1].stdout).toContain('passed');
  });

  it('a head that cannot be checked out runs nothing and reports every criterion as a failed checkout', async () => {
    const ran: string[] = [];
    const exec: BatchExec = async (command) => { ran.push(command); return { outcome: 'failed', exitCode: 128, durationMs: 10, stderr: 'bad object' }; };
    const ev = await runCriterionBatch({ workerId: 'w', cwd: '/x', marker: marker([
      { criterionId: 'AC-1', command: 'bun run a', timeoutMs: 60_000 },
      { criterionId: 'AC-2', command: 'bun run b', timeoutMs: 60_000 },
    ]) }, exec);
    expect(ran).toHaveLength(1);
    expect(ev.checkout).toBe('failed');
    expect(ev.results.map((r) => [r.criterionId, r.outcome, r.exitCode])).toEqual([
      ['AC-1', 'failed', CRITERION_BATCH_CHECKOUT_FAILED_EXIT], ['AC-2', 'failed', CRITERION_BATCH_CHECKOUT_FAILED_EXIT],
    ]);
  });

  it('keeps the tail of a long output, where a test run prints its verdict', async () => {
    const long = 'x'.repeat(10_000) + '\n 17 pass\n 0 fail\n';
    const exec: BatchExec = async (command, _cwd, _t, excerpt) => command.startsWith('git ')
      ? { outcome: 'ok', exitCode: 0, durationMs: 1 }
      : { outcome: 'ok', exitCode: 0, durationMs: 1, stdout: excerpt(long) };
    const ev = await runCriterionBatch({ workerId: 'w', cwd: '/x', marker: marker([{ criterionId: 'AC-1', command: 'bun run a', timeoutMs: 60_000 }]) }, exec);
    expect(ev.results[0].stdout!.endsWith(' 0 fail\n')).toBe(true);
    expect(ev.results[0].stdout!.length).toBeLessThan(long.length);
  });
});
