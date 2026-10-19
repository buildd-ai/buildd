import type { Verdict } from '@buildd/spec-contract/outcome';

/**
 * An acceptance test's result on the merged mission result (Living Specs R-81,
 * AC-127). The test's exit code is its check's result: 0 is pass, any other
 * code is fail, and a run that could not start says nothing about the check, so
 * it is inconclusive. Recorded per check, authored as a test (`check:` prefix),
 * so it outranks any reviewer's opinion on the same check and commit.
 */
export interface AcceptanceTestRun {
  /** The process exit code; null when there was none (the run never finished). */
  exitCode: number | null;
  /** False when the test could not be launched at all. */
  started?: boolean;
  testName?: string;
  stdout?: string;
  stderr?: string;
}

export function acceptanceTestVerdict(run: Pick<AcceptanceTestRun, 'exitCode' | 'started'>): Verdict {
  if (run.started === false || typeof run.exitCode !== 'number') return 'inconclusive';
  return run.exitCode === 0 ? 'pass' : 'fail';
}

/** Read an untrusted request body into a run; null when it is not one. */
export function parseAcceptanceTestRun(raw: unknown): AcceptanceTestRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const exitCode = typeof r.exitCode === 'number' && Number.isInteger(r.exitCode) ? r.exitCode : null;
  return {
    exitCode,
    ...(r.started === false ? { started: false } : {}),
    ...(typeof r.testName === 'string' ? { testName: r.testName.slice(0, 300) } : {}),
    ...(typeof r.stdout === 'string' ? { stdout: r.stdout } : {}),
    ...(typeof r.stderr === 'string' ? { stderr: r.stderr } : {}),
  };
}

const MAX_EXCERPT = 2000;
const tail = (v: string | undefined) => (v ? v.slice(-MAX_EXCERPT) : undefined);

/**
 * What a verdict row records for one acceptance test run. The verdict comes
 * from the exit code alone, never from what the caller claims; the author is
 * `check:acceptance:<criterion>`, which reads as a test, not a review.
 */
export function acceptanceTestRecord(criterionId: string, run: AcceptanceTestRun): { verdict: Verdict; recordedBy: string; evidence: Record<string, unknown> } {
  return {
    verdict: acceptanceTestVerdict(run),
    recordedBy: `check:acceptance:${criterionId}`,
    evidence: {
      kind: 'acceptance-test',
      ...(run.testName ? { testName: run.testName } : {}),
      ...(typeof run.exitCode === 'number' ? { exitCode: run.exitCode } : {}),
      ...(run.started === false ? { started: false } : {}),
      ...(tail(run.stdout) ? { stdout: tail(run.stdout) } : {}),
      ...(tail(run.stderr) ? { stderr: tail(run.stderr) } : {}),
    },
  };
}
