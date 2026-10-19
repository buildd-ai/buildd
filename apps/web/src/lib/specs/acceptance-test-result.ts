import type { Verdict } from '@buildd/spec-contract/outcome';
import { recordMissionVerdictServer } from './mission-outcome';
import type { SpecError } from './store';

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
}

export function acceptanceTestVerdict(run: AcceptanceTestRun): Verdict {
  if (run.started === false || typeof run.exitCode !== 'number') return 'inconclusive';
  return run.exitCode === 0 ? 'pass' : 'fail';
}

const MAX_EXCERPT = 2000;
const tail = (v: string | undefined) => (v ? v.slice(-MAX_EXCERPT) : undefined);

export async function recordAcceptanceTestResult(missionId: string, input: AcceptanceTestRun & {
  specRevisionId: string;
  criterionId: string;
  /** The merged result the test ran on: a full commit SHA. */
  headSha: string;
  testName: string;
  stdout?: string;
  stderr?: string;
}): Promise<{ ok: true; verdictId: string; verdict: Verdict } | SpecError> {
  const verdict = acceptanceTestVerdict(input);
  const r = await recordMissionVerdictServer(missionId, {
    specRevisionId: input.specRevisionId,
    criterionId: input.criterionId,
    verdict,
    headSha: input.headSha,
    recordedBy: `check:acceptance:${input.criterionId}`,
    evidence: {
      kind: 'acceptance-test',
      testName: input.testName,
      ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
      ...(input.started === false ? { started: false } : {}),
      ...(tail(input.stdout) ? { stdout: tail(input.stdout) } : {}),
      ...(tail(input.stderr) ? { stderr: tail(input.stderr) } : {}),
    },
  });
  return r.ok ? { ok: true, verdictId: r.verdictId, verdict } : r;
}
