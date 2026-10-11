import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { checkCommandAt, checkVerdict, criterionChecks, type CriterionCheck } from './check-lines';
import { isRunnerReported } from '@/lib/verification-provenance';
import { recordCheckVerdict } from './outcome';
import { readPinnedSpecRevision } from './pin';

/**
 * Mechanical criterion checks (Living Specs V1). A criterion of a task's
 * pinned, approved revision that names a check command (./check-lines.ts) is
 * verified by running that command on the task's PR head, the way a `command`
 * goal criterion is (lib/mission-criteria-verify.ts): a bookkeeping task with
 * a command exit condition, so the runner runs it and reports the exit code as
 * evidence. That exit code, not an agent's summary, is the verdict, recorded
 * in `spec_outcome_verdicts` at the head it ran on and authored by the check.
 *
 * One run per (task, revision, criterion, head): a redelivered webhook or a
 * second event for the same head finds the run already filed. Criteria with no
 * check stay graded by the reviewer or a person. Advisory (D-5): a failed
 * check reads as a failed outcome and blocks nothing.
 */

export interface CriterionCheckMarker {
  subjectTaskId: string;
  specRevisionId: string;
  criterionId: string;
  headSha: string;
  command: string;
}

const MAX_EXCERPT = 2000;
const SHA40 = /^[0-9a-f]{40}$/;
const TITLE_PREFIX = 'Check spec criterion';

type Wake = (task: { id: string; title: string; workspaceId: string }) => Promise<void>;
export interface CheckDeps { wake?: Wake }

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const markerOf = (context: unknown): CriterionCheckMarker | null => {
  const m = asRecord(asRecord(context)?.specCriterionCheck);
  if (!m) return null;
  const { subjectTaskId, specRevisionId, criterionId, headSha, command } = m;
  return typeof subjectTaskId === 'string' && typeof specRevisionId === 'string' && typeof criterionId === 'string'
    && typeof headSha === 'string' && typeof command === 'string'
    ? { subjectTaskId, specRevisionId, criterionId, headSha, command }
    : null;
};

/** True when this task is a criterion check run (cheap context check). */
export function isCriterionCheckTask(context: unknown): boolean {
  return markerOf(context) !== null;
}

async function defaultWake(task: { id: string; title: string; workspaceId: string }): Promise<void> {
  const { announceTaskCreated, wakeTask } = await import('@/lib/dispatch-authority');
  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, task.workspaceId) });
  if (!workspace) return;
  await announceTaskCreated({ ...task, description: null, mode: 'execution', priority: 2, missionId: null }, workspace as never)
    .catch((e) => console.error(`[spec-checks] dispatch failed for task ${task.id}:`, e));
  await wakeTask(task.id, 'task.created');
}

/** The checks a task's pinned revision names, or why there are none. */
async function pinnedChecks(taskId: string): Promise<
  { ok: true; workspaceId: string; specRevisionId: string; checks: CriterionCheck[] } | { ok: false; reason: string }
> {
  if (!isUuid(taskId)) return { ok: false, reason: 'not a task id' };
  const [task] = await db.select({ workspaceId: tasks.workspaceId, context: tasks.context }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { ok: false, reason: 'task not found' };
  const pin = asRecord(asRecord(task.context)?.specSource);
  if (!pin || typeof pin.specRevisionId !== 'string') return { ok: false, reason: 'the task is not pinned to a Living Spec revision' };
  const read = await readPinnedSpecRevision(pin);
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, workspaceId: task.workspaceId, specRevisionId: pin.specRevisionId, checks: criterionChecks(read.body) };
}

const sameRun = (m: Omit<CriterionCheckMarker, 'command'>) =>
  sql`${tasks.context} @> ${JSON.stringify({ specCriterionCheck: m })}::jsonb`;

/**
 * File one check run per checked criterion for `headSha`, unless that head
 * already has one. Deliveries racing on one head serialize on a per-key lock,
 * so exactly one run is filed and woken.
 */
export async function dispatchCriterionChecks(
  opts: { taskId: string; headSha: string; headBranch: string | null },
  deps: CheckDeps = {},
): Promise<{ dispatched: number; reason?: string }> {
  const headSha = opts.headSha.toLowerCase();
  if (!SHA40.test(headSha)) return { dispatched: 0, reason: 'headSha must be a full commit SHA' };
  const p = await pinnedChecks(opts.taskId);
  if (!p.ok) return { dispatched: 0, reason: p.reason };
  if (p.checks.length === 0) return { dispatched: 0, reason: 'no criterion of the pinned revision names a check' };
  const wake = deps.wake ?? defaultWake;

  let dispatched = 0;
  for (const check of p.checks) {
    const key = { subjectTaskId: opts.taskId, specRevisionId: p.specRevisionId, criterionId: check.criterionId, headSha };
    const [existing] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, p.workspaceId), sameRun(key))).limit(1);
    if (existing) continue;

    const command = checkCommandAt(check.command, headSha);
    const marker: CriterionCheckMarker = { ...key, command: check.command };
    const title = `${TITLE_PREFIX} ${check.criterionId} at ${headSha.slice(0, 7)}`;
    const description =
      '## Spec criterion check\n\n' +
      `Run this command and report what happened. Do NOT change code, do NOT open a PR, do NOT fix failures: this task only observes.\n\n` +
      '```sh\n' + command + '\n```\n\n' +
      'The runner re-runs the command itself after you finish and reports its exit code. That exit code, not your summary, ' +
      `is the verdict on ${check.criterionId}. Keep your turn short.`;
    const loopConfig = { exitCondition: { type: 'command', command }, maxLoops: 1 };
    const context = {
      specCriterionCheck: marker,
      verificationCommand: command,
      // Cut the worktree from the PR branch; the command checks out headSha itself.
      ...(opts.headBranch ? { baseBranch: opts.headBranch } : {}),
      // One honest run per head: no silent second attempt.
      retryCount: 1,
    };
    // One statement under a per-key lock, in one transaction: a racing delivery
    // waits for the first to commit, then finds its run and inserts nothing.
    // (Insert-then-read-back could not do this: a racer whose insert commits
    // after the other's read, with an earlier created_at, also won.)
    const lockKey = `${opts.taskId}:${p.specRevisionId}:${check.criterionId}:${headSha}`;
    const [, inserted] = await db.batch([
      db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('spec_criterion_check'), hashtext(${lockKey}))`),
      // Bookkeeping: a check run is not a deliverable of anything.
      db.execute(sql`
        INSERT INTO ${tasks} (workspace_id, title, description, priority, status, mode, task_class, creation_source, output_requirement, tier, loop_config, context)
        SELECT ${p.workspaceId}::uuid, ${title}, ${description}, 2, 'pending', 'execution', 'bookkeeping', 'orchestrator', 'none', 'budget',
          ${JSON.stringify(loopConfig)}::jsonb, ${JSON.stringify(context)}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${tasks} t_run
          WHERE t_run.workspace_id = ${p.workspaceId}::uuid
          AND t_run.context @> ${JSON.stringify({ specCriterionCheck: key })}::jsonb
        )
        RETURNING id
      `),
    ]);
    const row = (inserted as { rows?: Array<Record<string, unknown>> })?.rows?.[0] as { id: string } | undefined;
    if (!row) continue;
    await wake({ id: row.id, title, workspaceId: p.workspaceId });
    dispatched++;
  }
  return { dispatched };
}

const excerpt = (v: unknown) => (typeof v === 'string' ? v.slice(-MAX_EXCERPT) : undefined);

/**
 * Turn a finished check run's evidence into the verdict at its head. Records
 * nothing unless the run is exactly what dispatch filed: the subject is still
 * pinned to the revision, that revision still names this command for this
 * criterion, and the run's command is that command at that head. So a task
 * that files a lookalike run, or marks itself, cannot grade its own outcome.
 */
export async function handleCriterionCheckOutcome(
  verificationTaskId: string,
  evidence?: unknown,
): Promise<{ recorded: boolean; verdict?: string; reason?: string }> {
  if (!isUuid(verificationTaskId)) return { recorded: false, reason: 'not a task id' };
  const [task] = await db.select({
    id: tasks.id, status: tasks.status, workspaceId: tasks.workspaceId, context: tasks.context,
    loopConfig: tasks.loopConfig, result: tasks.result, creationSource: tasks.creationSource,
  }).from(tasks).where(eq(tasks.id, verificationTaskId)).limit(1);
  const marker = markerOf(task?.context);
  if (!task || !marker) return { recorded: false, reason: 'not a criterion check run' };
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return { recorded: false, reason: 'the run has not finished' };
  if (marker.subjectTaskId === task.id || task.creationSource !== 'orchestrator') return { recorded: false, reason: 'not a run buildd filed' };

  const p = await pinnedChecks(marker.subjectTaskId);
  if (!p.ok) return { recorded: false, reason: p.reason };
  const check = p.checks.find((c) => c.criterionId === marker.criterionId);
  if (p.workspaceId !== task.workspaceId || p.specRevisionId !== marker.specRevisionId || !check || check.command !== marker.command) {
    return { recorded: false, reason: 'the pinned revision no longer names this check' };
  }
  if (!SHA40.test(marker.headSha)) return { recorded: false, reason: 'the run names no full head SHA' };
  const expected = checkCommandAt(check.command, marker.headSha);
  const exit = asRecord(asRecord(task.loopConfig)?.exitCondition);
  if (exit?.type !== 'command' || exit.command !== expected) return { recorded: false, reason: 'the run is not the check command at its head' };

  // The runner's evidence from this report, else the loop history the completion route wrote from it.
  const history = (asRecord(task.result)?.loopHistory as Array<Record<string, unknown>> | undefined) ?? [];
  const ev = asRecord(evidence) ?? asRecord(history[history.length - 1]?.evidence);
  if (!ev) return { recorded: false, reason: 'no command evidence' };
  // The agent in the check run holds a task token and may PATCH its own
  // worker; what it reports that way is its word, not the runner's run.
  if (!isRunnerReported(ev)) return { recorded: false, reason: 'the evidence was reported by the agent in the run, not by the runner' };
  if (ev.command !== undefined && ev.command !== expected) return { recorded: false, reason: 'the evidence is for a different command' };
  const verdict = checkVerdict(ev);
  if (!verdict) return { recorded: false, reason: 'the evidence has no outcome' };

  const [done] = await db.select({ id: specOutcomeVerdicts.id }).from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.taskId, marker.subjectTaskId), sql`${specOutcomeVerdicts.evidence}->>'verificationTaskId' = ${task.id}`)).limit(1);
  if (done) return { recorded: false, reason: 'already recorded' };

  const r = await recordCheckVerdict(marker.subjectTaskId, {
    specRevisionId: marker.specRevisionId,
    criterionId: marker.criterionId,
    verdict,
    headSha: marker.headSha,
    verificationTaskId: task.id,
    evidence: {
      kind: 'check',
      command: check.command,
      outcome: ev.outcome,
      ...(typeof ev.exitCode === 'number' ? { exitCode: ev.exitCode } : {}),
      ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
      ...(excerpt(ev.stdout) ? { stdout: excerpt(ev.stdout) } : {}),
      ...(excerpt(ev.stderr) ? { stderr: excerpt(ev.stderr) } : {}),
    },
  });
  if (!r.ok) return { recorded: false, reason: r.error };
  return { recorded: true, verdict };
}
