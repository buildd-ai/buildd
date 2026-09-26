/**
 * CBM-access experiment, claim-route glue (see packages/core/cbm-access-experiment.ts).
 *
 * Runs after the claim lock and after `attachRoleConfig`, because eligibility
 * needs the role's CBM opt-out (`cbmDisabled`) and the task's FINAL backend
 * (after any failover flip). A no-op unless the team has a `running`
 * experiment of kind `cbm_access`; never throws, never defers.
 *
 * The marker rides on the claimed worker as `cbmExperiment`. The runner reads
 * `withheld` and, when true, refuses CBM activation (`experiment_withheld`),
 * strips any CBM mount and denies every CBM tool. The steering block and the
 * graph mention in the task-area hint follow from that (see
 * attachTaskAreaScope, which runs after this).
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { enrolCbmAccessExperiment } from '@buildd/core/cbm-access-experiment-source';
import { CBM_WITHHOLD_RUNNER_FEATURE } from '@buildd/core/cbm-access-experiment';

export async function attachCbmExperimentArm(
  claimedWorkers: ClaimTasksResponse['workers'],
  runner: { cliVersion: string | null | undefined; features: readonly string[] | undefined },
): Promise<void> {
  const runnerCanWithhold = !!runner.features?.includes(CBM_WITHHOLD_RUNNER_FEATURE);
  for (const cw of claimedWorkers) {
    const task = cw.task as any;
    if (!task) continue;
    const marker = await enrolCbmAccessExperiment({
      teamId: task.workspace?.teamId,
      task,
      roleCbmDisabled: !!(cw as any).cbmDisabled,
      runnerCanWithhold,
      runnerCliVersion: runner.cliVersion,
    });
    if (marker) cw.cbmExperiment = marker;
  }
}
