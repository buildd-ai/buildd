/**
 * The claim route's candidate WHERE, built in one place so the route and the
 * runner queue (lib/claim-order-queue.ts) cannot drift: the route pushes
 * `conditions` into its candidate query; the queue reads the same predicates
 * back as `gates` (named handles, each TRUE when the task passes).
 */
import { and, eq, inArray, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { tasks } from '@buildd/core/db/schema';
import { depsGate } from '@/app/api/workers/claim/deps-gate';
import { missionNotHeld, missionNotLocal, taskNotHeld, taskNotReserved } from '@/app/api/workers/claim/held-gate';
import { subjectLivenessCondition } from '@/app/api/workers/claim/subject-gate';
import { workspaceCapGate } from '@/app/api/workers/claim/workspace-cap-gate';
import { workspaceExecutorGate } from '@/app/api/workers/claim/workspace-executor-gate';
import { appliesWorkspacePausedGate, workspaceNotPausedGate } from '@/app/api/workers/claim/workspace-paused-gate';
import { CLAIM_COOLDOWN_MS, activeWorkerGate, roleSlugGate, runnerCooldownGate, runnerPreferenceGate } from '@/lib/claim-order';

export type ClaimGateName =
  | 'claimFree' | 'activeWorker' | 'runnerPreference' | 'missionLocal' | 'taskReserved' | 'role' | 'workspaceExecutor' | 'subject'
  | 'startAt' | 'taskHeld' | 'missionHeld' | 'deps' | 'workspacePaused' | 'workspaceCap' | 'runnerCooldown';

export interface ClaimCandidateInput {
  workspaceIds: string[];
  now: Date;
  accountType: string;
  /** The runner id the claim body sends; scopes the per-runner cooldown. */
  runner: string | null;
  availableSkills: string[];
  executor: 'host' | 'cloud';
  /** An admin force claim (lifts most gates). */
  forceClaim?: boolean;
  /** A verified interactive session. */
  interactiveSession?: boolean;
  /** The account id, used only for an interactive explicit claim of its own reservation. */
  accountId?: string;
  /** An explicit claim of this task. */
  taskId?: string | null;
}

export function claimCandidateWhere(input: ClaimCandidateInput): { conditions: SQL[]; gates: Partial<Record<ClaimGateName, SQL>> } {
  const { workspaceIds, now, accountType, runner, availableSkills, executor } = input;
  const forceClaim = !!input.forceClaim;
  const interactive = !!input.interactiveSession;
  const taskId = input.taskId ?? null;
  const explicitInteractive = !!(taskId && interactive);
  const gates: Partial<Record<ClaimGateName, SQL>> = {};

  gates.claimFree = or(isNull(tasks.claimedBy), lt(tasks.expiresAt, now))!;
  // A deferred task is inert until its floor; a force claim starts it now.
  if (!forceClaim) gates.startAt = or(isNull(tasks.startAt), lte(tasks.startAt, now))!;
  if (accountType !== 'user') gates.runnerPreference = runnerPreferenceGate(accountType);
  gates.activeWorker = activeWorkerGate();
  if (!forceClaim) gates.missionHeld = missionNotHeld();
  if (!forceClaim && !explicitInteractive) gates.missionLocal = missionNotLocal();
  gates.taskHeld = taskNotHeld();
  gates.taskReserved = taskNotReserved(explicitInteractive ? input.accountId : undefined);
  if (!forceClaim) gates.subject = subjectLivenessCondition();
  if (!forceClaim) gates.deps = depsGate();
  if (!forceClaim) gates.workspaceCap = workspaceCapGate();
  if (!forceClaim) gates.workspaceExecutor = workspaceExecutorGate(executor);
  if (appliesWorkspacePausedGate({ interactive, force: forceClaim })) gates.workspacePaused = workspaceNotPausedGate(now);
  if (!explicitInteractive && runner) {
    gates.runnerCooldown = runnerCooldownGate(runner, new Date(now.getTime() - CLAIM_COOLDOWN_MS));
  }
  const roleConditions = explicitInteractive ? [] : roleSlugGate(availableSkills);
  if (roleConditions.length > 0) gates.role = and(...roleConditions)!;

  const conditions: SQL[] = [inArray(tasks.workspaceId, workspaceIds), eq(tasks.status, 'pending')];
  if (taskId) conditions.push(eq(tasks.id, taskId));
  for (const g of Object.values(gates)) if (g) conditions.push(g);
  return { conditions, gates };
}
