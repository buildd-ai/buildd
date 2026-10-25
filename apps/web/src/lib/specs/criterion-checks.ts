import { db } from '@buildd/core/db';
import { missions, specs, specOutcomeVerdicts, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { checkCommandAt, checkVerdict, criterionChecks, type CriterionCheck } from '@buildd/spec-contract/check-lines';
import { isRunnerReported } from '@/lib/verification-provenance';
import { recordCheckVerdict } from './outcome';
import { readPinnedSpecRevision } from './pin';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { livingSpecCriteriaOf } from './selected-scope';
import { isRepoPath } from '@buildd/spec-contract/repo-copy';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { scopeOf } from '@buildd/spec-contract/scope';
import { REGISTERED_VERIFIER_REGISTRY } from '@buildd/spec-contract/verification-bindings';
import { planRegisteredChecks, type PlannedRegisteredCheck } from './registered-verification';

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
 * second event for the same head finds the run already filed. A mission's
 * final verification runs one per (mission, revision, criterion, command,
 * head), whichever verification task asks. Criteria with no
 * check stay graded by the reviewer or a person. Advisory (D-5): a failed
 * check reads as a failed outcome and blocks nothing.
 *
 * Registered `verify:` bindings of a pinned task's revision are dispatched the
 * same way (R-6): one run per (task, revision, criterion, binding fingerprint,
 * head). That run only asks the explicit verify route
 * (api/specs/outcomes/[taskId]/verify) to grade the subject, so the registered
 * coordinator, its authority and its verdict vocabulary decide the result; the
 * run task records nothing itself, and is never the subject. A mission's final
 * verification runs its registered checks in-process instead
 * (./mission-acceptance-checks.ts), through the same coordinator.
 */

export interface CriterionCheckMarker {
  subjectTaskId: string;
  specRevisionId: string;
  criterionId: string;
  headSha: string;
  command: string;
  /** Set on a mission's run: the run belongs to the mission, and `subjectTaskId` is the verification that first filed it. */
  missionId?: string;
}

const MAX_EXCERPT = 2000;
const SHA40 = /^[0-9a-f]{40}$/;
const TITLE_PREFIX = 'Check spec criterion';

type Wake = (task: { id: string; title: string; workspaceId: string; missionId?: string }) => Promise<void>;
export interface CheckDeps { wake?: Wake }

type MissionVerdictRecorder = (missionId: string, input: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; error: string }>;
let recordMissionVerdict: MissionVerdictRecorder | null = null;
/** The missions module registers how a final-verification check's verdict is recorded; core does not import it. */
export function registerMissionVerdictRecorder(fn: MissionVerdictRecorder): void { recordMissionVerdict = fn; }

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export interface RegisteredCheckMarker {
  subjectTaskId: string;
  specRevisionId: string;
  criterionId: string;
  /** Revision + wording + complete binding (planRegisteredChecks' fingerprint). */
  binding: string;
  headSha: string;
}

const markerOf = (context: unknown): CriterionCheckMarker | null => {
  const m = asRecord(asRecord(context)?.specCriterionCheck);
  if (!m) return null;
  const { subjectTaskId, specRevisionId, criterionId, headSha, command, missionId } = m;
  return typeof subjectTaskId === 'string' && typeof specRevisionId === 'string' && typeof criterionId === 'string'
    && typeof headSha === 'string' && typeof command === 'string'
    ? { subjectTaskId, specRevisionId, criterionId, headSha, command, ...(typeof missionId === 'string' ? { missionId } : {}) }
    : null;
};

/** True when this task is a criterion check run (cheap context check). */
export function isCriterionCheckTask(context: unknown): boolean {
  return markerOf(context) !== null;
}

async function defaultWake(task: { id: string; title: string; workspaceId: string; missionId?: string }): Promise<void> {
  const { announceTaskCreated, wakeTask } = await import('@/lib/dispatch-authority');
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, task.workspaceId)) });
  if (!workspace) return;
  await announceTaskCreated({ ...task, description: null, mode: 'execution', priority: 2, missionId: task.missionId ?? null }, workspace as never)
    .catch((e) => console.error(`[spec-checks] dispatch failed for task ${task.id}:`, e));
  await wakeTask(task.id, 'task.created');
}

/**
 * PR checks come from the task pin. A platform final verification instead uses
 * the mission selection, plus R-77's criterion-keyed verified_by test paths.
 * Re-read the selection and registrations when accepting results as well, so
 * a withdrawn test or revision cannot still grade the mission.
 */
async function pinnedChecks(taskId: string): Promise<
  { ok: true; workspaceId: string; specRevisionId: string; checks: CriterionCheck[]; registered: PlannedRegisteredCheck[]; missionId?: string } | { ok: false; reason: string }
> {
  if (!isUuid(taskId)) return { ok: false, reason: 'not a task id' };
  const [task] = await db.select({ workspaceId: tasks.workspaceId, context: tasks.context, missionId: tasks.missionId, creationSource: tasks.creationSource }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { ok: false, reason: 'task not found' };
  const final = asRecord(asRecord(task.context)?.finalVerification);
  let pin = asRecord(asRecord(task.context)?.specSource);
  let missionId: string | undefined;
  if (final) {
    if (task.creationSource !== 'orchestrator' || final.missionId !== task.missionId || !task.missionId) return { ok: false, reason: 'not a platform final verification' };
    const mission = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, task.missionId)) });
    const selected = livingSpecCriteriaOf(mission?.goalCriteria).find((c) => c.specRevisionId === final.specRevisionId);
    if (!selected || mission?.workspaceId !== task.workspaceId) return { ok: false, reason: 'the mission no longer selects this revision' };
    pin = { ...selected };
    missionId = task.missionId;
  }
  if (!pin || typeof pin.specRevisionId !== 'string') return { ok: false, reason: 'the task is not pinned to a Living Spec revision' };
  const read = await readPinnedSpecRevision(pin);
  if (!read.ok) return { ok: false, reason: read.reason };
  const scope = scopeOf(pin);
  let registered = criterionChecks(read.body);
  if (missionId && typeof pin.specId === 'string') {
    const spec = await db.query.specs.findFirst({ where: sqlWhere(eq(specs.id, pin.specId)), columns: { metadata: true } });
    const byCriterion = asRecord(asRecord(spec?.metadata)?.verified_by);
    const known = new Set(specCriteria(read.body).map((c) => c.id));
    for (const [criterionId, paths] of Object.entries(byCriterion ?? {})) {
      if (!known.has(criterionId) || !Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && isRepoPath(p))) continue;
      const quote = (v: string) => "'" + v.replace(/'/g, "'\"'\"'") + "'";
      const command = `bun run scripts/run-acceptance-tests.ts ${[criterionId, ...new Set(paths)].map(quote).join(' ')}`;
      registered = registered.filter((c) => c.criterionId !== criterionId);
      registered.push({ criterionId, command });
    }
  }
  const waived = Array.isArray(pin.waived) ? pin.waived as Array<{ criterionId: string }> : [];
  const answers = (criterionId: string) => (!scope || scope.includes(criterionId)) && !waived.some((w) => w.criterionId === criterionId);
  const checks = registered.filter((c) => answers(c.criterionId));
  return {
    ok: true, workspaceId: task.workspaceId, specRevisionId: pin.specRevisionId, checks,
    registered: missionId ? [] : plannedBindings(taskId, task.workspaceId, pin.specRevisionId, read.body).filter((r) => answers(r.criterionId)),
    ...(missionId ? { missionId } : {}),
  };
}

/** The revision's accepted `verify:` bindings, planned without a target (dispatch keys each run by head). An invalid binding plans nothing. */
function plannedBindings(taskId: string, workspaceId: string, specRevisionId: string, body: string): PlannedRegisteredCheck[] {
  try {
    return planRegisteredChecks({
      subject: { kind: 'task', taskId }, workspaceId, specRevisionId, body,
      target: { headSha: '0'.repeat(40) }, registry: REGISTERED_VERIFIER_REGISTRY,
    });
  } catch {
    return [];
  }
}

const sameRun = (key: Record<string, unknown>) =>
  sql`${tasks.context} @> ${JSON.stringify(key)}::jsonb`;

/**
 * File one check run per checked criterion, and one per registered binding,
 * for `headSha`, unless that head already has it. Deliveries racing on one
 * head serialize on a per-key lock, so exactly one run is filed and woken.
 */
export async function dispatchCriterionChecks(
  opts: { taskId: string; headSha: string; headBranch: string | null },
  deps: CheckDeps = {},
): Promise<{ dispatched: number; reason?: string }> {
  const headSha = opts.headSha.toLowerCase();
  if (!SHA40.test(headSha)) return { dispatched: 0, reason: 'headSha must be a full commit SHA' };
  const p = await pinnedChecks(opts.taskId);
  if (!p.ok) return { dispatched: 0, reason: p.reason };
  if (p.checks.length === 0 && p.registered.length === 0) return { dispatched: 0, reason: 'no criterion this task answers for names a check' };
  const wake = deps.wake ?? defaultWake;

  const runs: FiledRun[] = [
    ...p.checks.map((check) => commandRun(opts, p.specRevisionId, headSha, check, p.missionId)),
    ...p.registered.map((planned) => registeredRun(opts, headSha, planned)),
  ];
  let dispatched = 0;
  for (const run of runs) {
    const [existing] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, p.workspaceId), sameRun(run.key))).limit(1);
    if (existing) continue;

    // One statement under a per-key lock, in one transaction: a racing delivery
    // waits for the first to commit, then finds its run and inserts nothing.
    // (Insert-then-read-back could not do this: a racer whose insert commits
    // after the other's read, with an earlier created_at, also won.)
    const [, inserted] = await db.batch([
      db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('spec_criterion_check'), hashtext(${run.lockKey}))`),
      // Bookkeeping: a check run is not a deliverable of anything.
      db.execute(sql`
        INSERT INTO ${tasks} (workspace_id, mission_id, title, description, priority, status, mode, task_class, creation_source, output_requirement, tier, loop_config, context)
        SELECT ${p.workspaceId}::uuid, ${p.missionId ?? null}::uuid, ${run.title}, ${run.description}, 2, 'pending', 'execution', 'bookkeeping', 'orchestrator', 'none', 'budget',
          ${run.loopConfig ? JSON.stringify(run.loopConfig) : null}::jsonb, ${JSON.stringify(run.context)}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${tasks} t_run
          WHERE t_run.workspace_id = ${p.workspaceId}::uuid
          AND t_run.context @> ${JSON.stringify(run.key)}::jsonb
        )
        RETURNING id
      `),
    ]);
    const row = (inserted as { rows?: Array<Record<string, unknown>> })?.rows?.[0] as { id: string } | undefined;
    if (!row) continue;
    await wake({ id: row.id, title: run.title, workspaceId: p.workspaceId, ...(p.missionId ? { missionId: p.missionId } : {}) });
    dispatched++;
  }
  return { dispatched };
}

interface FiledRun {
  /** The context subset that identifies the run: one filed run per key. */
  key: Record<string, unknown>;
  lockKey: string;
  title: string;
  description: string;
  loopConfig: Record<string, unknown> | null;
  context: Record<string, unknown>;
}

type DispatchTarget = { taskId: string; headBranch: string | null };

/**
 * A PR task's run belongs to that task. A mission's run belongs to the
 * mission: every final verification of one target (a re-filed one, or two
 * filed by racing evaluations) reuses the run the first one filed, instead of
 * filing its own set. The command is in the mission key because a mission's
 * command also comes from the spec's verified_by paths, which can change
 * within one revision.
 */
function commandRun(opts: DispatchTarget, specRevisionId: string, headSha: string, check: CriterionCheck, missionId?: string): FiledRun {
  const marker: CriterionCheckMarker = {
    subjectTaskId: opts.taskId, specRevisionId, criterionId: check.criterionId, headSha, command: check.command,
    ...(missionId ? { missionId } : {}),
  };
  const key = missionId
    ? { missionId, specRevisionId, criterionId: check.criterionId, headSha, command: check.command }
    : { subjectTaskId: opts.taskId, specRevisionId, criterionId: check.criterionId, headSha };
  const command = checkCommandAt(check.command, headSha);
  return {
    key: { specCriterionCheck: key },
    lockKey: missionId
      ? `mission:${missionId}:${specRevisionId}:${check.criterionId}:${headSha}`
      : `${opts.taskId}:${specRevisionId}:${check.criterionId}:${headSha}`,
    title: `${TITLE_PREFIX} ${check.criterionId} at ${headSha.slice(0, 7)}`,
    description:
      '## Spec criterion check\n\n' +
      `Run this command and report what happened. Do NOT change code, do NOT open a PR, do NOT fix failures: this task only observes.\n\n` +
      '```sh\n' + command + '\n```\n\n' +
      'The runner re-runs the command itself after you finish and reports its exit code. That exit code, not your summary, ' +
      `is the verdict on ${check.criterionId}. Keep your turn short.`,
    loopConfig: { exitCondition: { type: 'command', command }, maxLoops: 1 },
    context: {
      specCriterionCheck: marker,
      verificationCommand: command,
      // Cut the worktree from the PR branch; the command checks out headSha itself.
      ...(opts.headBranch ? { baseBranch: opts.headBranch } : {}),
      // One honest run per head: no silent second attempt.
      retryCount: 1,
    },
  };
}

function registeredRun(opts: DispatchTarget, headSha: string, planned: PlannedRegisteredCheck): FiledRun {
  const key: RegisteredCheckMarker = {
    subjectTaskId: opts.taskId, specRevisionId: planned.specRevisionId, criterionId: planned.criterionId, binding: planned.fingerprint, headSha,
  };
  const verifier = `${planned.binding.verifier.id}@${planned.binding.verifier.version}`;
  return {
    key: { specRegisteredCheck: key },
    lockKey: `${opts.taskId}:${planned.specRevisionId}:${planned.criterionId}:${planned.fingerprint}:${headSha}`,
    title: `${TITLE_PREFIX} ${planned.criterionId} (${verifier}) at ${headSha.slice(0, 7)}`,
    description:
      '## Registered spec check\n\n' +
      `Request registered verification of task ${opts.taskId}: call \`buildd_artifacts\` action \`manage_specs\` with params ` +
      `\`{ "action": "verify", "taskId": "${opts.taskId}" }\` and nothing else, then report its reply. Do NOT change code, do NOT open a PR, ` +
      'do NOT record a verdict yourself: this task only asks.\n\n' +
      `The server runs \`${verifier}\` on ${planned.criterionId} at the current head with independent evidence and records the ` +
      'result; your summary is not the verdict. Keep your turn short.',
    loopConfig: null,
    context: {
      specRegisteredCheck: key,
      ...(opts.headBranch ? { baseBranch: opts.headBranch } : {}),
      retryCount: 1,
    },
  };
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
  if (marker.missionId !== undefined && marker.missionId !== p.missionId) return { recorded: false, reason: 'the run is not this mission\'s' };
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
    .where(and(p.missionId ? eq(specOutcomeVerdicts.missionId, p.missionId) : eq(specOutcomeVerdicts.taskId, marker.subjectTaskId), sql`${specOutcomeVerdicts.evidence}->>'verificationTaskId' = ${task.id}`)).limit(1);
  if (done) return { recorded: false, reason: 'already recorded' };

  const input = {
    specRevisionId: marker.specRevisionId,
    criterionId: marker.criterionId,
    verdict,
    headSha: marker.headSha,
    verificationTaskId: task.id,
    evidence: {
      kind: 'check',
      verificationTaskId: task.id,
      command: check.command,
      outcome: ev.outcome,
      ...(typeof ev.exitCode === 'number' ? { exitCode: ev.exitCode } : {}),
      ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
      ...(excerpt(ev.stdout) ? { stdout: excerpt(ev.stdout) } : {}),
      ...(excerpt(ev.stderr) ? { stderr: excerpt(ev.stderr) } : {}),
    },
  };
  if (p.missionId && !recordMissionVerdict) return { recorded: false, reason: 'no mission verdict recorder is registered' };
  const r = p.missionId
    ? await recordMissionVerdict!(p.missionId, { ...input, recordedBy: `check:${task.id}` })
    : await recordCheckVerdict(marker.subjectTaskId, input);
  if (!r.ok) return { recorded: false, reason: r.error };
  return { recorded: true, verdict };
}
