/**
 * The repair allowlist `RepairKind` and its approved runbooks
 * (operator-recovery spec §9.2–§9.4, operator console).
 *
 * Each repair names the existing writer it runs, the precondition that must
 * hold on FRESH facts before it runs, and the verify predicate that decides,
 * on facts read after it ran, whether it actually helped. An owner click, the
 * recovery loop and (later) a model suggestion all read the same table, so a
 * repair is never possible on one path and refused on another.
 *
 * Never in this set, and nothing can name it: arbitrary SQL or shell; schema,
 * auth or production config; disabling or bypassing a trigger; blanket
 * cancellation; marking an audit or check passed; resolving without a passing
 * check; deleting or hiding incidents or events. Code fixes go through
 * `queue_fix`: a normal task, PR, CI and review.
 *
 * Pure, except `loadRepairFacts`, `dbCausePeers` and the writers at the bottom.
 */
import { TERMINAL_TASK_STATUSES, type FailureIncidentRule, type FailureIncidentSeverity, type FailureRecoveryRef } from '@buildd/shared';
import { MAX_DELIVERY_ATTEMPTS } from '@buildd/dispatch-contract';
import type { RecoveryRepairAction } from './failure-incident-recovery';
import type { RepairKind } from './failure-incident-recovery-events';
import type { StoredIncident } from './failure-incident-store';

export const RUNBOOK_VERSION = 'orq-runbook-v1';

// ── Fresh facts ─────────────────────────────────────────────────────────────

export interface RepairSubjectFacts {
  taskId: string;
  missionId: string | null;
  /** `tasks.status`; null when the row could not be read. */
  status: string | null;
  /** Newest worker's creation time; null for none. */
  lastWorkerAt: string | null;
  /** Newest dispatch outbox row for the task; null for none. */
  outbox: { status: string; attemptCount: number; createdAt: string; deliveredAt: string | null } | null;
  /** A running/starting worker with no update past the stale window; null for none. */
  staleWorker: { workerId: string; accountId: string | null; updatedAt: string } | null;
  /** `context.infraRetryCount`. */
  infraRetries: number;
}

export interface RepairMissionFacts {
  missionId: string;
  /** The newest surface audit task; null for none. */
  audit: { taskId: string; status: string; lastWorkerAt: string | null; captureFailedAt: string | null } | null;
}

export interface RepairFacts {
  observedAt: string;
  incident: {
    id: string;
    rule: FailureIncidentRule;
    causeCode: string;
    generation: number | null;
    state: string | null;
    spentKeys: string[];
    linkedFixTaskId: string | null;
  };
  /** The blocker as the fresh assessment saw it, with its lease state. Null: the incident has no blocker. */
  blocker: { taskId: string | null; state: string; activeClaims: number | null } | null;
  subjects: RepairSubjectFacts[];
  /** A runner serving the subjects' workspace heartbeated within the stale cutoff. Null: unreadable. */
  runnerOnline: boolean | null;
  fix: { taskId: string; status: string; prMerged: boolean | null } | null;
  /** A capture of the incident's component failed after the fix merged. Null: unknown. */
  captureFailedAfterFix: boolean | null;
  missions: RepairMissionFacts[];
  /** The kernel delivery a CI retry would go to; null when there is none. */
  kernel: { workspaceId: string; repoFullName: string; prNumber: number; installationId: number } | null;
}

// ── The allowlist (§9.2) ────────────────────────────────────────────────────

/** `null`: the precondition holds. A string: why it does not, in plain words. */
export type Precondition = (f: RepairFacts) => string | null;
/** `true` progressed, `false` no effect, `null` still in its window (not a verdict yet). */
export type VerifyPredicate = (f: RepairFacts, attemptAt: string) => boolean | null;

export interface RepairSpec {
  kind: RepairKind;
  /** The loop's action that runs it. */
  action: RecoveryRepairAction;
  families: ReadonlyArray<FailureIncidentRule | 'any'>;
  /** The writer it goes through. Shown under Details; never executed by name. */
  writer: string;
  /** Acts on a fault every member of the cause shares: run once, on the lead (§9.1). */
  shared: boolean;
  /** A model suggestion may select it once its kind is promoted (§6.6, OR-5). */
  autoEligible: boolean;
  label: string;
  precondition: Precondition;
  predicate: string;
  verifyWindowMinutes: number;
  verify: VerifyPredicate;
}

const PENDING = 'pending';
const LANDED_BLOCKER = new Set(['merged', 'closed', 'completed', 'cancelled', 'failed', 'released']);
/** A fix task that ended without landing: terminal, but not completed. */
const DEAD_FIX = new Set<string>(TERMINAL_TASK_STATUSES.filter(s => s !== 'completed'));
/** stale-workers MAX_INFRA_RETRIES (pinned by the unit test; that module pulls the DB in). */
export const MAX_INFRA_RETRIES = 3;

const after = (t: string | null | undefined, attemptAt: string) => !!t && t > attemptAt;
const minutesSince = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

/** A predicate that stays open for `windowMin`, then closes as `false` if it never passed. */
const windowed = (windowMin: number, check: (f: RepairFacts, attemptAt: string) => boolean | null): VerifyPredicate =>
  (f, attemptAt) => {
    const passed = check(f, attemptAt);
    if (passed === true) return true;
    return minutesSince(attemptAt, f.observedAt) < windowMin ? null : passed === null ? null : false;
  };

const wokenThisGeneration = (f: RepairFacts) =>
  f.incident.generation !== null && f.incident.spentKeys.some(k => k.includes(':wake_subject:') && k.includes(`:g${f.incident.generation}:`));

export const REPAIRS: Readonly<Record<RepairKind, RepairSpec>> = {
  release_blocker: {
    kind: 'release_blocker', action: 'release_blocker', families: ['path_overlap_stall'],
    writer: "releaseAndNotify(blockerTaskId, 'merged' | 'abandoned')", shared: true, autoEligible: true,
    label: "Release the landed blocker's claims",
    precondition: f => {
      if (!f.blocker?.taskId) return 'No blocking task is known for this problem.';
      if (!LANDED_BLOCKER.has(f.blocker.state)) return `The blocker is still ${f.blocker.state}; releasing it now would let two tasks edit the same files.`;
      if (f.blocker.activeClaims === 0 && f.subjects.every(s => s.status !== PENDING)) return 'The blocker holds no claims and nothing is waiting on it.';
      return null;
    },
    predicate: 'blocker.released_and_waiters_notified', verifyWindowMinutes: 10,
    verify: windowed(10, (f, at) => f.blocker?.activeClaims === 0 && f.subjects.every(s => s.status !== PENDING || after(s.outbox?.createdAt, at) || after(s.lastWorkerAt, at))),
  },
  wake_subject: {
    kind: 'wake_subject', action: 'wake_subject', families: ['path_overlap_stall', 'repeated_failure'],
    writer: 'wakeTask(subjectId, reason)', shared: false, autoEligible: true,
    label: 'Wake the waiting task',
    precondition: f => {
      const s = f.subjects[0];
      if (!s) return 'No waiting task is known for this problem.';
      if (s.status !== PENDING) return `The task is ${s.status ?? 'unreadable'}, not waiting to start.`;
      if (wokenThisGeneration(f)) return 'The task was already woken for this occurrence.';
      if (f.blocker && !LANDED_BLOCKER.has(f.blocker.state)) return `It is still blocked (${f.blocker.state}); a wake would only defer again.`;
      return null;
    },
    predicate: 'subject.worker_created', verifyWindowMinutes: 15,
    verify: windowed(15, (f, at) => f.subjects.length > 0 && f.subjects.some(s => after(s.lastWorkerAt, at))),
  },
  redeliver_dispatch: {
    kind: 'redeliver_dispatch', action: 'redeliver_dispatch', families: ['repeated_failure', 'stranded_gate'],
    writer: 'wakeTask (a new outbox row, notBefore = now)', shared: false, autoEligible: true,
    label: 'Deliver the task to a runner again',
    precondition: f => {
      const s = f.subjects[0];
      if (!s) return 'No undelivered task is known for this problem.';
      if (s.status !== PENDING) return `The task is ${s.status ?? 'unreadable'}, not waiting for delivery.`;
      if (!s.outbox || s.outbox.status !== 'failed' || s.outbox.attemptCount < MAX_DELIVERY_ATTEMPTS) return 'Its last delivery has not exhausted its attempts.';
      if (f.runnerOnline === null) return "Buildd couldn't confirm a runner is online for this workspace.";
      if (!f.runnerOnline) return 'No runner is online for this workspace; a new delivery would fail the same way.';
      return null;
    },
    predicate: 'dispatch.acked_and_worker_created', verifyWindowMinutes: 15,
    verify: windowed(15, (f, at) => {
      const s = f.subjects[0];
      return !!s && after(s.lastWorkerAt, at) && !!s.outbox && s.outbox.status !== 'failed' && after(s.outbox.createdAt, at);
    }),
  },
  retry_stale_worker: {
    kind: 'retry_stale_worker', action: 'retry_stale_worker', families: ['stranded_gate', 'infrastructure_failure'],
    writer: 'attemptStaleRecovery(accountId)', shared: false, autoEligible: true,
    label: 'Ask the runner to recover its stalled worker',
    precondition: f => {
      const s = f.subjects.find(x => x.staleWorker);
      if (!s?.staleWorker) return 'No stalled worker is known for this problem.';
      if (!s.staleWorker.accountId) return 'The stalled worker has no runner account to ask.';
      if (s.infraRetries >= MAX_INFRA_RETRIES) return `The task already used its ${MAX_INFRA_RETRIES} infrastructure retries.`;
      return null;
    },
    predicate: 'worker.heartbeat_after_attempt', verifyWindowMinutes: 10,
    verify: windowed(10, (f, at) => f.subjects.some(s => after(s.lastWorkerAt, at) || (!!s.staleWorker && after(s.staleWorker.updatedAt, at)))),
  },
  rerun_visual_audit: {
    kind: 'rerun_visual_audit', action: 'rerun_visual_audit', families: ['infrastructure_failure'],
    writer: 'requestMissionSurfaceAudit(missionId), or the blocked audit re-queued', shared: true, autoEligible: true,
    label: "Re-run each mission's visual audit",
    precondition: f => {
      if (!f.fix) return 'No fix is linked yet; a re-run would fail the same way.';
      if (f.fix.prMerged !== true) return f.fix.prMerged === null ? "Buildd couldn't confirm the fix PR merged." : "The fix PR hasn't merged yet.";
      if (f.captureFailedAfterFix === null) return "Buildd couldn't confirm the capture works after the fix.";
      if (f.captureFailedAfterFix) return 'The capture failed again after the fix merged.';
      if (f.missions.length === 0) return 'No mission audit is waiting on this problem.';
      return null;
    },
    predicate: 'audit.rerun_per_mission_captured', verifyWindowMinutes: 120,
    verify: windowed(120, (f, at) => f.missions.length > 0 && f.missions.every(m => !!m.audit && after(m.audit.lastWorkerAt, at) && !after(m.audit.captureFailedAt, at))),
  },
  kernel_ci_retry: {
    kind: 'kernel_ci_retry', action: 'kernel_ci_retry', families: ['stranded_gate', 'repeated_failure'],
    writer: 'requestCiRetry (kernel command)', shared: false, autoEligible: true,
    label: "Retry the PR's CI through the delivery kernel",
    precondition: f => (f.kernel ? null : 'No kernel delivery owns a PR for this problem.'),
    predicate: 'kernel.ci_attempt_started', verifyWindowMinutes: 30,
    verify: windowed(30, (f, at) => f.subjects.some(s => after(s.lastWorkerAt, at))),
  },
  queue_fix: {
    kind: 'queue_fix', action: 'file_fix_task', families: ['any'],
    writer: 'the fix-task path (createDbFixTaskPort)', shared: true, autoEligible: true,
    label: 'Queue one fix task for the cause',
    precondition: f => (f.fix && !DEAD_FIX.has(f.fix.status) ? `Fix task ${f.fix.taskId.slice(0, 8)} is already ${f.fix.status}.` : null),
    predicate: 'fix_task.exists_and_linked', verifyWindowMinutes: 5,
    verify: windowed(5, f => !!f.fix && f.incident.linkedFixTaskId === f.fix.taskId),
  },
};

export const SHARED_REPAIR_ACTIONS: ReadonlySet<RecoveryRepairAction> = new Set<RecoveryRepairAction>(['release_blocker', 'file_fix_task', 'retry_capture', 'rerun_visual_audit']);

export function repairAppliesTo(kind: RepairKind, rule: FailureIncidentRule): boolean {
  const fam = REPAIRS[kind].families;
  return fam.includes('any') || fam.includes(rule);
}

/** Pure. The precondition verdict: null when it may run now. */
export function checkRepair(kind: RepairKind, facts: RepairFacts): string | null {
  if (!repairAppliesTo(kind, facts.incident.rule)) return `${REPAIRS[kind].label} does not apply to this kind of problem.`;
  return REPAIRS[kind].precondition(facts);
}

/**
 * Pure. The verify result for one attempt, from facts read after it (§9.4).
 * The writer having returned is never success: only the predicate, or the
 * family's own check (`familyPassed`), passes it.
 */
export function verifyRepair(kind: RepairKind, facts: RepairFacts, attemptAt: string, familyPassed: boolean): boolean | null {
  if (familyPassed) return true;
  return REPAIRS[kind].verify(facts, attemptAt);
}

/** The subject and params the writer takes, from the fresh facts. */
export function repairTarget(kind: RepairKind, facts: RepairFacts): { subject: FailureRecoveryRef; params: Record<string, unknown> } {
  const first = facts.subjects[0];
  const subject: FailureRecoveryRef = first ? { kind: 'task', id: first.taskId } : { kind: 'task', id: facts.incident.id };
  switch (kind) {
    case 'release_blocker':
      return { subject, params: { blockerTaskId: facts.blocker?.taskId ?? null, reason: facts.blocker?.state === 'merged' ? 'merged' : 'abandoned' } };
    case 'retry_stale_worker': {
      const s = facts.subjects.find(x => x.staleWorker);
      return { subject: s ? { kind: 'task', id: s.taskId } : subject, params: { accountId: s?.staleWorker?.accountId ?? null, workerId: s?.staleWorker?.workerId ?? null } };
    }
    case 'rerun_visual_audit':
      return {
        subject: facts.missions[0] ? { kind: 'mission', id: facts.missions[0].missionId } : subject,
        params: { missionIds: facts.missions.map(m => m.missionId), taskIds: facts.missions.map(m => m.audit?.taskId).filter((x): x is string => !!x) },
      };
    case 'kernel_ci_retry':
      return { subject, params: { ...(facts.kernel ?? {}) } };
    default:
      return { subject, params: {} };
  }
}

// ── The lead of a shared cause (§9.1) ───────────────────────────────────────

const SEVERITY: Record<FailureIncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The incident a shared repair runs on: highest severity, then the oldest, then by id. Same order as the queue's lead. */
export function leadIncidentOf<T extends Pick<StoredIncident, 'id' | 'severity' | 'firstSeenAt' | 'status'>>(incidents: readonly T[]): T | null {
  const open = incidents.filter(i => i.status !== 'resolved');
  const pool = open.length ? open : [...incidents];
  return [...pool].sort((a, b) =>
    SEVERITY[b.severity] - SEVERITY[a.severity]
    || (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0)
    || (a.id < b.id ? -1 : 1))[0] ?? null;
}

// ── Approved runbooks (§9.3) ────────────────────────────────────────────────

export type RunbookAnswer = RepairKind | 'wait' | 'escalate';

export interface DispatchRunbookFacts {
  outboxExhausted: boolean;
  taskPending: boolean;
  runnerOnline: boolean | null;
  redeliveredThisGeneration: boolean;
}

export interface ScrubRunbookFacts {
  fix: { status: string; prMerged: boolean | null } | null;
  captureFailedAfterFix: boolean | null;
  missionsWaiting: number;
  rerunThisGeneration: boolean;
}

/**
 * Approved by being merged under review; versioned as RUNBOOK_VERSION in the
 * attempt event. Pure: `(family, causeCode, freshFacts) → RepairKind | wait | escalate`.
 */
export const RUNBOOKS = {
  /** A task's delivery exhausted its attempts: deliver it once more per generation, only with a runner online. */
  'dispatch.delivery_exhausted': (f: DispatchRunbookFacts): RunbookAnswer => {
    if (!f.taskPending || !f.outboxExhausted) return 'wait';
    if (f.redeliveredThisGeneration) return 'escalate';
    if (f.runnerOnline !== true) return 'wait';
    return 'redeliver_dispatch';
  },
  /**
   * The QA clone's scrub hit the immutable-revision trigger. Never touches the
   * trigger or production: one fix task for the cause, then, once its PR
   * merged and no capture failed since, one audit re-run per mission.
   */
  'qa.scrub_immutable_violation': (f: ScrubRunbookFacts): RunbookAnswer => {
    if (f.missionsWaiting === 0) return 'wait';
    if (!f.fix || DEAD_FIX.has(f.fix.status)) return 'queue_fix';
    if (f.fix.prMerged !== true) return 'wait';
    if (f.captureFailedAfterFix !== false) return f.captureFailedAfterFix ? 'escalate' : 'wait';
    return f.rerunThisGeneration ? 'wait' : 'rerun_visual_audit';
  },
} as const;

export type RunbookId = keyof typeof RUNBOOKS;

/** The runbook that owns an incident, if any. */
export function runbookFor(i: Pick<StoredIncident, 'rule' | 'signature' | 'reasonCode'> & { causeCode?: string }): RunbookId | null {
  const code = i.causeCode ?? i.reasonCode;
  if (i.rule === 'infrastructure_failure' && code === 'infrastructure_failure.visual_qa.scrub' && /immutable/i.test(i.signature)) return 'qa.scrub_immutable_violation';
  if ((i.rule === 'repeated_failure' || i.rule === 'stranded_gate') && /dispatch|delivery/i.test(`${code}|${i.signature}`)) return 'dispatch.delivery_exhausted';
  return null;
}

// ── DB ──────────────────────────────────────────────────────────────────────

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type IncidentRow = typeof import('@buildd/core/db/schema').failureIncidents.$inferSelect;

export function toStoredIncident(r: IncidentRow): StoredIncident {
  return {
    id: r.id, workspaceId: r.workspaceId, signature: r.signature, detectorVersion: r.detectorVersion, rule: r.rule,
    reasonCode: r.reasonCode, title: r.title, severity: r.severity, status: r.status,
    firstSeenAt: r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(),
    occurrenceCount: r.occurrenceCount, recurrenceCount: r.recurrenceCount,
    affectedRefs: r.affectedRefs ?? { taskIds: [], workerIds: [], prNumbers: [] }, evidenceRefs: r.evidenceRefs ?? [],
    impact: r.impact ?? {}, lastAlertedAt: r.lastAlertedAt?.toISOString() ?? null, lastAlertSeverity: r.lastAlertSeverity,
    linkedFixTaskId: r.linkedFixTaskId, acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null, resolvedAt: r.resolvedAt?.toISOString() ?? null,
    recovery: r.recovery ?? null, version: r.version,
  };
}

/**
 * Open incidents whose stored membership (`recovery.causeGroup`) names
 * `causeKey`, filtered to those that group under it right now
 * (`effectiveCauseKey`: an operator regroup wins, a shadow model merge does
 * not). Bounded. Unassessed incidents have no stored membership and are not
 * members until their first assessment.
 */
export async function dbCauseMembers(causeKey: string, opts: { excludeId?: string } = {}): Promise<StoredIncident[]> {
  const [{ db }, { failureIncidents }, { and, ne, sql }, { effectiveCauseKey }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./failure-incident-cause-key'),
  ]);
  const g = sql`${failureIncidents.recovery}->'causeGroup'`;
  const rows = await db.select().from(failureIncidents).where(and(
    ne(failureIncidents.status, 'resolved'),
    opts.excludeId ? ne(failureIncidents.id, opts.excludeId) : undefined,
    sql`(${g}->>'key' = ${causeKey} OR ${g}->>'supersededBy' = ${causeKey} OR ${g}->>'ruleKey' = ${causeKey})`,
  )).limit(50);
  return rows.map(toStoredIncident).filter(i => effectiveCauseKey(i).key === causeKey);
}

/** The other open members of `incident`'s cause (§9.1). A failed read is no peers: the incident repairs alone rather than not at all. */
export async function dbCausePeers(incident: Pick<StoredIncident, 'id'>, causeKey: string): Promise<StoredIncident[]> {
  return dbCauseMembers(causeKey, { excludeId: incident.id });
}

/**
 * Read the facts every precondition and predicate needs, for `incident` and
 * the peers it shares a cause with, from their owners. A read that fails
 * leaves its field null (unknown), which no precondition treats as a pass.
 */
export async function loadRepairFacts(incident: StoredIncident, peers: readonly StoredIncident[] = []): Promise<RepairFacts> {
  const [{ db }, schema, { and, desc, eq, gt, inArray, isNull, sql }, shared] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/shared'),
  ]);
  const { tasks, workers, taskDispatchOutbox, pathClaims, workerHeartbeats } = schema;
  const now = new Date();
  const r = incident.recovery && incident.recovery.v === 1 ? incident.recovery : null;
  const all = [incident, ...peers];
  const subjectIds = [...new Set(all.flatMap(i => {
    const rr = i.recovery && i.recovery.v === 1 ? i.recovery : null;
    const fromRecovery = rr?.subjects.filter(s => s.kind === 'task').map(s => s.id) ?? [];
    return fromRecovery.length ? fromRecovery : i.affectedRefs.taskIds;
  }))].filter(isUuid).slice(0, 50);
  const ownSubjects = new Set((r?.subjects.filter(s => s.kind === 'task').map(s => s.id) ?? incident.affectedRefs.taskIds).filter(isUuid));
  const ordered = [...subjectIds].sort((a, b) => Number(ownSubjects.has(b)) - Number(ownSubjects.has(a)));

  const safe = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  // A blocker PR maps to the task that owns it (§5.3), through its worker row.
  const prBlocker = r?.blockers.find(b => b.kind === 'pr' && /^\d+$/.test(b.id));
  const prOwner = !r?.blockers.some(b => b.kind === 'task') && prBlocker && incident.workspaceId
    ? await safe(db.select({ taskId: workers.taskId }).from(workers)
      .where(and(eq(workers.workspaceId, incident.workspaceId), eq(workers.prNumber, Number(prBlocker.id)))).limit(1))
    : null;
  const blockerTaskId = r?.blockers.find(b => b.kind === 'task')?.id ?? prOwner?.[0]?.taskId ?? null;
  const fixId = incident.linkedFixTaskId ?? all.map(i => i.linkedFixTaskId).find(x => !!x) ?? null;
  const taskIdsToRead = [...new Set([...ordered, ...(fixId ? [fixId] : []), ...(blockerTaskId && isUuid(blockerTaskId) ? [blockerTaskId] : [])])];

  const [taskRows, workerRows, outboxRows, claimRows] = await Promise.all([
    safe(taskIdsToRead.length ? db.select({ id: tasks.id, status: tasks.status, missionId: tasks.missionId, workspaceId: tasks.workspaceId, context: tasks.context }).from(tasks).where(inArray(tasks.id, taskIdsToRead)) : Promise.resolve([])),
    safe(taskIdsToRead.length ? db.select({ id: workers.id, taskId: workers.taskId, status: workers.status, accountId: workers.accountId, createdAt: workers.createdAt, updatedAt: workers.updatedAt, error: workers.error, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus, prNumber: workers.prNumber })
      .from(workers).where(inArray(workers.taskId, taskIdsToRead)).orderBy(desc(workers.createdAt)).limit(500) : Promise.resolve([])),
    safe(ordered.length ? db.select({ taskId: taskDispatchOutbox.taskId, status: taskDispatchOutbox.status, attemptCount: taskDispatchOutbox.attemptCount, createdAt: taskDispatchOutbox.createdAt, deliveredAt: taskDispatchOutbox.deliveredAt })
      .from(taskDispatchOutbox).where(inArray(taskDispatchOutbox.taskId, ordered)).orderBy(desc(taskDispatchOutbox.createdAt)).limit(200) : Promise.resolve([])),
    safe(blockerTaskId && isUuid(blockerTaskId) ? db.select({ n: sql<number>`count(*)::int` }).from(pathClaims).where(and(eq(pathClaims.taskId, blockerTaskId), isNull(pathClaims.releasedAt))) : Promise.resolve(null)),
  ]);
  const taskById = new Map((taskRows ?? []).map(t => [t.id, t]));
  const workersByTask = new Map<string, NonNullable<typeof workerRows>>();
  for (const w of workerRows ?? []) if (w.taskId) workersByTask.set(w.taskId, [...(workersByTask.get(w.taskId) ?? []), w]);
  const outboxByTask = new Map<string, NonNullable<typeof outboxRows>[number]>();
  for (const o of outboxRows ?? []) if (!outboxByTask.has(o.taskId)) outboxByTask.set(o.taskId, o);
  const staleCutoff = now.getTime() - shared.WORKER_STALE_REAP_MS;

  const subjects: RepairSubjectFacts[] = ordered.map(id => {
    const t = taskById.get(id);
    const ws = workersByTask.get(id) ?? [];
    const stale = ws.find(w => (w.status === 'running' || w.status === 'starting') && w.updatedAt.getTime() < staleCutoff);
    const o = outboxByTask.get(id);
    const ctx = (t?.context ?? {}) as Record<string, unknown>;
    return {
      taskId: id,
      missionId: t?.missionId ?? null,
      status: taskRows === null ? null : t?.status ?? null,
      lastWorkerAt: ws[0]?.createdAt.toISOString() ?? null,
      outbox: o ? { status: o.status, attemptCount: o.attemptCount, createdAt: o.createdAt.toISOString(), deliveredAt: o.deliveredAt?.toISOString() ?? null } : null,
      staleWorker: stale ? { workerId: stale.id, accountId: stale.accountId, updatedAt: stale.updatedAt.toISOString() } : null,
      infraRetries: typeof ctx.infraRetryCount === 'number' ? ctx.infraRetryCount : 0,
    };
  });

  // Runner: any heartbeat inside the cutoff that serves the subjects' workspace.
  const wsId = incident.workspaceId ?? taskById.get(ordered[0] ?? '')?.workspaceId ?? null;
  const hb = wsId
    ? await safe(db.select({ id: workerHeartbeats.id }).from(workerHeartbeats)
      .where(and(gt(workerHeartbeats.lastHeartbeatAt, new Date(now.getTime() - shared.RUNNER_STALE_CUTOFF_MS)), sql`${workerHeartbeats.workspaceIds} @> ${JSON.stringify([wsId])}::jsonb`)).limit(1))
    : null;

  // The fix and whether its PR merged; a capture failure after the merge.
  let fix: RepairFacts['fix'] = null;
  let captureFailedAfterFix: boolean | null = null;
  if (fixId) {
    const t = taskById.get(fixId);
    const fw = workersByTask.get(fixId) ?? [];
    const merged = fw.find(w => w.mergedAt || w.prLifecycleStatus === 'merged');
    fix = t ? { taskId: fixId, status: t.status, prMerged: workerRows === null ? null : !!merged } : null;
    if (merged && workerRows !== null) {
      const mergedAt = (merged.mergedAt ?? merged.updatedAt).getTime();
      const component = /component=([^|]+)/.exec(incident.signature)?.[1] ?? null;
      captureFailedAfterFix = ordered.some(id => (workersByTask.get(id) ?? []).some(w =>
        w.createdAt.getTime() > mergedAt && !!w.error && (!component || w.error.includes(component.replace('visual_qa.', '')))
        && /capture|visual_qa|scrub|immutable/i.test(w.error)));
    }
  }

  // Missions: the newest surface audit of each subject mission.
  const missionIds = [...new Set(subjects.map(s => s.missionId).filter((x): x is string => !!x)
    .concat((r?.subjects ?? []).filter(s => s.kind === 'mission').map(s => s.id)))].filter(isUuid);
  const missions: RepairMissionFacts[] = missionIds.map(missionId => {
    const audit = subjects.filter(s => s.missionId === missionId).map(s => taskById.get(s.taskId)).find(Boolean);
    const aw = audit ? workersByTask.get(audit.id) ?? [] : [];
    const failed = aw.find(w => !!w.error && /capture|visual_qa|scrub|immutable/i.test(w.error));
    return {
      missionId,
      audit: audit ? { taskId: audit.id, status: audit.status, lastWorkerAt: aw[0]?.createdAt.toISOString() ?? null, captureFailedAt: failed?.createdAt.toISOString() ?? null } : null,
    };
  });

  const blocker = r?.blockers[0]
    ? { taskId: blockerTaskId, state: r.blockers[0].state, activeClaims: claimRows === null ? null : (claimRows?.[0]?.n ?? 0) }
    : null;

  // Kernel: a PR this incident names with a kernel delivery.
  let kernel: RepairFacts['kernel'] = null;
  const prNumber = incident.affectedRefs.prNumbers[0] ?? null;
  if (prNumber && incident.workspaceId) {
    const repo = await safe((async () => {
      const ws = await db.query.workspaces.findFirst({
        where: eq(schema.workspaces.id, incident.workspaceId!),
        columns: { id: true },
        with: { githubRepo: { columns: { fullName: true }, with: { installation: { columns: { installationId: true } } } } },
      });
      return ws?.githubRepo?.fullName && ws.githubRepo.installation?.installationId
        ? { fullName: ws.githubRepo.fullName, installationId: ws.githubRepo.installation.installationId } : null;
    })());
    if (repo) kernel = { workspaceId: incident.workspaceId, repoFullName: repo.fullName, prNumber, installationId: repo.installationId };
  }

  return {
    observedAt: now.toISOString(),
    incident: {
      id: incident.id, rule: incident.rule, causeCode: r?.cause.reasonCode ?? incident.reasonCode,
      generation: r?.generation ?? null, state: r?.state ?? null, spentKeys: r?.budget.spentKeys ?? [], linkedFixTaskId: incident.linkedFixTaskId,
    },
    blocker,
    subjects,
    runnerOnline: hb === null ? null : hb.length > 0,
    fix,
    captureFailedAfterFix,
    missions,
    kernel,
  };
}
