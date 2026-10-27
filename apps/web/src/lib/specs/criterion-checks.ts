import { db } from '@buildd/core/db';
import { missions, specs, specOutcomeVerdicts, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { criterionBatchOf, CRITERION_BATCH_MAX_TIMEOUT_MS, TERMINAL_TASK_STATUSES, type CriterionBatchCheck, type CriterionBatchMarker } from '@buildd/shared';
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
import { reportCheckerFault, type CheckerFaultKind } from './checker-fault';

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
 * final verification instead files ONE run for the whole target (R-81): per
 * (mission, revision, head, command set), whichever verification task asks.
 * The runner runs it with no agent session (apps/runner/src/criterion-batch.ts):
 * one checkout, then each criterion's command under its own timeout, and one
 * report with an exit code per criterion, each of which becomes that
 * criterion's verdict. Criteria with no
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
  /** Set on a mission's run: the integrated target (`targetKey` of mission-verification) the run was filed for. */
  targetKey?: string;
}

const MAX_EXCERPT = 2000;
const SHA40 = /^[0-9a-f]{40}$/;
const TITLE_PREFIX = 'Check spec criterion';
const BATCH_TITLE_PREFIX = 'Check spec criteria';

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
  const { subjectTaskId, specRevisionId, criterionId, headSha, command, missionId, targetKey } = m;
  return typeof subjectTaskId === 'string' && typeof specRevisionId === 'string' && typeof criterionId === 'string'
    && typeof headSha === 'string' && typeof command === 'string'
    ? { subjectTaskId, specRevisionId, criterionId, headSha, command, ...(typeof missionId === 'string' ? { missionId } : {}), ...(typeof targetKey === 'string' ? { targetKey } : {}) }
    : null;
};

/** True when this task is a criterion check run (cheap context check). */
export function isCriterionCheckTask(context: unknown): boolean {
  return markerOf(context) !== null || criterionBatchOf(context) !== null;
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
  { ok: true; workspaceId: string; specRevisionId: string; checks: CriterionCheck[]; registered: PlannedRegisteredCheck[]; missionId?: string; targetKey?: string } | { ok: false; reason: string }
> {
  if (!isUuid(taskId)) return { ok: false, reason: 'not a task id' };
  const [task] = await db.select({ workspaceId: tasks.workspaceId, context: tasks.context, missionId: tasks.missionId, creationSource: tasks.creationSource }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) return { ok: false, reason: 'task not found' };
  const final = asRecord(asRecord(task.context)?.finalVerification);
  let pin = asRecord(asRecord(task.context)?.specSource);
  let missionId: string | undefined;
  let targetKey: string | undefined;
  if (final) {
    if (task.creationSource !== 'orchestrator' || final.missionId !== task.missionId || !task.missionId) return { ok: false, reason: 'not a platform final verification' };
    const mission = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, task.missionId)) });
    const selected = livingSpecCriteriaOf(mission?.goalCriteria).find((c) => c.specRevisionId === final.specRevisionId);
    if (!selected || mission?.workspaceId !== task.workspaceId) return { ok: false, reason: 'the mission no longer selects this revision' };
    pin = { ...selected };
    missionId = task.missionId;
    if (typeof final.targetKey === 'string') targetKey = final.targetKey;
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
    // A criterion's own `check:` line is what the approved words say grades it; verified_by only fills in the rest.
    const ownCheck = new Set(registered.map((c) => c.criterionId));
    for (const [criterionId, paths] of Object.entries(byCriterion ?? {})) {
      if (ownCheck.has(criterionId)) continue;
      if (!known.has(criterionId) || !Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && isRepoPath(p))) continue;
      const quote = (v: string) => "'" + v.replace(/'/g, "'\"'\"'") + "'";
      const command = `bun run scripts/run-acceptance-tests.ts ${[criterionId, ...new Set(paths)].map(quote).join(' ')}`;
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
    ...(targetKey ? { targetKey } : {}),
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

export interface PriorMissionRun {
  headSha: string;
  /** The integrated target the run was filed for; null on a run filed before targets were recorded. */
  targetKey: string | null;
  terminal: boolean;
  /** A pass or fail verdict was recorded from this run. */
  concluded: boolean;
}

/**
 * Pure: should a mission's check of one criterion at `headSha` be filed, given
 * the earlier runs of the same (mission, revision, criterion, command)?
 *
 * - A direct mission (`merges:` target) is verified once against its merge
 *   result: a later trunk commit is not a new target, and neither is a run
 *   filed before targets were recorded. Only a new set of merged PRs is.
 * - Otherwise a new head is a new run, unless every earlier run ended without
 *   a pass or fail (a missing test file, a run that never started): the same
 *   inconclusive cause would come back, so nothing is filed. The spec changing
 *   (a new revision or command) or an explicit re-run files again.
 */
export function shouldFileMissionRun(prior: readonly PriorMissionRun[], headSha: string, targetKey: string | null): boolean {
  if (prior.length === 0) return true;
  if (prior.some((r) => r.headSha === headSha)) return false;
  if (targetKey?.startsWith('merges:')) return !prior.some((r) => r.targetKey === null || r.targetKey === targetKey);
  return !(prior.every((r) => r.terminal && !r.concluded));
}

const sameRun = (key: Record<string, unknown>) =>
  sql`${tasks.context} @> ${JSON.stringify(key)}::jsonb`;

/**
 * File one check run per checked criterion, and one per registered binding,
 * for `headSha`, unless that head already has it. Deliveries racing on one
 * head serialize on a per-key lock, so exactly one run is filed and woken.
 */
export async function dispatchCriterionChecks(
  opts: { taskId: string; headSha: string; headBranch: string | null; /** An explicit request to check again despite an earlier inconclusive run. */ rerun?: boolean },
  deps: CheckDeps = {},
): Promise<{ dispatched: number; reason?: string; /** A mission re-run: the batch filed now, or the one already queued or running. */ taskId?: string; inFlight?: boolean }> {
  const headSha = opts.headSha.toLowerCase();
  if (!SHA40.test(headSha)) return { dispatched: 0, reason: 'headSha must be a full commit SHA' };
  const p = await pinnedChecks(opts.taskId);
  if (!p.ok) return { dispatched: 0, reason: p.reason };
  if (p.checks.length === 0 && p.registered.length === 0) return { dispatched: 0, reason: 'no criterion this task answers for names a check' };
  const wake = deps.wake ?? defaultWake;

  const runs: FiledRun[] = p.missionId
    ? (p.checks.length ? [batchRun(opts, p.specRevisionId, headSha, p.checks, p.missionId, p.targetKey)] : [])
    : [
      ...p.checks.map((check) => commandRun(opts, p.specRevisionId, headSha, check)),
      ...p.registered.map((planned) => registeredRun(opts, headSha, planned)),
    ];
  let dispatched = 0;
  let taskId: string | undefined;
  let inFlight = false;
  const terminal = sql.join(TERMINAL_TASK_STATUSES.map((st) => sql`${st}`), sql`, `);
  for (const run of runs) {
    if (run.mission && !opts.rerun && !shouldFileMissionRun(await priorMissionRuns(p.workspaceId, run.mission), headSha, p.targetKey ?? null)) continue;
    // An explicit re-run of a mission's batch files a fresh run at the same head
    // when the earlier one has finished; only a queued or running one blocks it.
    const live = !!(opts.rerun && run.mission);
    const [existing] = await db.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.workspaceId, p.workspaceId), sameRun(run.key), ...(live ? [sql`${tasks.status} NOT IN (${terminal})`] : []))).limit(1);
    if (existing) { if (live) { taskId = existing.id; inFlight = true; } continue; }

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
          ${live ? sql`AND t_run.status NOT IN (${terminal})` : sql``}
        )
        RETURNING id
      `),
    ]);
    const row = (inserted as { rows?: Array<Record<string, unknown>> })?.rows?.[0] as { id: string } | undefined;
    if (!row) continue;
    if (live) taskId = row.id;
    await wake({ id: row.id, title: run.title, workspaceId: p.workspaceId, ...(p.missionId ? { missionId: p.missionId } : {}) });
    dispatched++;
  }
  return { dispatched, ...(taskId ? { taskId } : {}), ...(inFlight ? { inFlight } : {}) };
}

interface FiledRun {
  /** The context subset that identifies the run: one filed run per key. */
  key: Record<string, unknown>;
  lockKey: string;
  title: string;
  description: string;
  loopConfig: Record<string, unknown> | null;
  context: Record<string, unknown>;
  /** A mission's run: what earlier runs of the same command set are looked up by. */
  mission?: { missionId: string; specRevisionId: string; commandSet: string };
}

async function priorMissionRuns(workspaceId: string, m: NonNullable<FiledRun['mission']>): Promise<PriorMissionRun[]> {
  const rows = await db.select({ id: tasks.id, status: tasks.status, context: tasks.context }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), sameRun({ specCriterionBatch: m }))).limit(200);
  if (!rows.length) return [];
  const concluded = await db.select({ taskId: sql<string>`${specOutcomeVerdicts.evidence}->>'verificationTaskId'` }).from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.missionId, m.missionId), sql`${specOutcomeVerdicts.verdict} IN ('pass', 'fail')`, sql`${specOutcomeVerdicts.evidence}->>'verificationTaskId' IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`));
  const done = new Set(concluded.map((r) => r.taskId));
  return rows.flatMap((r) => {
    const marker = criterionBatchOf(r.context);
    return marker ? [{
      headSha: marker.headSha, targetKey: marker.targetKey ?? null,
      terminal: ['completed', 'failed', 'cancelled'].includes(r.status), concluded: done.has(r.id),
    }] : [];
  });
}

type DispatchTarget = { taskId: string; headBranch: string | null };

/** A PR task's run: one per (task, revision, criterion, head). */
function commandRun(opts: DispatchTarget, specRevisionId: string, headSha: string, check: CriterionCheck): FiledRun {
  const marker: CriterionCheckMarker = { subjectTaskId: opts.taskId, specRevisionId, criterionId: check.criterionId, headSha, command: check.command };
  const key = { subjectTaskId: opts.taskId, specRevisionId, criterionId: check.criterionId, headSha };
  const command = checkCommandAt(check.command, headSha);
  return {
    key: { specCriterionCheck: key },
    lockKey: `${opts.taskId}:${specRevisionId}:${check.criterionId}:${headSha}`,
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

const TEST_FILE = /(?:^|[\s'"])[^\s'"]+\.(?:test|spec)\.[cm]?[jt]sx?(?=$|[\s'"])/g;

/**
 * A criterion command's own limit, sized to what it names: two minutes plus
 * one per test file, or ten minutes for a command that names none (a suite or
 * a script whose size cannot be read off it). The runner bounds it again.
 */
export function criterionTimeoutMs(command: string): number {
  const files = command.match(TEST_FILE)?.length ?? 0;
  const ms = files ? 120_000 + 60_000 * files : 600_000;
  return Math.min(ms, CRITERION_BATCH_MAX_TIMEOUT_MS);
}

/** What makes two batches the same work: each criterion's command, order-independent. */
export function commandSetOf(checks: readonly CriterionCheck[]): string {
  const canonical = [...checks].map((c) => [c.criterionId, c.command]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/**
 * A mission's run: every in-scope criterion of one target in one runner job.
 * It belongs to the mission: every final verification of one target (a
 * re-filed one, or two filed by racing evaluations) reuses the run the first
 * one filed. The command set is in the key because a mission's commands also
 * come from the spec's verified_by paths, which can change within one revision.
 */
function batchRun(opts: DispatchTarget, specRevisionId: string, headSha: string, checks: readonly CriterionCheck[], missionId: string, targetKey?: string): FiledRun {
  const commandSet = commandSetOf(checks);
  const batch: CriterionBatchCheck[] = checks.map((c) => ({ criterionId: c.criterionId, command: c.command, timeoutMs: criterionTimeoutMs(c.command) }));
  const marker: CriterionBatchMarker = {
    subjectTaskId: opts.taskId, missionId, specRevisionId, headSha, commandSet, checks: batch,
    ...(targetKey ? { targetKey } : {}),
  };
  return {
    key: { specCriterionBatch: { missionId, specRevisionId, headSha, commandSet } },
    lockKey: `mission:${missionId}:${specRevisionId}:${headSha}:${commandSet}`,
    title: `${BATCH_TITLE_PREFIX} (${checks.length}) at ${headSha.slice(0, 7)}`,
    description:
      '## Spec criterion checks\n\n' +
      `The runner runs this itself, with no agent: it checks out \`${headSha}\` once, runs each criterion's command in turn ` +
      'under its own timeout and reports one exit code per criterion. Each exit code is that criterion\'s verdict.\n\n' +
      batch.map((c) => `- ${c.criterionId}: \`${c.command}\``).join('\n') + '\n\n' +
      'An agent session that reads this was started by a runner that predates these runs: do NOT run anything, ' +
      'call complete_task with error "runner does not run criterion batches" and stop.',
    loopConfig: null,
    mission: { missionId, specRevisionId, commandSet },
    context: {
      specCriterionBatch: marker,
      // Cut the worktree from the mission branch; the runner checks out headSha itself.
      ...(opts.headBranch ? { baseBranch: opts.headBranch } : {}),
      // One honest run per target: no silent second attempt.
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
): Promise<{ recorded: boolean; verdict?: string; verdicts?: Record<string, string>; checkerFault?: CheckerFaultKind; reason?: string }> {
  if (!isUuid(verificationTaskId)) return { recorded: false, reason: 'not a task id' };
  const [task] = await db.select({
    id: tasks.id, status: tasks.status, workspaceId: tasks.workspaceId, context: tasks.context,
    loopConfig: tasks.loopConfig, result: tasks.result, creationSource: tasks.creationSource,
  }).from(tasks).where(eq(tasks.id, verificationTaskId)).limit(1);
  const batch = criterionBatchOf(task?.context);
  if (task && batch) return handleBatchOutcome(task, batch, evidence);
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

type BatchOutcome = { recorded: boolean; verdicts?: Record<string, string>; checkerFault?: CheckerFaultKind; reason?: string };

/** The runner's report stored on the run's newest worker, for a call that did not pass it. */
async function storedBatchEvidence(taskId: string): Promise<Record<string, unknown> | null> {
  const [w] = await db.select({ evidence: workers.verificationEvidence }).from(workers)
    .where(eq(workers.taskId, taskId)).orderBy(desc(workers.createdAt)).limit(1);
  return asRecord(w?.evidence);
}

/**
 * One verdict per criterion of a mission's batch run, from the runner's one
 * report. Same rules as a single run: the run is exactly what dispatch filed,
 * the selection still names each command, and the report is the runner's,
 * never the agent's. A criterion whose command changed since, or with no
 * result in the report, records nothing. A run that proved nothing (every
 * criterion inconclusive, or no report at all) is reported as a checker fault.
 */
async function handleBatchOutcome(
  task: { id: string; status: string; workspaceId: string; creationSource: string | null },
  marker: CriterionBatchMarker,
  evidence: unknown,
): Promise<BatchOutcome> {
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return { recorded: false, reason: 'the run has not finished' };
  if (marker.subjectTaskId === task.id || task.creationSource !== 'orchestrator') return { recorded: false, reason: 'not a run buildd filed' };
  const p = await pinnedChecks(marker.subjectTaskId);
  if (!p.ok) return { recorded: false, reason: p.reason };
  if (p.missionId !== marker.missionId) return { recorded: false, reason: 'the run is not this mission\'s' };
  if (p.workspaceId !== task.workspaceId || p.specRevisionId !== marker.specRevisionId) return { recorded: false, reason: 'the pinned revision no longer names these checks' };
  if (!recordMissionVerdict) return { recorded: false, reason: 'no mission verdict recorder is registered' };

  const fault = (kind: CheckerFaultKind, detail: string) => reportCheckerFault({
    kind, workspaceId: task.workspaceId, missionId: marker.missionId, runTaskId: task.id, headSha: marker.headSha, detail,
  }).catch((err) => console.error(`[spec-checks] checker fault report failed for run ${task.id}:`, err));

  const ev = asRecord(evidence) ?? await storedBatchEvidence(task.id);
  if (!ev) {
    // A cancelled run was stopped on purpose; anything else that ends silent is the checker.
    if (task.status !== 'cancelled') await fault('no_report', `${task.status} with no result for ${marker.checks.length} criteria`);
    return { recorded: false, reason: 'no command evidence', ...(task.status !== 'cancelled' ? { checkerFault: 'no_report' as const } : {}) };
  }
  if (!isRunnerReported(ev)) return { recorded: false, reason: 'the evidence was reported by the agent in the run, not by the runner' };
  if (ev.conditionType !== 'criterion_batch' || ev.headSha !== marker.headSha) return { recorded: false, reason: 'the evidence is not this run\'s report' };
  const results = (Array.isArray(ev.results) ? ev.results : []).map(asRecord).filter((r): r is Record<string, unknown> => !!r);

  const decided: Array<{ check: CriterionBatchCheck; result: Record<string, unknown>; verdict: string }> = [];
  for (const check of marker.checks) {
    const current = p.checks.find((c) => c.criterionId === check.criterionId);
    if (!current || current.command !== check.command) continue;
    const result = results.find((r) => r.criterionId === check.criterionId && r.command === check.command);
    const verdict = result ? checkVerdict(result) : null;
    if (result && verdict) decided.push({ check, result, verdict });
  }
  if (!decided.length) return { recorded: false, reason: 'the report has no result for a criterion this run checks' };
  const allInconclusive = decided.length === marker.checks.length && decided.every((d) => d.verdict === 'inconclusive');

  const done = new Set((await db.select({ criterionId: specOutcomeVerdicts.criterionId }).from(specOutcomeVerdicts)
    .where(and(eq(specOutcomeVerdicts.missionId, marker.missionId), sql`${specOutcomeVerdicts.evidence}->>'verificationTaskId' = ${task.id}`))
    .limit(500)).map((r) => r.criterionId));

  const verdicts: Record<string, string> = {};
  let recorded = 0;
  let lastError: string | undefined;
  for (const { check, result, verdict } of decided) {
    verdicts[check.criterionId] = verdict;
    if (done.has(check.criterionId)) continue;
    const r = await recordMissionVerdict(marker.missionId, {
      specRevisionId: marker.specRevisionId,
      criterionId: check.criterionId,
      verdict,
      headSha: marker.headSha,
      verificationTaskId: task.id,
      recordedBy: `check:${task.id}`,
      evidence: {
        kind: 'check',
        verificationTaskId: task.id,
        command: check.command,
        outcome: result.outcome,
        ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
        ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
        ...(typeof result.timeoutMs === 'number' ? { timeoutMs: result.timeoutMs } : {}),
        ...(excerpt(result.stdout) ? { stdout: excerpt(result.stdout) } : {}),
        ...(excerpt(result.stderr) ? { stderr: excerpt(result.stderr) } : {}),
        ...(allInconclusive ? { checkerFault: 'all_inconclusive' } : {}),
      },
    });
    if (r.ok) recorded++;
    else lastError = r.error;
  }
  if (allInconclusive) {
    const kinds = [...new Set(decided.map((d) => (d.result.outcome === 'failed' ? `exit ${String(d.result.exitCode)}` : String(d.result.outcome))))].join(', ');
    await fault('all_inconclusive', `${decided.length} of ${decided.length} criteria inconclusive (${kinds})`);
  }
  return {
    recorded: recorded > 0, verdicts,
    ...(allInconclusive ? { checkerFault: 'all_inconclusive' as const } : {}),
    ...(recorded === 0 ? { reason: lastError ?? 'already recorded' } : {}),
  };
}
