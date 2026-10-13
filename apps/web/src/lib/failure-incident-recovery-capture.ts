/**
 * Capture-pipeline recovery (docs/specs/failure-incident-recovery.md §16.3,
 * §16.4): the `infrastructure_failure` family's `visual_qa.*` components.
 *
 * A surface audit whose capture failed in Buildd's own machinery (clone,
 * migrate, scrub, guard, boot, browser) is a subject of ONE incident per
 * (workspace, component, error signature), never a person's question.
 * Policy, in order:
 *  1. Check passes: a capture of the same component succeeded for each
 *     blocked audit's own ref, on a run started after the last repair (I-12).
 *     The incident is recovered and the blocked audits are re-queued.
 *  2. No fix task: file one (the existing fix-task path), once.
 *  3. Fix task running: delegated.
 *  4. Fix task finished, check not re-run: `retry_capture`, budget 3 per
 *     generation. The fix task is the generation's blocker, so its retries
 *     get a budget of their own.
 *  5. Budget spent or deadline passed: `needs_operator` with a capability
 *     gap (`fallbackOperator`), never `needs_decision`.
 *
 * Adapters (`afterAssess`), through existing writers only: the task's
 * `context.incidentRecovery` ref (fix-task port `touch`), the superseded
 * `waiting_input` question (`cleanupStuckWaitingInput`, reason
 * `superseded_by_recovery`) and the resume (`requeueFailedTasks`, woken
 * `task.requeued`). Recovery never passes, waives, cancels or deletes an
 * audit, a worker or a question (I-11).
 */
import { isTerminalTaskStatus, type FailureRecoveryBlocker, type FailureRecoveryDecision, type FailureRecoveryRef } from '@buildd/shared';
import { CAPTURE_FAILURE_COMPONENTS, parseCaptureFailureError, type CaptureFailureComponent } from '@buildd/core/visual-qa-page-source';
import { captureFailureReasonCode, type CaptureFailureFact } from './failure-pattern-sentinel';
import { readRecovery, type RecoveryFamily, type RecoveryPolicyOutcome, type RecoveryVerdict } from './failure-incident-recovery';
import type { StoredIncident } from './failure-incident-store';
import { INCIDENT_RECOVERY_CONTEXT_KEY, readIncidentRecoveryRef, type IncidentRecoveryRef } from './incident-recovery-refs';
import { RUNBOOKS, runbookFor } from './failure-incident-repairs';

/** `context.captureFailureRollout`: what the rollout sweep found for a legacy audit question (§16.4). */
export const CAPTURE_ROLLOUT_CONTEXT_KEY = 'captureFailureRollout';

export type CaptureRollout =
  | { classification: 'adopted'; component: CaptureFailureComponent; errorSignature: string; step: string; runId: string | null; ref: string | null; at: string; workerId: string }
  | { classification: 'unclassified'; checkedAt: string; workerId: string };

export function readCaptureRollout(context: unknown): CaptureRollout | null {
  const raw = context && typeof context === 'object' ? (context as Record<string, unknown>)[CAPTURE_ROLLOUT_CONTEXT_KEY] : null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.classification === 'unclassified' && typeof r.checkedAt === 'string' && typeof r.workerId === 'string') {
    return { classification: 'unclassified', checkedAt: r.checkedAt, workerId: r.workerId };
  }
  if (r.classification === 'adopted' && isCaptureComponent(r.component) && typeof r.errorSignature === 'string' && typeof r.at === 'string' && typeof r.workerId === 'string') {
    return {
      classification: 'adopted', component: r.component, errorSignature: r.errorSignature, step: typeof r.step === 'string' ? r.step : '',
      runId: typeof r.runId === 'string' ? r.runId : null, ref: typeof r.ref === 'string' ? r.ref : null, at: r.at, workerId: r.workerId,
    };
  }
  return null;
}

export function isCaptureComponent(v: unknown): v is CaptureFailureComponent {
  return typeof v === 'string' && (CAPTURE_FAILURE_COMPONENTS as readonly string[]).includes(v);
}

export interface CaptureSubjectFacts {
  taskId: string;
  missionId: string | null;
  /** `tasks.status`; null when the row was not found (unknown, never cleared). */
  status: string | null;
  /** The ref the audit captures (`captureRef.ref`) and its head, from the failure record. */
  ref: string | null;
  headSha: string | null;
  /** Newest capture failure of this incident's component for the task; null for none on record. */
  failedAt: string | null;
  /** The task's workers still holding an open `waiting_input` question. */
  openQuestionWorkerIds: string[];
}

export interface CaptureRunFact {
  /** The run's `capture_ref` (from its title, `Visual QA · <ref>`). */
  ref: string;
  createdAt: string;
  conclusion: string | null;
}

export interface CaptureRecoveryFacts {
  component: CaptureFailureComponent | null;
  errorSignature: string | null;
  subjects: CaptureSubjectFacts[];
  /**
   * The incident's one fix task; `finishedAt` is set once it is terminal.
   * `prMerged`: its PR merged (null: not read). The scrub runbook waits on it.
   */
  fixTask: { id: string; status: string; finishedAt: string | null; prMerged?: boolean | null } | null;
  /** visual-qa.yml runs since the oldest floor; null when they could not be read (no evidence, never a pass). */
  runs: CaptureRunFact[] | null;
}

/** `component=` and `sig=` out of a capture-pipeline signature. */
export function parseCaptureSignature(signature: string): { component: CaptureFailureComponent | null; errorSignature: string | null } {
  const parts = signature.split('|');
  const component = parts.find(p => p.startsWith('component='))?.slice('component='.length) ?? null;
  const errorSignature = parts.find(p => p.startsWith('sig='))?.slice('sig='.length) ?? null;
  return { component: isCaptureComponent(component) ? component : null, errorSignature };
}

const DISMISS_ONLY: FailureRecoveryDecision = {
  question: 'Buildd could not recover this capture failure on its own. Dismiss it?',
  options: [{ capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking it.' }],
  recommended: 'dismiss',
};

const isDone = (s: CaptureSubjectFacts) => s.status === 'completed' || s.status === 'cancelled';
const isBlocked = (s: CaptureSubjectFacts) => s.status === 'failed' || s.openQuestionWorkerIds.length > 0;

/**
 * I-12: a successful run of the capture for this audit's own ref (or head),
 * started after the last repair and after the audit's own failure. Evidence
 * from any other ref never satisfies it; unread runs never do.
 */
export function freshCaptureSucceeded(s: CaptureSubjectFacts, runs: CaptureRunFact[] | null, lastRepairAt: string | null): boolean {
  if (!runs || (!s.ref && !s.headSha)) return false;
  const floor = [lastRepairAt, s.failedAt].filter((x): x is string => !!x).sort().pop() ?? null;
  if (!floor) return false;
  return runs.some(r => r.conclusion === 'success' && r.createdAt > floor && (r.ref === s.ref || (!!s.headSha && r.ref === s.headSha)));
}

/** Pure. The capture-pipeline policy over facts read now. */
export function evaluateCaptureFailure(incident: StoredIncident, facts: CaptureRecoveryFacts, _now: string): RecoveryPolicyOutcome {
  const parsed = parseCaptureSignature(incident.signature);
  const component = facts.component ?? parsed.component;
  const label = component ? component.slice('visual_qa.'.length) : 'capture';
  const missions = [...new Set(facts.subjects.map(s => s.missionId).filter((m): m is string => !!m))];
  const subjects: FailureRecoveryRef[] = [
    ...facts.subjects.map(s => ({ kind: 'task' as const, id: s.taskId })),
    ...missions.map(id => ({ kind: 'mission' as const, id })),
  ];
  const fix = facts.fixTask;
  const fixDone = !!fix && isTerminalTaskStatus(fix.status);
  const lastRepairAt = fixDone ? fix!.finishedAt : null;
  const blockers: FailureRecoveryBlocker[] = fix ? [{ kind: 'task', id: fix.id, state: fix.status, observedAt: fix.finishedAt ?? incident.lastSeenAt }] : [];
  const failures = facts.subjects.map(s => s.failedAt).filter((x): x is string => !!x).sort();
  const blocked = facts.subjects.filter(s => s.status !== null && !isDone(s) && isBlocked(s));
  const gap = {
    capability: `repair_infrastructure:${component ?? 'visual_qa'}`,
    reason: `The capture's ${label} step still fails for ${blocked.length || facts.subjects.length} surface audit(s)`
      + `${fix ? ` after fix task ${fix.id.slice(0, 8)} (${fix.status})` : ''} and the capture retries`
      + `${facts.errorSignature ?? parsed.errorSignature ? `; signature ${facts.errorSignature ?? parsed.errorSignature}` : ''}. Repair the ${label} step, then re-run the audits.`,
    label: `Automatic recovery unavailable: the capture's ${label} step still fails after the repair. The operator has been told.`,
  };
  const base = {
    cause: { reasonCode: component ? captureFailureReasonCode(component) : incident.reasonCode, rule: incident.rule, ownership: 'infrastructure' as const },
    subjects,
    blockers,
    overlappingPaths: [],
    // The retry episode starts when the repair finished; before it, at the first failure.
    episodeStartedAt: lastRepairAt ?? failures[0] ?? incident.firstSeenAt,
    lastProgressAt: failures[failures.length - 1] ?? null,
    verification: { predicate: 'capture.fresh_success_for_own_ref', params: { component, lastRepairAt } },
    fallbackDecision: DISMISS_ONLY,
    fallbackOperator: gap,
  };
  const outcome = (verdict: RecoveryVerdict): RecoveryPolicyOutcome => ({ ...base, verdict });

  if (!component) return outcome({ kind: 'inconclusive', reason: 'Unknown capture component.' });
  const known = facts.subjects.filter(s => s.status !== null);
  if (known.length === 0) return outcome({ kind: 'inconclusive', reason: 'Buildd could not read the blocked audits.' });

  // 1. The check.
  if (blocked.length === 0 && known.every(isDone)) return outcome({ kind: 'passed', summary: 'Every blocked audit captured again or ended.' });
  if (blocked.length > 0 && blocked.every(s => freshCaptureSucceeded(s, facts.runs, lastRepairAt))) {
    return outcome({ kind: 'passed', summary: `A fresh capture past the ${label} step succeeded for each blocked audit's own ref.` });
  }
  if (blocked.length === 0) return outcome({ kind: 'wait', label: 'The audits were re-queued; waiting for their capture.' });

  // 2–4. Repair, wait on the fix, then retry the capture.
  if (!fix) {
    return outcome({
      kind: 'repair', action: 'file_fix_task', subject: { kind: 'task', id: blocked[0].taskId }, once: true,
      label: `Buildd filed a fix for the capture's ${label} step.`, params: {},
    });
  }
  if (!fixDone) return outcome({ kind: 'delegated', nextActionKind: 'fix_task_running', label: `Fix running for the capture's ${label} step.`, ref: fix.id });
  // operator-recovery §9.3 `qa.scrub_immutable_violation`: the re-run waits for
  // the fix's PR to merge, runs once, and a capture that fails again after it
  // goes to the operator. The immutable-revision trigger is never touched.
  if (runbookFor({ ...incident, causeCode: base.cause.reasonCode }) === 'qa.scrub_immutable_violation') {
    const answer = RUNBOOKS['qa.scrub_immutable_violation']({
      fix: { status: fix.status, prMerged: fix.prMerged ?? null },
      // A capture that fails again after the merge is bounded by the generation's
      // retry budget, which hands it to the operator (fallbackOperator).
      captureFailedAfterFix: fix.prMerged ? false : null,
      missionsWaiting: blocked.length,
      rerunThisGeneration: false,
    });
    if (answer === 'wait') return outcome({ kind: 'wait', label: `Waiting for the ${label} fix's PR to merge before the audits re-run.` });
    if (answer === 'escalate') return outcome({ kind: 'operator', ...gap });
    if (answer === 'queue_fix') {
      return outcome({ kind: 'repair', action: 'file_fix_task', subject: { kind: 'task', id: blocked[0].taskId }, once: true, label: `Buildd filed a fix for the capture's ${label} step.`, params: {} });
    }
  }
  const retry = blocked.filter(s => s.status === 'failed').map(s => s.taskId);
  // A legacy question is closed by the adapter first; its task is failed then.
  if (retry.length === 0) return outcome({ kind: 'wait', label: 'Closing the stale question before the capture is retried.' });
  return outcome({
    kind: 'repair', action: 'retry_capture', subject: { kind: 'task', id: retry[0] },
    label: `Retrying the capture for ${retry.length} audit(s) after the repair.`, params: { taskIds: retry },
  });
}

// ── Adapters (§16.4) ────────────────────────────────────────────────────────

export interface CaptureRecoveryAdapters {
  /** Merge `context.incidentRecovery` into each task whose ref differs. */
  attachRef(taskIds: string[], ref: IncidentRecoveryRef): Promise<void>;
  /** Close the open questions of these tasks as superseded by recovery. Returns how many. */
  supersedeQuestions(taskIds: string[]): Promise<number>;
  /** Re-queue the tasks still failed, and wake them. Returns the ids moved. */
  resume(taskIds: string[], key: string): Promise<string[]>;
}

/**
 * After an assessment: point every blocked audit at the incident, close its
 * stale question, and, on the transition to recovered, resume the audits
 * still failed (once: the writer only moves `failed` rows).
 */
export async function runCaptureAdapters(adapters: CaptureRecoveryAdapters, incident: StoredIncident, prior: StoredIncident): Promise<void> {
  const rec = readRecovery(incident);
  if (!rec || !parseCaptureSignature(incident.signature).component) return;
  const taskIds = rec.subjects.filter(s => s.kind === 'task').map(s => s.id);
  if (taskIds.length === 0) return;
  if (rec.state === 'recovered') {
    if (readRecovery(prior)?.state !== 'recovered') await adapters.resume(taskIds, `recovery:${incident.id}:g${rec.generation}:resume`);
    return;
  }
  await adapters.attachRef(taskIds, { incidentId: incident.id, generation: rec.generation });
  await adapters.supersedeQuestions(taskIds);
}

// ── DB ──────────────────────────────────────────────────────────────────────

/** The workspace's repo for the Actions API; null without a GitHub link. */
async function workspaceRepo(workspaceId: string): Promise<{ installationId: number; fullName: string } | null> {
  const [{ db }, { workspaces }, { eq }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { id: true },
    with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
  });
  const fullName = ws?.githubRepo?.fullName;
  const installationId = ws?.githubRepo?.installation?.installationId;
  return fullName && installationId ? { installationId, fullName } : null;
}

const RUN_TITLE_PREFIX = 'Visual QA · ';

/** A run's `capture_ref`, from the title its dispatch sets (`run-name` in visual-qa.yml). */
export function runCaptureRef(displayTitle: string | null | undefined): string | null {
  return displayTitle?.startsWith(RUN_TITLE_PREFIX) ? displayTitle.slice(RUN_TITLE_PREFIX.length).trim() || null : null;
}

export interface VisualQaRun { id: number; ref: string | null; createdAt: string; conclusion: string | null }

/** visual-qa.yml runs created since `sinceIso` (newest first, one page). Null when unreadable. */
export async function listVisualQaRuns(workspaceId: string, sinceIso: string): Promise<VisualQaRun[] | null> {
  try {
    const repo = await workspaceRepo(workspaceId);
    if (!repo) return null;
    const { githubApi } = await import('./github');
    const res = await githubApi(repo.installationId, `/repos/${repo.fullName}/actions/workflows/visual-qa.yml/runs?per_page=100&created=${encodeURIComponent(`>=${sinceIso.slice(0, 19)}Z`)}`);
    const runs = (res as { workflow_runs?: Array<{ id: number; display_title?: string; created_at: string; conclusion: string | null }> })?.workflow_runs;
    if (!Array.isArray(runs)) return null;
    return runs.map(r => ({ id: r.id, ref: runCaptureRef(r.display_title), createdAt: new Date(r.created_at).toISOString(), conclusion: r.conclusion }));
  } catch (err) {
    console.warn('[failure-incident-recovery-capture] visual-qa runs unreadable:', (err as Error)?.message ?? err);
    return null;
  }
}

/** The first failed step of one run, from the Actions API; null when unreadable or none failed. */
export async function failedStepOfRun(workspaceId: string, runId: number): Promise<string | null> {
  try {
    const repo = await workspaceRepo(workspaceId);
    if (!repo) return null;
    const { githubApi } = await import('./github');
    const res = await githubApi(repo.installationId, `/repos/${repo.fullName}/actions/runs/${runId}/jobs?per_page=20`);
    const jobs = (res as { jobs?: Array<{ steps?: Array<{ name: string; conclusion: string | null; number: number }> }> })?.jobs ?? [];
    const failed = jobs.flatMap(j => j.steps ?? []).filter(s => s.conclusion === 'failure').sort((a, b) => a.number - b.number);
    return failed[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** Read the subjects, the fix task and the capture runs from their owners. */
export async function dbObserveCaptureRecovery(incident: StoredIncident): Promise<{ complete: boolean; facts: CaptureRecoveryFacts }> {
  const [{ db }, { tasks, workers }, { desc, eq, inArray }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const { component, errorSignature } = parseCaptureSignature(incident.signature);
  const ids = [...new Set(incident.affectedRefs.taskIds)].slice(0, 25);
  const empty: CaptureRecoveryFacts = { component, errorSignature, subjects: [], fixTask: null, runs: null };
  if (ids.length === 0 || !component) return { complete: false, facts: empty };

  const taskRows = await db.select({ id: tasks.id, status: tasks.status, missionId: tasks.missionId, context: tasks.context }).from(tasks).where(inArray(tasks.id, ids));
  const workerRows = await db
    .select({ id: workers.id, taskId: workers.taskId, status: workers.status, error: workers.error, createdAt: workers.createdAt, completedAt: workers.completedAt })
    .from(workers).where(inArray(workers.taskId, ids)).orderBy(desc(workers.createdAt)).limit(200);
  const byTask = new Map<string, typeof workerRows>();
  for (const w of workerRows) if (w.taskId) byTask.set(w.taskId, [...(byTask.get(w.taskId) ?? []), w]);
  const byId = new Map(taskRows.map(t => [t.id, t]));

  const subjects: CaptureSubjectFacts[] = ids.map(id => {
    const t = byId.get(id);
    const ws = byTask.get(id) ?? [];
    let failedAt: string | null = null, ref: string | null = null, headSha: string | null = null;
    for (const w of ws) {
      const f = parseCaptureFailureError(w.error);
      if (f?.ownership !== 'infrastructure' || f.component !== component) continue;
      failedAt = (w.completedAt ?? w.createdAt).toISOString();
      ref = f.ref ?? null;
      headSha = f.headSha ?? null;
      break; // newest first
    }
    const rollout = readCaptureRollout(t?.context);
    if (rollout?.classification === 'adopted' && rollout.component === component && (!failedAt || rollout.at > failedAt)) {
      failedAt = rollout.at;
      ref = rollout.ref ?? ref;
    }
    return {
      taskId: id,
      missionId: t?.missionId ?? null,
      status: t?.status ?? null,
      ref, headSha, failedAt,
      openQuestionWorkerIds: ws.filter(w => w.status === 'waiting_input').map(w => w.id),
    };
  });

  let fixTask: CaptureRecoveryFacts['fixTask'] = null;
  let fixId = incident.linkedFixTaskId;
  if (!fixId && incident.workspaceId) {
    const { createDbFixTaskPort } = await import('./failure-incident-actions');
    fixId = await createDbFixTaskPort().findOpenByIncident(incident.id, incident.workspaceId);
  }
  if (fixId) {
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, fixId), columns: { id: true, status: true, updatedAt: true } });
    const fixWorkers = row ? await db.select({ mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus }).from(workers).where(eq(workers.taskId, row.id)).catch(() => null) : null;
    if (row) {
      fixTask = {
        id: row.id, status: row.status, finishedAt: isTerminalTaskStatus(row.status) ? row.updatedAt.toISOString() : null,
        prMerged: fixWorkers === null ? null : fixWorkers.some(w => !!w.mergedAt || w.prLifecycleStatus === 'merged'),
      };
    }
  }

  // Runs are only worth reading once there is a floor to be fresh after.
  const floors = subjects.map(s => s.failedAt).filter((x): x is string => !!x).sort();
  const needRuns = incident.workspaceId && floors.length > 0 && subjects.some(s => s.ref || s.headSha);
  const runs = needRuns ? await listVisualQaRuns(incident.workspaceId!, floors[0]) : [];
  return {
    complete: taskRows.length > 0,
    facts: { component, errorSignature, subjects, fixTask, runs: runs ? runs.filter(r => r.ref).map(r => ({ ref: r.ref!, createdAt: r.createdAt, conclusion: r.conclusion })) : null },
  };
}

/** Production adapters: the fix-task port's context merge, the waiting-input cleanup writer, the requeue writer. */
export function dbCaptureAdapters(): CaptureRecoveryAdapters {
  return {
    async attachRef(taskIds, ref) {
      const [{ db }, { tasks }, { inArray }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
      const { createDbFixTaskPort } = await import('./failure-incident-actions');
      const port = createDbFixTaskPort();
      const rows = await db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(inArray(tasks.id, taskIds));
      for (const r of rows) {
        const cur = readIncidentRecoveryRef(r.context);
        if (cur?.incidentId === ref.incidentId && cur.generation === ref.generation) continue;
        await port.touch(r.id, { [INCIDENT_RECOVERY_CONTEXT_KEY]: ref });
      }
    },
    async supersedeQuestions(taskIds) {
      const [{ db }, { workers }, { and, eq, inArray }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
      const open = await db.select({ id: workers.id, accountId: workers.accountId }).from(workers)
        .where(and(inArray(workers.taskId, taskIds), eq(workers.status, 'waiting_input')));
      if (open.length === 0) return 0;
      const { cleanupStuckWaitingInput } = await import('./stale-workers');
      const byAccount = new Map<string, string[]>();
      for (const w of open) if (w.accountId) byAccount.set(w.accountId, [...(byAccount.get(w.accountId) ?? []), w.id]);
      let closed = 0;
      for (const [accountId, workerIds] of byAccount) {
        closed += (await cleanupStuckWaitingInput(accountId, { reason: 'superseded_by_recovery', workerIds })).failedWorkers;
      }
      return closed;
    },
    async resume(taskIds) {
      const { requeueFailedTasks } = await import('./credential-recovery');
      return requeueFailedTasks(taskIds, 'task.requeued');
    },
  };
}

export function createCaptureRecoveryFamily(adapters: CaptureRecoveryAdapters = dbCaptureAdapters()): RecoveryFamily<CaptureRecoveryFacts> {
  return {
    rule: 'infrastructure_failure',
    observe: dbObserveCaptureRecovery,
    evaluate: evaluateCaptureFailure,
    afterAssess: (incident, prior) => runCaptureAdapters(adapters, incident, prior),
  };
}

// ── Facts for the sentinel, and the rollout (§16.4) ─────────────────────────

/** Legacy audit questions classified per workspace per sweep: each costs Actions API reads. */
export const MAX_LEGACY_QUESTIONS_PER_SWEEP = 10;

/**
 * Pure. The capture run a legacy question was about: the newest run that
 * failed between the worker's start and its question. None: unknown.
 */
export function pickRunForQuestion(runs: VisualQaRun[], startedAt: string, askedAt: string): VisualQaRun | null {
  return runs
    .filter(r => r.conclusion === 'failure' && r.createdAt >= startedAt && r.createdAt <= askedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
}

/**
 * Pure. What the rollout records for one legacy question: `adopted` only when
 * the run's failed step is a known capture component (a typed failure on
 * record); anything else is `unclassified`, and the question stays as it is.
 * Its signature is the step's, since a run's log text is not read here.
 */
export function legacyRollout(input: {
  run: VisualQaRun | null; failedStep: string | null; workerId: string; askedAt: string; now: string;
  classify: (step: string) => { ownership: string; component: CaptureFailureComponent | null; errorSignature: string };
}): CaptureRollout {
  const unclassified: CaptureRollout = { classification: 'unclassified', checkedAt: input.now, workerId: input.workerId };
  if (!input.run || !input.failedStep) return unclassified;
  const typed = input.classify(input.failedStep);
  if (typed.ownership !== 'infrastructure' || !typed.component) return unclassified;
  return {
    classification: 'adopted', component: typed.component, errorSignature: typed.errorSignature, step: input.failedStep,
    runId: String(input.run.id), ref: input.run.ref, at: input.askedAt, workerId: input.workerId,
  };
}

/**
 * Pure. A failed audit's capture failure, if it is Buildd's: the newest
 * worker's typed report with ownership `infrastructure`, else what the
 * rollout adopted. A preview auth wall (`person`) or an unclassified step
 * (`inconclusive`) is never an infrastructure incident (§16.2).
 */
export function captureFactFor(
  task: { id: string; missionId: string | null; context: unknown },
  worker: { id: string; error: string | null; createdAt: Date; completedAt: Date | null } | null,
): CaptureFailureFact | null {
  const f = parseCaptureFailureError(worker?.error);
  if (worker && f?.ownership === 'infrastructure') {
    return {
      taskId: task.id, missionId: task.missionId, component: f.component, errorSignature: f.errorSignature,
      occurredAt: (worker.completedAt ?? worker.createdAt).toISOString(), workerId: worker.id,
      runId: f.runId ?? null, ref: f.ref ?? null, headSha: f.headSha ?? null,
    };
  }
  const r = readCaptureRollout(task.context);
  if (r?.classification !== 'adopted') return null;
  return { taskId: task.id, missionId: task.missionId, component: r.component, errorSignature: r.errorSignature, occurredAt: r.at, workerId: r.workerId, runId: r.runId, ref: r.ref };
}

/**
 * The capture failures of one workspace, for the sentinel's
 * `infrastructure_failure` rule:
 *  - typed: failed audits whose newest worker reported `capture_failure:` with
 *    ownership `infrastructure`, or that the rollout adopted;
 *  - rollout: `waiting_input` audit questions not yet looked at. A question
 *    whose run failed at a known step is adopted (recorded on the task, then
 *    a fact); any other is marked unclassified and left as it is (AC-16).
 */
export async function dbCollectCaptureFailures(workspaceId: string, sinceIso: string, now: string): Promise<CaptureFailureFact[]> {
  const [{ db }, { tasks, workers }, { and, desc, eq, gte, inArray, like, or }, shared, core, page] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/shared'),
    import('@buildd/core/surface-audit'), import('@buildd/core/visual-qa-page-source'),
  ]);
  const isAudit = or(eq(tasks.roleSlug, shared.VISUAL_AUDITOR_ROLE_SLUG), like(tasks.title, `${core.SURFACE_AUDIT_TITLE_PREFIX}%`));
  const out: CaptureFailureFact[] = [];

  // Typed failures on failed audits.
  const failed = await db.select({ id: tasks.id, missionId: tasks.missionId, context: tasks.context }).from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'failed'), gte(tasks.updatedAt, new Date(sinceIso)), isAudit))
    .limit(200);
  if (failed.length > 0) {
    const ws = await db.select({ id: workers.id, taskId: workers.taskId, error: workers.error, createdAt: workers.createdAt, completedAt: workers.completedAt })
      .from(workers).where(inArray(workers.taskId, failed.map(t => t.id))).orderBy(desc(workers.createdAt)).limit(400);
    const newest = new Map<string, (typeof ws)[number]>();
    for (const w of ws) if (w.taskId && !newest.has(w.taskId)) newest.set(w.taskId, w);
    for (const t of failed) {
      const fact = captureFactFor(t, newest.get(t.id) ?? null);
      if (fact) out.push(fact);
    }
  }

  // Rollout: legacy questions on audits, each looked at once.
  const waiting = await db
    .select({ workerId: workers.id, taskId: tasks.id, missionId: tasks.missionId, context: tasks.context, startedAt: workers.startedAt, createdAt: workers.createdAt, askedAt: workers.updatedAt })
    .from(workers).innerJoin(tasks, eq(workers.taskId, tasks.id))
    .where(and(eq(tasks.workspaceId, workspaceId), eq(workers.status, 'waiting_input'), isAudit))
    .limit(50);
  const todo = waiting.filter(w => !readCaptureRollout(w.context) && !readIncidentRecoveryRef(w.context)).slice(0, MAX_LEGACY_QUESTIONS_PER_SWEEP);
  if (todo.length === 0) return out;
  const oldest = todo.map(w => (w.startedAt ?? w.createdAt).toISOString()).sort()[0];
  const runs = await listVisualQaRuns(workspaceId, oldest);
  if (!runs) return out; // unreadable: unknown, look again next sweep; nothing is marked
  const { createDbFixTaskPort } = await import('./failure-incident-actions');
  const port = createDbFixTaskPort();
  const classify = (step: string) => page.classifyCaptureFailure({ step, error: `step failed: ${step}` });
  for (const w of todo) {
    const askedAt = w.askedAt.toISOString();
    const run = pickRunForQuestion(runs, (w.startedAt ?? w.createdAt).toISOString(), askedAt);
    const failedStep = run ? await failedStepOfRun(workspaceId, run.id) : null;
    const rollout = legacyRollout({ run, failedStep, workerId: w.workerId, askedAt, now, classify });
    await port.touch(w.taskId, { [CAPTURE_ROLLOUT_CONTEXT_KEY]: rollout });
    if (rollout.classification === 'adopted') {
      out.push({ taskId: w.taskId, missionId: w.missionId, component: rollout.component, errorSignature: rollout.errorSignature, occurredAt: askedAt, workerId: w.workerId, runId: rollout.runId, ref: rollout.ref });
    }
  }
  return out;
}
