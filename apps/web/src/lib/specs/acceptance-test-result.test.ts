import { describe, it, expect, mock } from 'bun:test';

const recorded: Array<[string, Record<string, unknown>]> = [];
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('./mission-outcome', () => ({
  recordMissionVerdictServer: async (missionId: string, input: Record<string, unknown>) => {
    recorded.push([missionId, input]);
    return { ok: true, verdictId: 'v1' };
  },
}));

const { acceptanceTestVerdict, recordAcceptanceTestResult } = await import('./acceptance-test-result');
const { verdictSourceOfEvidence } = await import('@buildd/spec-contract/outcome');

const SHA = 'a'.repeat(40);
const base = { specRevisionId: 'rev', criterionId: 'AC-3', headSha: SHA, testName: 'AC-3: refuses a stale version' };

describe('an acceptance test exit code is its check result (AC-127)', () => {
  it('maps 0 to pass, any other code to fail, a run that could not start to inconclusive', () => {
    expect(acceptanceTestVerdict({ exitCode: 0 })).toBe('pass');
    expect(acceptanceTestVerdict({ exitCode: 1 })).toBe('fail');
    expect(acceptanceTestVerdict({ exitCode: 2 })).toBe('fail');
    expect(acceptanceTestVerdict({ exitCode: 127 })).toBe('fail');
    expect(acceptanceTestVerdict({ exitCode: null, started: false })).toBe('inconclusive');
    expect(acceptanceTestVerdict({ exitCode: 1, started: false })).toBe('inconclusive');
    expect(acceptanceTestVerdict({ exitCode: null })).toBe('inconclusive');
  });

  it('records pass on the merged result, authored as a test', async () => {
    recorded.length = 0;
    const r = await recordAcceptanceTestResult('m1', { ...base, exitCode: 0 });
    expect(r).toEqual({ ok: true, verdictId: 'v1', verdict: 'pass' });
    const [mission, input] = recorded[0]!;
    expect(mission).toBe('m1');
    expect(input).toMatchObject({ criterionId: 'AC-3', verdict: 'pass', headSha: SHA });
    expect(verdictSourceOfEvidence({ recordedBy: input.recordedBy })).toBe('test');
    expect(input.evidence).toMatchObject({ kind: 'acceptance-test', exitCode: 0, testName: base.testName });
  });

  it('records fail for a non-zero exit', async () => {
    recorded.length = 0;
    const r = await recordAcceptanceTestResult('m1', { ...base, exitCode: 1, stderr: 'boom' });
    expect(r).toMatchObject({ ok: true, verdict: 'fail' });
    expect(recorded[0]![1].evidence).toMatchObject({ exitCode: 1, stderr: 'boom' });
  });

  it('records inconclusive when the run could not start', async () => {
    recorded.length = 0;
    const r = await recordAcceptanceTestResult('m1', { ...base, exitCode: null, started: false });
    expect(r).toMatchObject({ ok: true, verdict: 'inconclusive' });
  });
});
