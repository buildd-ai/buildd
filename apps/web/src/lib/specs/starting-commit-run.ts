/**
 * Runs the acceptance tests on the mission's starting commit (spec 1dc6cc39 R-78, AC-124).
 * A new test must fail there. One that passes is sent back to the acceptance-tests task with
 * its output, and building on its check does not start. The caller supplies `exec` (checkout the
 * commit and run the command) and acts on the outcome; this module only decides.
 */

export interface TestToRun {
  checkId: string;
  name: string;
  command: string;
}

/** `exitCode: null` means the run could not start. */
export type ExecAtCommit = (command: string, sha: string) => Promise<{ exitCode: number | null; output: string }>;

export type StartingResult = 'fail' | 'pass' | 'inconclusive';

export interface StartingRun {
  checkId: string;
  name: string;
  startingResult: StartingResult;
  output: string;
}

export interface StartingCommitOutcome {
  results: StartingRun[];
  /** Passing tests, each with the message to hand back to the acceptance-tests task. */
  sendBack: Array<{ checkId: string; name: string; message: string }>;
  /** Checks with any test that did not fail: building on them waits. */
  heldChecks: string[];
  /** Checks whose every test failed on the starting commit. */
  buildable: string[];
  /** Every test failed: building may start (unless the person objects, R-79). */
  allFail: boolean;
}

const MAX_OUTPUT = 2000;

export function sendBackMessage(input: { checkId: string; name: string; startSha: string; output: string }): string {
  const out = input.output.length > MAX_OUTPUT ? `${input.output.slice(0, MAX_OUTPUT)}\n… (truncated)` : input.output;
  return `${input.checkId}: "${input.name}" passes on the starting commit ${input.startSha}, so it does not test anything new. Rewrite it so it fails there. Output:\n${out}`;
}

export async function runAtStartingCommit(input: { startSha: string; tests: readonly TestToRun[]; exec: ExecAtCommit }): Promise<StartingCommitOutcome> {
  const results: StartingRun[] = [];
  for (const t of input.tests) {
    let run: { exitCode: number | null; output: string };
    try {
      run = await input.exec(t.command, input.startSha);
    } catch (err) {
      run = { exitCode: null, output: err instanceof Error ? err.message : String(err) };
    }
    const startingResult: StartingResult = run.exitCode === null ? 'inconclusive' : run.exitCode === 0 ? 'pass' : 'fail';
    results.push({ checkId: t.checkId, name: t.name, startingResult, output: run.output });
  }
  const sendBack = results
    .filter((r) => r.startingResult === 'pass')
    .map((r) => ({ checkId: r.checkId, name: r.name, message: sendBackMessage({ checkId: r.checkId, name: r.name, startSha: input.startSha, output: r.output }) }));
  const checks = [...new Set(results.map((r) => r.checkId))];
  const heldChecks = checks.filter((c) => results.some((r) => r.checkId === c && r.startingResult !== 'fail'));
  const buildable = checks.filter((c) => !heldChecks.includes(c));
  return { results, sendBack, heldChecks, buildable, allFail: results.length > 0 && heldChecks.length === 0 };
}
