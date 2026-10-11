import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, tasks, workspaces } from '@buildd/core/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { checkCommandAt, checkVerdict, criterionChecks, type CriterionCheck } from './check-lines';
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
 * already has one. Two deliveries racing on one head both insert, then both
 * read the runs for the key: the earliest stands and the later one deletes its
 * own row before anything could claim it, so exactly one run is woken.
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
    const [row] = await db.insert(tasks).values({
      workspaceId: p.workspaceId,
      title,
      description:
        '## Spec criterion check\n\n' +
        `Run this command and report what happened. Do NOT change code, do NOT open a PR, do NOT fix failures: this task only observes.\n\n` +
        '```sh\n' + command + '\n```\n\n' +
        'The runner re-runs the command itself after you finish and reports its exit code. That exit code, not your summary, ' +
        `is the verdict on ${check.criterionId}. Keep your turn short.`,
      priority: 2,
      status: 'pending',
      mode: 'execution',
      // Bookkeeping: a check run is not a deliverable of anything.
      taskClass: 'bookkeeping',
      creationSource: 'orchestrator',
      outputRequirement: 'none',
      tier: 'budget',
      loopConfig: { exitCondition: { type: 'command', command }, maxLoops: 1 },
      context: {
        specCriterionCheck: marker,
        verificationCommand: command,
        // Cut the worktree from the PR branch; the command checks out headSha itself.
        ...(opts.headBranch ? { baseBranch: opts.headBranch } : {}),
        // One honest run per head: no silent second attempt.
        retryCount: 1,
      },
    } as never).returning({ id: tasks.id });
    if (!row) continue;

    const runs = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.workspaceId, p.workspaceId), sameRun(key)))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    if (runs[0]?.id !== row.id) {
      await db.delete(tasks).where(eq(tasks.id, row.id));
      continue;
    }
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
