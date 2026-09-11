import { db } from '@buildd/core/db';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { recalculateOverall } from '@buildd/core/mission-helpers';
import type { GoalCriteriaState } from '@buildd/shared';
import { dispatchNewTask } from '@/lib/task-dispatch';

/**
 * `command` goal criteria: verified by running the command, never by asking a
 * model whether it would pass.
 *
 * A criterion like "no double-fire" or "rows exist" written as prose needs an
 * LLM, an API key, and a reachable model at the exact moment a verdict is owed —
 * three things that can each silently not happen, and when they don't, the
 * criterion reads NOT_EVALUATED. The same claim written as `bun test
 * path/to/double-fire.test.ts` needs none of them: buildd already runs commands
 * for loop-until-verified tasks and returns tamper-evident evidence bound to
 * (workerId, iteration). This module reuses that machinery for criteria.
 *
 * Flow:
 *   1. `dispatchCommandCriterionTask` creates a bookkeeping task carrying
 *      `loopConfig.exitCondition = { type: 'command', command }`. The runner runs
 *      the command after the agent finishes and posts `verificationEvidence`.
 *      The criterion goes to PENDING with the task id recorded.
 *   2. `handleCriteriaVerificationOutcome` turns that evidence into pass/fail on
 *      the criterion, re-folds the mission verdict, and re-attempts completion.
 *
 * The task is `taskClass: 'bookkeeping'` on purpose: a verification task counted
 * as a deliverable would keep `pendingDeliverables > 0` and the mission could
 * never complete — the criterion would block on itself.
 */

/** Context marker on a verification task, read back on completion. */
export interface CriteriaVerificationContext {
  missionId: string;
  criterionIndex: number;
  command: string;
}

/**
 * How long a command verdict stays fresh. Past this, the next completion attempt
 * re-runs the command instead of trusting the cached result: a verdict is a
 * statement about the code as it is now, not a permanent property of the mission.
 */
export const COMMAND_VERDICT_TTL_MS = 30 * 60 * 1000;

const VERIFY_TASK_TITLE_PREFIX = 'Verify goal criterion:';

function shortCommand(command: string): string {
  const text = typeof command === 'string' ? command : '';
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

/**
 * In-flight or recently-terminal verification task for one criterion, if any.
 *
 * The marker is matched in SQL, not by scanning the newest N bookkeeping rows: a
 * heartbeat mission inserts a bookkeeping planning row every cycle, so any fixed
 * window is eventually all heartbeat rows. The verification task would then be
 * invisible, both reuse paths would go dead, and every evaluation round would
 * dispatch a duplicate — pushing the window further out of reach.
 */
async function findVerificationTask(missionId: string, criterionIndex: number) {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      sql`${tasks.context}->'criteriaVerification'->>'criterionIndex' = ${String(criterionIndex)}`,
    ),
    columns: { id: true, status: true, context: true, result: true, updatedAt: true },
    orderBy: [desc(tasks.createdAt)],
    limit: 5,
  });
  // Re-check in JS so a mocked/loose `where` can never widen the match.
  return rows.find(r => {
    const marker = (r.context as Record<string, unknown> | null)?.criteriaVerification as
      | CriteriaVerificationContext
      | undefined;
    return marker?.missionId === missionId && marker.criterionIndex === criterionIndex;
  }) ?? null;
}

export type CommandCriterionResolution =
  | { kind: 'pending'; taskId: string; evidence: string }
  | { kind: 'verdict'; verdict: 'pass' | 'fail' | 'UNVERIFIED'; taskId: string; evidence: string }
  | { kind: 'unavailable'; evidence: string };

/**
 * Ensure a `command` criterion has, or is about to have, a real verdict.
 *
 * Returns `verdict` when a fresh run for this exact command already answered,
 * `pending` when a run is in flight or has just been dispatched, and
 * `unavailable` when the mission has nowhere to run a command (no workspace) —
 * which correctly leaves the criterion unevaluated rather than pretending.
 */
export async function resolveCommandCriterion(opts: {
  missionId: string;
  criterionIndex: number;
  command: string;
  label?: string;
  now?: number;
}): Promise<CommandCriterionResolution> {
  const { missionId, criterionIndex, command } = opts;
  const now = opts.now ?? Date.now();

  // Rows written before the command field was validated can carry no command at
  // all. There is nothing to run, so say so — do not throw, or the operator's
  // "Run verification" button 500s on the exact mission that needs fixing.
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      kind: 'unavailable',
      evidence: 'Command criterion has no command to run — edit the criterion to supply one',
    };
  }

  const existing = await findVerificationTask(missionId, criterionIndex);
  if (existing) {
    const marker = (existing.context as Record<string, unknown>)?.criteriaVerification as CriteriaVerificationContext;
    const sameCommand = marker?.command === command;
    const terminal = ['completed', 'failed', 'cancelled'].includes(existing.status);

    if (!terminal) {
      const waitedMs = now - new Date(existing.updatedAt).getTime();
      const stalled = waitedMs > 2 * COMMAND_VERDICT_TTL_MS;
      return {
        kind: 'pending',
        taskId: existing.id,
        // A verification task nothing ever claims would otherwise read as a
        // normal "in flight" forever, holding the mission open with no clue why.
        evidence: stalled
          ? `Verification task ${existing.id.slice(0, 8)} has been ${existing.status} for ${Math.round(waitedMs / 60000)}m — no runner has claimed it: ${shortCommand(command)}`
          : `Verification task ${existing.id.slice(0, 8)} is ${existing.status}: ${shortCommand(command)}`,
      };
    }

    const age = now - new Date(existing.updatedAt).getTime();
    const run = classifyCommandRun(existing.result as Record<string, unknown> | null);
    if (sameCommand && age < COMMAND_VERDICT_TTL_MS && run !== null) {
      // `run` is the recorded outcome of the command itself, not the task's
      // status. A task can reach `completed` without the command ever running —
      // the stale-worker reaper re-creates a task from its context but drops
      // `loopConfig`, so the clone has no verification step at all. Trusting
      // status there would hand the criterion a pass on an agent's self-report,
      // which is the substitution this whole module exists to prevent.
      //
      // `unresolved` (timeout / exec error) is neither: the command never
      // demonstrably asserted anything, so it cannot be evidence the criterion
      // is unmet. Landing it as `fail` blocks completion on an environment
      // problem and reads as a real code defect; `UNVERIFIED` routes it through
      // the same ungradeable-criteria escalation as any other unproducible verdict.
      const verdict = run === 'unresolved' ? 'UNVERIFIED' : run === 'ok' ? 'pass' : 'fail';
      return {
        kind: 'verdict',
        verdict,
        taskId: existing.id,
        evidence: verdictEvidence(verdict, command, existing.result as Record<string, unknown> | null),
      };
    }
    // Stale, the command changed, or the command never actually ran — run it again.
  }

  const dispatched = await dispatchCommandCriterionTask({ missionId, criterionIndex, command, label: opts.label });
  if (!dispatched.ok) return { kind: 'unavailable', evidence: dispatched.reason };
  return {
    kind: 'pending',
    taskId: dispatched.taskId,
    evidence: `Verification task ${dispatched.taskId.slice(0, 8)} dispatched: ${shortCommand(command)}`,
  };
}

/** The three ways a recorded command run can resolve. See {@link classifyCommandRun}. */
type CommandRunOutcome = 'ok' | 'failed' | 'unresolved';

/**
 * Did the command actually execute, and if so, what did it assert? Reads the
 * loop history the completion route writes from the runner's evidence.
 *
 * Returns `null` when there is no record of a run at all — which is NOT a
 * verdict and must never be read as one. Otherwise distinguishes:
 * - `ok`: exited 0.
 * - `failed`: ran and exited non-zero on its own assertion (a real test
 *   failure, a lint error, etc.) — this is genuine evidence the criterion is
 *   unmet.
 * - `unresolved`: the runner's own evidence marks this `timeout` or
 *   `exec_error` (see `RunnerVerificationEvidence` in loop-dispatcher.ts) —
 *   the command never got far enough to assert anything, so it is not
 *   evidence of anything either way. Falls back to the collapsed `satisfied`
 *   boolean when older evidence carries no `outcome` field.
 */
function classifyCommandRun(result: Record<string, unknown> | null): CommandRunOutcome | null {
  const history = (result?.loopHistory as Array<Record<string, unknown>> | undefined) ?? [];
  const last = history[history.length - 1];
  if (!last || typeof last.satisfied !== 'boolean') return null;

  const outcome = (last.evidence as Record<string, unknown> | undefined)?.outcome;
  if (typeof outcome === 'string') {
    if (outcome === 'ok') return 'ok';
    if (outcome === 'timeout' || outcome === 'exec_error') return 'unresolved';
    return 'failed';
  }
  return last.satisfied ? 'ok' : 'failed';
}

function verdictEvidence(
  verdict: 'pass' | 'fail' | 'UNVERIFIED',
  command: string,
  result: Record<string, unknown> | null,
): string {
  const history = (result?.loopHistory as Array<Record<string, unknown>> | undefined) ?? [];
  const last = history[history.length - 1];
  const summary = typeof last?.summary === 'string' ? last.summary : null;
  if (verdict === 'pass') return `\`${shortCommand(command)}\` exited 0${summary ? ` (${summary})` : ''}`;
  if (verdict === 'UNVERIFIED') {
    return `\`${shortCommand(command)}\` could not be evaluated (environment error, not a code failure)${summary ? ` — ${summary}` : ''}`;
  }
  return `\`${shortCommand(command)}\` did not pass${summary ? ` — ${summary}` : ''}`;
}

/**
 * Create + dispatch the verification task for one command criterion.
 *
 * Fails cleanly (never throws) when the mission has no workspace: a coordination
 * mission has no repo to run a command in, and a criterion that cannot be run is
 * honestly unevaluated.
 */
export async function dispatchCommandCriterionTask(opts: {
  missionId: string;
  criterionIndex: number;
  command: string;
  label?: string;
}): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  const { missionId, criterionIndex, command } = opts;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    // `integrationBranchEnabled` is load-bearing here, not decorative: the
    // column list is explicit, so omitting it would read `undefined` and
    // quietly send every mission's verify task at a branch that may not exist.
    columns: { id: true, title: true, workspaceId: true, workingBranch: true, integrationBranchEnabled: true },
  });
  if (!mission) return { ok: false, reason: `Mission ${missionId} not found` };
  if (!mission.workspaceId) {
    return {
      ok: false,
      reason: 'Command criterion cannot run: mission has no workspace (nowhere to execute the command)',
    };
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, mission.workspaceId),
  });
  if (!workspace) return { ok: false, reason: 'Command criterion cannot run: workspace not found' };

  const verificationContext: CriteriaVerificationContext = { missionId, criterionIndex, command };

  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: mission.workspaceId,
      title: `${VERIFY_TASK_TITLE_PREFIX} ${opts.label ?? shortCommand(command)}`,
      description:
        `## Goal criterion verification\n\n` +
        `Mission: **${mission.title}**\n\n` +
        `Run this command and report what happened. Do NOT change code, do NOT open a PR, ` +
        `do NOT fix failures — this task only observes.\n\n` +
        '```sh\n' + command + '\n```\n\n' +
        `The runner re-runs the command itself after you finish and reports its exit code as ` +
        `tamper-evident evidence; that exit code — not your summary — is the criterion's verdict. ` +
        `Keep your turn short.`,
      priority: 2,
      status: 'pending',
      mode: 'execution',
      // Bookkeeping: a verification task counted as a deliverable would keep the
      // mission's pending count above zero and block the very completion it gates.
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      missionId,
      outputRequirement: 'none',
      tier: 'budget',
      loopConfig: {
        exitCondition: { type: 'command', command },
        maxLoops: 1,
      },
      context: {
        criteriaVerification: verificationContext,
        verificationCommand: command,
        // Run the command against the mission's own code. The runner cuts the
        // worktree from `context.baseBranch` (`resolveWorktreeBase`), so without
        // this the command runs on the workspace default branch and the verdict
        // describes code the mission has not landed — a criterion that goes
        // green while the mission's work is still unverified (and one that can
        // go red for a failure the mission already fixed).
        //
        // `baseBranch`, not `resumeBranch`: both feed the same base ladder, but
        // `resumeBranch` also makes the runner build a "Prior Attempt — assess,
        // then continue or restart" prompt section, which contradicts this
        // task's observe-only instructions. `headBranch` alone would only rename
        // the worker's push branch and leave the base wrong.
        //
        // Never the default branch: this is the mission's working branch, so it
        // cannot reproduce the old degradation where a worktree asked to check
        // out the default branch failed setup and fell back to the shared clone.
        //
        // Gated on the Option A′ opt-in, not merely on the column being set.
        // `runMission` generates a `workingBranch` for EVERY mission with a
        // repo, but nothing pushes to it unless the mission opted in — so for a
        // non-opted-in mission this was naming a ref that does not exist on the
        // remote. That degraded (the runner falls back to trunk) rather than
        // failing, which is exactly why it went unnoticed; it also meant a
        // `mission/*` base ref could be recorded for a mission that never opted
        // in, which is the one input that makes the release queue's branch-shape
        // heuristic wrong.
        ...(missionIntegrationBase(mission) ? { baseBranch: missionIntegrationBase(mission)! } : {}),
        // Opt out of the mission-task auto-retry: a criterion deserves one honest
        // run, and a silent second attempt would delay the verdict it produces.
        retryCount: 1,
      },
    } as any)
    .returning({ id: tasks.id });

  if (!task) return { ok: false, reason: 'Command criterion task insert returned no row' };

  await dispatchNewTask(
    { id: task.id, title: `${VERIFY_TASK_TITLE_PREFIX} ${shortCommand(command)}`, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 2, missionId },
    workspace as any,
  ).catch(e => console.error(`[criteria-verify] dispatch failed for task ${task.id}:`, e));

  console.log(`[criteria-verify] mission ${missionId} criterion ${criterionIndex}: dispatched ${task.id} for \`${command}\``);
  return { ok: true, taskId: task.id };
}

/**
 * Hand a finished verification task's evidence back to the criterion it answers.
 *
 * Called from the worker-completion hooks for any task carrying a
 * `criteriaVerification` marker. Writes the pass/fail onto the mission's stored
 * criteria state, re-folds `overall`, then re-attempts completion — so a command
 * criterion turning green is itself a completion trigger and nobody has to wait
 * for the next heartbeat.
 */
export async function handleCriteriaVerificationOutcome(
  taskId: string,
  evidence?: unknown,
): Promise<{ applied: boolean; verdict?: 'pass' | 'fail' | 'UNVERIFIED' }> {
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskId),
    columns: { id: true, status: true, context: true, result: true, missionId: true },
  });
  if (!task) return { applied: false };

  const marker = (task.context as Record<string, unknown> | null)?.criteriaVerification as
    | CriteriaVerificationContext
    | undefined;
  if (!marker || !task.missionId) return { applied: false };

  // Not terminal yet (e.g. requeued for another attempt) — the verdict is still owed.
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return { applied: false };

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, task.missionId),
    columns: { id: true, goalCriteria: true, goalCriteriaState: true },
  });
  const state = (mission?.goalCriteriaState ?? null) as GoalCriteriaState | null;
  if (!state) return { applied: false };

  const criterion = state.criteria.find(c => c.index === marker.criterionIndex);
  if (!criterion) return { applied: false };

  // Identity check. The criterion array may have been edited while this task was
  // in flight, in which case index `n` now points at a different criterion and
  // writing this exit code onto it would be a verdict transplant.
  const currentCriteria = Array.isArray(mission?.goalCriteria) ? mission!.goalCriteria as Array<Record<string, unknown>> : [];
  const currentAtIndex = currentCriteria[marker.criterionIndex];
  if (!currentAtIndex || currentAtIndex.type !== 'command' || currentAtIndex.command !== marker.command) {
    console.warn(
      `[criteria-verify] mission ${task.missionId} criterion ${marker.criterionIndex} changed while task ${task.id} ran — discarding its verdict`
    );
    return { applied: false };
  }

  // The verdict comes from the runner's evidence, or from the loop history the
  // completion route wrote from that evidence. With neither, the command did not
  // demonstrably run — a `completed` task proves nothing on its own (see
  // `classifyCommandRun`), so leave the criterion unresolved rather than passing
  // it on an agent's word.
  //
  // `timeout` / `exec_error` land as UNVERIFIED, not `fail`: the command never
  // got far enough to assert anything, so a runner-side environment problem is
  // not evidence the criterion is unmet. Only a real non-zero exit from the
  // command's own assertion is.
  const ev = (evidence && typeof evidence === 'object' ? evidence as Record<string, unknown> : null);
  const ran = classifyCommandRun(task.result as Record<string, unknown> | null);
  let verdict: 'pass' | 'fail' | 'UNVERIFIED';
  if (ev && typeof ev.outcome === 'string') {
    verdict = ev.outcome === 'ok' ? 'pass' : ev.outcome === 'timeout' || ev.outcome === 'exec_error' ? 'UNVERIFIED' : 'fail';
  } else if (ran !== null) {
    verdict = ran === 'ok' ? 'pass' : ran === 'unresolved' ? 'UNVERIFIED' : 'fail';
  } else {
    // Neither the runner's evidence nor the loop history says the command ever
    // ran. That holds even when the task itself reached `failed`/`cancelled` —
    // a sandbox setup failure, an uncaught exception before the loop started,
    // or a worker crash/heartbeat expiry all fail the *task* without the
    // command ever demonstrably running. Grading that as `fail` would blame
    // the code for an environment problem the command never weighed in on, so
    // leave the criterion unresolved instead, same as a `completed` task with
    // no proof of a run.
    console.warn(
      `[criteria-verify] verification task ${task.id} finished with no command evidence — criterion ${marker.criterionIndex} left unresolved`
    );
    return { applied: false };
  }

  criterion.verdict = verdict;
  criterion.workerTaskId = task.id;
  criterion.evidence = ev
    ? (verdict === 'pass'
        ? `\`${shortCommand(marker.command)}\` exited 0 (verification task ${task.id.slice(0, 8)})`
        : verdict === 'UNVERIFIED'
          ? `\`${shortCommand(marker.command)}\` could not be evaluated: exit ${String(ev.exitCode ?? '?')}, outcome ${String(ev.outcome)} (environment error, not a code failure)`
          : `\`${shortCommand(marker.command)}\` failed: exit ${String(ev.exitCode ?? '?')}, outcome ${String(ev.outcome)}`)
    : verdictEvidence(verdict, marker.command, task.result as Record<string, unknown> | null);

  const next: GoalCriteriaState = {
    ...state,
    evaluatedAt: new Date().toISOString(),
    overall: recalculateOverall(state.criteria),
    criteria: state.criteria,
  };

  await db
    .update(missions)
    .set({ goalCriteriaState: next as any, updatedAt: new Date() })
    .where(eq(missions.id, task.missionId));

  console.log(
    `[criteria-verify] mission ${task.missionId} criterion ${marker.criterionIndex} → ${verdict}; overall ${next.overall}`
  );

  // A criterion turning green is a completion trigger in its own right. Reuse the
  // verdict we just wrote — no need to re-evaluate and re-dispatch.
  const { completeMissionIfVerified } = await import('@/lib/mission-completion');
  await completeMissionIfVerified(task.missionId, { path: 'criteria_eval', predicate: `verification task ${task.id}`, evaluateCriteria: false })
    .catch(e => console.error(`[criteria-verify] completion attempt failed for ${task.missionId}:`, e));

  return { applied: true, verdict };
}

/** True when this task is a criteria verification task (cheap context check). */
export function isCriteriaVerificationTask(context: unknown): boolean {
  const marker = (context as Record<string, unknown> | null)?.criteriaVerification as
    | CriteriaVerificationContext
    | undefined;
  return typeof marker?.missionId === 'string' && typeof marker.criterionIndex === 'number';
}
