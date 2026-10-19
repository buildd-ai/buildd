/**
 * The gate between the acceptance-tests task and the building tasks (spec 1dc6cc39 R-78, R-79).
 * Pure: the caller supplies each test's result on the mission's starting commit and whether the
 * person objected, and acts on the decision (start building, hold it, reopen the tests task).
 */

/** A test's result on the starting commit: `fail` is the wanted one; null = not run yet. */
export type StartingResult = 'fail' | 'pass' | 'inconclusive' | null;

export interface AcceptanceTest {
  checkId: string;
  name: string;
  startingResult: StartingResult;
  /** Output of the starting-commit run, handed back to the tests task when it passed. */
  output?: string;
}

export type GateDecision =
  | { action: 'start'; readyChecks: string[] }
  | { action: 'wait'; readyChecks: string[]; pendingChecks: string[]; sendBack: AcceptanceTest[] }
  | { action: 'hold'; reopenAcceptanceTask: true; readyChecks: [] };

/**
 * R-78: a test that passes on the starting commit is sent back and its check does not start
 * building. R-79: otherwise building starts once every test fails, unless the person objected;
 * an objection holds the building tasks and reopens the acceptance-tests task.
 */
export function decideBuildingGate(input: { tests: readonly AcceptanceTest[]; objected: boolean }): GateDecision {
  if (input.objected) return { action: 'hold', reopenAcceptanceTask: true, readyChecks: [] };
  const readyChecks = [...new Set(input.tests.filter((t) => t.startingResult === 'fail').map((t) => t.checkId))];
  const sendBack = input.tests.filter((t) => t.startingResult === 'pass');
  const pendingChecks = [...new Set(input.tests.filter((t) => t.startingResult !== 'fail').map((t) => t.checkId))];
  if (pendingChecks.length === 0 && input.tests.length > 0) return { action: 'start', readyChecks };
  return { action: 'wait', readyChecks: readyChecks.filter((c) => !pendingChecks.includes(c)), pendingChecks, sendBack };
}

/** The mission page's list: the tests added, grouped by the check each one covers. */
export function testsByCheck(tests: readonly AcceptanceTest[]): Array<{ checkId: string; tests: AcceptanceTest[] }> {
  const groups = new Map<string, AcceptanceTest[]>();
  for (const t of tests) groups.set(t.checkId, [...(groups.get(t.checkId) ?? []), t]);
  return [...groups].map(([checkId, list]) => ({ checkId, tests: list }));
}
