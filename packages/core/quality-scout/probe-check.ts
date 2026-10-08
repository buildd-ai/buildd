/**
 * A Quality Scout probe as a verification-substrate check: ids, version and
 * execution. Pure (no database, no decision kind), so both the server
 * (through ledger.ts, which re-exports all of this) and a runner-hosted probe
 * (packages/core/quality-scout/runner-host.ts) use the one definition.
 */
import {
  runVerificationCheck,
  type VerificationCheck,
  type VerificationExecutor,
  type VerificationRunContext,
} from '../verification-check';
import { SCOUT_FLAVOR, type ScoutProbeRecord, type ScoutRun } from './types';

export const SCOUT_CHECK_VERSION = 1;

export function scoutCheckId(candidateId: string): string {
  return `${SCOUT_FLAVOR}:${candidateId}`;
}

/**
 * The check id for a probe whose execution does not depend on which hypothesis
 * selected it (the same command, request or capture). Two hypotheses that run
 * the same thing gather the same evidence, so a failure there is one defect:
 * keying it by the execution is what keeps it one finding and one follow-up
 * across hypotheses and across runs.
 */
export function scoutExecutionCheckId(executionKey: string): string {
  return `${SCOUT_FLAVOR}:exec:${executionKey}`;
}

/** Required capability for a probe with no matched executor — never offered, so the check is `unsupported`. */
const NO_EXECUTOR = 'scout:no-usable-executor';

/**
 * The probe as a substrate check on the run's candidate SHA. The id depends
 * only on the candidate — or, given `executionKey`, only on what is executed —
 * so the signature of the same failure is the same in every run. The executor
 * must also find the probe's chosen capability.
 */
export function buildScoutProbeCheck<I>(
  run: ScoutRun,
  probe: ScoutProbeRecord,
  executor: VerificationExecutor<I>,
  executionKey?: string | null,
): VerificationCheck<I> {
  const requires = [probe.executor ?? NO_EXECUTOR, ...executor.requires.filter(r => r !== probe.executor)];
  return {
    id: executionKey ? scoutExecutionCheckId(executionKey) : scoutCheckId(probe.candidateId),
    version: SCOUT_CHECK_VERSION,
    invariant: probe.invariant,
    subject: { kind: 'candidate-sha', ref: run.candidate.sha },
    provenance: { flavor: SCOUT_FLAVOR, origin: `run:${run.id}` },
    executor: { kind: executor.kind, requires, run: (i: I) => executor.run(i) },
    evidenceRequirements: probe.evidenceRequirements,
    defaultSeverity: probe.risk,
  };
}

/** Run one selected probe through the substrate and attach its result. Never throws for executor errors. */
export function executeScoutProbe<I>(
  run: ScoutRun,
  probe: ScoutProbeRecord,
  executor: VerificationExecutor<I>,
  ctx: VerificationRunContext<I>,
  executionKey?: string | null,
): ScoutProbeRecord {
  if (probe.selection.status !== 'selected') throw new Error(`scout probe ${probe.candidateId}: only a selected probe is executed`);
  const result = runVerificationCheck(buildScoutProbeCheck(run, probe, executor, executionKey), ctx);
  return Object.freeze({ ...probe, result });
}

