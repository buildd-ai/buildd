/**
 * Settles the acceptance-tests task's completion against the mission's starting commit
 * (spec 1dc6cc39 R-78). The server cannot check out a commit, so the acceptance-tests agent runs
 * each test there and reports `{ startSha, runs }`; those reports are the `exec` that
 * `runAtStartingCommit` replays. A test with no report is inconclusive and holds its check.
 * The outcome goes through the building gate, so a completed task that is not startable is
 * reopened and the building tasks keep waiting on it.
 */
import { runAtStartingCommit, type ExecAtCommit, type TestToRun } from './starting-commit-run';
import { gateOnStartCommit } from '@/lib/start-commit-gate';
import { recordAcceptanceResults, type GateOutcome, type GateStore } from './acceptance-gate-apply';

export interface ReportedRun {
  checkId: string;
  name: string;
  exitCode: number | null;
  output?: string;
}

export interface ReportedStartingRuns {
  startSha: string;
  runs: ReportedRun[];
}

/** Pulls `startingCommitRuns` out of a worker's structured output; malformed entries are dropped. */
export function reportedRunsFrom(structured: unknown): ReportedStartingRuns | null {
  const raw = (structured as { startingCommitRuns?: { startSha?: unknown; runs?: unknown } } | null)?.startingCommitRuns;
  if (!raw || typeof raw.startSha !== 'string' || !Array.isArray(raw.runs)) return null;
  const runs = (raw.runs as Array<Record<string, unknown>>).flatMap((r): ReportedRun[] =>
    r && typeof r.checkId === 'string' && typeof r.name === 'string' && (r.exitCode === null || typeof r.exitCode === 'number')
      ? [{ checkId: r.checkId, name: r.name, exitCode: r.exitCode as number | null, output: typeof r.output === 'string' ? r.output : '' }]
      : [],
  );
  return { startSha: raw.startSha, runs };
}

export async function settleStartingCommit(store: GateStore, missionId: string, reported: ReportedStartingRuns | null): Promise<GateOutcome | null> {
  const state = await store.load(missionId);
  if (!state) return null;
  const tests: TestToRun[] = (reported?.runs ?? []).map((r) => ({ checkId: r.checkId, name: r.name, command: r.name }));
  const byName = new Map((reported?.runs ?? []).map((r) => [r.name, r]));
  const exec: ExecAtCommit = async (name) => {
    const r = byName.get(name);
    return r ? { exitCode: r.exitCode, output: r.output ?? '' } : { exitCode: null, output: 'no starting-commit run reported' };
  };
  const outcome = await runAtStartingCommit({ startSha: reported?.startSha ?? 'unknown', tests, exec });
  // gateOnStartCommit is the per-check view; a check it does not release cannot start building.
  const gate = gateOnStartCommit([...new Set(outcome.results.map((r) => r.checkId))], outcome.results.map((r) => ({
    criterionId: r.checkId, testName: r.name, exitCode: r.startingResult === 'inconclusive' ? null : r.startingResult === 'pass' ? 0 : 1, output: r.output,
  })));
  const sentBack = new Set(gate.sendBack.map((s) => `${s.criterionId}\0${s.testName}`));
  return recordAcceptanceResults(store, missionId, outcome.results.map((r) => ({
    checkId: r.checkId, name: r.name, output: r.output,
    // a passing test keeps its `pass` so the gate sends it back; anything unsettled stays unsettled
    startingResult: sentBack.has(`${r.checkId}\0${r.name}`) ? 'pass' : r.startingResult,
  })));
}
