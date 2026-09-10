/**
 * Option A′ — one refusal for "this mission task PR's base is not the mission's
 * integration branch", shared by every door a PR can enter buildd through.
 *
 * `packages/core/mission-integration.ts` owns the *predicate*; this module owns
 * the *enforcement*: which task the question is being asked about, which
 * exemptions apply, and the exact 400 body a caller gets back. It exists
 * because the predicate alone was not enough — the first pass at this invariant
 * guarded the two doors it could see (fresh PR creation, and adoption of a
 * caller-supplied `prUrl`) and left two more open, each of which records a PR
 * onto a worker row without ever consulting the mission:
 *
 *  - `create_pr`'s dedup-by-head branch, which adopts a PR that already exists
 *    for the worker's branch — the exact shape produced by an agent running
 *    `gh pr create --base <trunk>` and then calling `create_pr`;
 *  - the completion handler's GitHub auto-detect, which adopts any open PR on
 *    the worker's branch so that `pr_required` can be satisfied.
 *
 * Both are legitimate affordances. Neither may be a way to acquire a base the
 * front door would have refused, so all four now ask this module.
 *
 * Exemptions are exactly the ones the derivation itself uses — mission-PR
 * owner, stacked-plan phase, mission with no integration base, task with no
 * mission — and they live here once rather than being re-derived per door.
 */

import { db } from '@buildd/core/db';
import { missions } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import {
  isMissionPrTask,
  isPrLegalForMissionTask,
  isStackedPhaseBase,
  missionIntegrationBase,
  type MissionIntegrationFields,
} from '@buildd/core/mission-integration';

/** The task fields every door already has in hand (or can select cheaply). */
export interface MissionBaseGuardTask {
  title?: string | null;
  taskClass?: string | null;
  missionId?: string | null;
  context?: unknown;
}

export interface MissionBaseRefusal {
  error: string;
  hint: string;
}

export interface MissionBaseGuard {
  mission: MissionIntegrationFields | null;
  /** The mission's integration branch, or null when there is nothing to enforce. */
  integrationBase: string | null;
  isMissionPrOwner: boolean;
  isStackedPhase: boolean;
  /**
   * Is the invariant live for this task at all? False for every exemption, and
   * false is the "behave exactly as before Option A′" answer.
   */
  enforced: boolean;
  /** Is `baseRef` a legal base for this task's PR? */
  allows(baseRef: string | null | undefined): boolean;
  /** The 400 body to refuse with, or null when `baseRef` is legal. */
  refusal(
    baseRef: string | null | undefined,
    opts?: { prNumber?: number | null; action?: string },
  ): MissionBaseRefusal | null;
}

/**
 * Build the guard from rows the caller already holds.
 *
 * Split from the loader so the pure half is testable without a database and so
 * a door that already read the mission (PR creation does) does not read it
 * twice.
 */
export function buildMissionBaseGuard(args: {
  mission: MissionIntegrationFields | null | undefined;
  task: MissionBaseGuardTask | null | undefined;
  head?: string | null;
}): MissionBaseGuard {
  const mission = args.mission ?? null;
  const task = args.task ?? null;
  const integrationBase = missionIntegrationBase(mission);
  const isMissionPrOwner = !!(task && isMissionPrTask(task));
  const rawContextBase = (task?.context as Record<string, unknown> | null | undefined)?.baseBranch;
  const isStackedPhase = isStackedPhaseBase({
    contextBaseBranch: typeof rawContextBase === 'string' ? rawContextBase : undefined,
    head: args.head ?? null,
    mission,
  });
  const enforced = !!integrationBase && !isMissionPrOwner && !isStackedPhase;

  function allows(baseRef: string | null | undefined): boolean {
    if (!enforced) return true;
    return isPrLegalForMissionTask({
      baseRef: baseRef ?? null,
      mission,
      isMissionPrTask: false,
    });
  }

  return {
    mission,
    integrationBase,
    isMissionPrOwner,
    isStackedPhase,
    enforced,
    allows,
    refusal(baseRef, opts) {
      if (allows(baseRef)) return null;
      const subject = opts?.prNumber ? `PR #${opts.prNumber}` : 'this pull request';
      const action = opts?.action ?? 'register';
      const observed = baseRef?.trim() ? `'${baseRef.trim()}'` : "unknown";
      return {
        error:
          `Cannot ${action} ${subject}: its base (${observed}) is not this mission's ` +
          `integration branch (${integrationBase}). A mission task PR must target the ` +
          `mission's integration branch so the mission reaches trunk through one merge.`,
        hint:
          `Retarget ${subject} to base '${integrationBase}' on GitHub, then retry. ` +
          `A base buildd cannot read is treated as illegal — unknown never resolves to a passing check.`,
      };
    },
  };
}

/** Load the mission for `task` and build its guard. */
export async function loadMissionBaseGuard(args: {
  task: MissionBaseGuardTask | null | undefined;
  head?: string | null;
}): Promise<MissionBaseGuard> {
  const missionId = args.task?.missionId ?? null;
  const mission = missionId
    ? (await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { workingBranch: true, integrationBranchEnabled: true },
      })) ?? null
    : null;
  return buildMissionBaseGuard({ mission, task: args.task, head: args.head });
}
