/** One acceptance test's run on the mission's starting commit. `exitCode` is null when the run could not start. */
export interface StartCommitRun {
  criterionId: string;
  testName: string;
  exitCode: number | null;
  output: string;
}

export interface StartCommitGate {
  /** Tests that pass on the starting commit: returned to the acceptance-tests task with their output. */
  sendBack: { criterionId: string; testName: string; output: string }[];
  /** Checks whose tests all fail there: building on them may start. */
  startable: string[];
  /** Checks with no run that could start: held until a run settles. */
  unrun: string[];
  /** True when every check is startable, so building starts. */
  allStartable: boolean;
}

/** R-78: building on a check starts only once its test fails on the starting commit. */
export function gateOnStartCommit(criteria: readonly string[], runs: readonly StartCommitRun[]): StartCommitGate {
  const sendBack: StartCommitGate['sendBack'] = [];
  const startable: string[] = [];
  const unrun: string[] = [];
  for (const criterionId of criteria) {
    const settled = runs.filter((r) => r.criterionId === criterionId && r.exitCode !== null);
    const passing = settled.filter((r) => r.exitCode === 0);
    if (passing.length > 0) {
      for (const r of passing) sendBack.push({ criterionId, testName: r.testName, output: r.output });
    } else if (settled.length > 0) startable.push(criterionId);
    else unrun.push(criterionId);
  }
  return { sendBack, startable, unrun, allStartable: startable.length === criteria.length };
}
