/**
 * Path-overlap recovery (docs/specs/failure-incident-recovery.md §6): the
 * first family on the recovery contract.
 *
 * `evaluatePathOverlap` is pure: the 8 rules over facts read now, one
 * (subject task, blocker) episode at a time, combined into one policy outcome
 * for `planRecovery`. `dbObservePathOverlapRecovery` reads those facts from
 * their owners — the task row, its workers, its newest `path_overlap`
 * deferral, its wakes in the dispatch outbox, the blocker's kernel delivery
 * and worker rows, its leases and waiters. It never writes.
 *
 * The check (§7) is per subject: the task started a worker since its episode
 * began, left `pending`, or is now deferred behind a different blocker (its
 * episode behind this one ended). A blocker that merged is not enough on its
 * own: the incident resolves only once every task it names is seen to move.
 */
import type { FailureRecoveryDecision, FailureRecoveryRef } from '@buildd/shared';
import type { BlockerPrState } from './failure-pattern-sentinel';
import type { RecoveryFamily, RecoveryPolicyOutcome, RecoveryVerdict } from './failure-incident-recovery';
import type { StoredIncident } from './failure-incident-store';

export interface PathOverlapSubjectFacts {
  taskId: string;
  /** `tasks.status`; null when the row was not found (unknown, never passed). */
  status: string | null;
  lastWorkerAt: string | null;
  /** The task's newest `path_overlap` deferral row. */
  lastDeferral: {
    at: string;
    prNumber: number | null;
    blockingTaskId: string | null;
    firstDeferredAt: string;
    paths: string[];
  } | null;
  /** Newest `path_claim.released` wake written for the task (any delivery status). */
  wokenAt: string | null;
  /** The PR the task's subject anchor names: it is exempt from blocking on it. */
  subjectPrNumber: number | null;
}

export interface PathOverlapBlockerFacts {
  prNumber: number | null;
  /** The task that owns the blocking PR or lease. */
  taskId: string | null;
  /** When the blocker came to exist (its PR's worker row). An episode never starts before it (I-8). */
  createdAt: string | null;
  prState: BlockerPrState;
  /** `workflow_deliveries.state`; null when the kernel does not own it. */
  deliveryState: string | null;
  /** Its delivery's last transition, or its newest worker update. */
  lastMovedAt: string | null;
  /** Leases the blocker task still holds. */
  leasesHeld: number;
  /** Subjects with a waiter row on the blocker that was never notified. */
  unnotifiedWaiters: string[];
  /** Subjects the blocker task, or an open repair attempt of its PR, depends on. */
  dependsOnSubjects: string[];
  /** Paths the blocker's PR diff touches; null when not read. */
  diffPaths: string[] | null;
}

export interface PathOverlapRecoveryFacts {
  subjects: PathOverlapSubjectFacts[];
  blocker: PathOverlapBlockerFacts | null;
  fixTask: { id: string; running: boolean } | null;
}

const TERMINAL_DELIVERY = new Set(['MERGED', 'SUPERSEDED', 'ABANDONED']);
const short = (id: string) => id.slice(0, 8);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

type Rule =
  | 'passed'
  | 'blocker_merged_unreleased'
  | 'cycle'
  | 'subject_exempt_violated'
  | 'spurious_overlap'
  | 'blocker_stuck'
  | 'blocker_open'
  | 'unknown';

interface SubjectJudgement {
  subject: string;
  rule: Rule;
  verdict: RecoveryVerdict;
  episodeStartedAt: string;
  paths: string[];
}

/** The order a combined verdict is chosen in: what needs acting on first. */
const VERDICT_RANK: Record<RecoveryVerdict['kind'], number> = {
  decide: 0, repair: 1, operator: 2, delegated: 3, wait: 4, inconclusive: 5, passed: 6,
};

function blockerLabel(b: PathOverlapBlockerFacts | null): string {
  if (b?.prNumber != null) return `PR #${b.prNumber}`;
  if (b?.taskId) return `task ${short(b.taskId)}`;
  return 'an overlapping change';
}

function fallbackDecision(subjects: string[], b: PathOverlapBlockerFacts | null): FailureRecoveryDecision {
  const who = subjects.length === 1 ? `Task ${short(subjects[0])} is` : `${subjects.length} tasks are`;
  return {
    question: `${who} still waiting on ${blockerLabel(b)} and Buildd has nothing left to try. Choose one.`,
    options: [
      { capability: 'open_blocker', label: `Open ${blockerLabel(b)}`, effect: 'See why it is not landing, and act on it there.' },
      { capability: 'narrow_subject_manifest', label: 'Narrow the waiting task', effect: 'Limit the waiting task to the files it declared, so it can start.' },
      { capability: 'retry_recovery', label: 'Try again', effect: 'Buildd re-reads the facts and repairs what it can, with a fresh budget.' },
      { capability: 'dismiss', label: 'Dismiss', effect: 'It leaves Needs You; Buildd keeps checking and resolves it when the task moves.' },
    ],
    recommended: 'open_blocker',
  };
}

function cycleDecision(subject: string, b: PathOverlapBlockerFacts): FailureRecoveryDecision {
  return {
    question: `Task ${short(subject)} and ${blockerLabel(b)}'s fix are waiting on each other. Choose one to stop.`,
    options: [
      { capability: 'cancel_attempt', label: 'Cancel the stale attempt', effect: `Stops the attempt on ${blockerLabel(b)} so task ${short(subject)} can start.` },
      { capability: 'narrow_subject_manifest', label: 'Narrow the waiting task', effect: 'Limits the waiting task to the files it declared, which may end the overlap.' },
      { capability: 'dismiss', label: 'Leave both waiting', effect: 'Nothing changes; it leaves Needs You.' },
    ],
    recommended: 'cancel_attempt',
  };
}

/** The episode behind THIS blocker: from its first deferral on it, never before the blocker existed (I-8). */
function episodeStart(s: PathOverlapSubjectFacts, b: PathOverlapBlockerFacts | null, fallback: string): string {
  const onThis = !!s.lastDeferral && !!b && (
    (b.prNumber != null && s.lastDeferral.prNumber === b.prNumber) ||
    (b.prNumber == null && b.taskId != null && s.lastDeferral.blockingTaskId === b.taskId)
  );
  const start = onThis ? s.lastDeferral!.firstDeferredAt : fallback;
  return b?.createdAt && b.createdAt > start ? b.createdAt : start;
}

/** §6 rule 1, the per-subject check. */
function subjectProgressed(s: PathOverlapSubjectFacts, b: PathOverlapBlockerFacts | null, since: string): boolean {
  if (s.status === null) return false;
  if (s.status !== 'pending') return true;
  if (s.lastWorkerAt && s.lastWorkerAt > since) return true;
  // Deferred behind a different blocker since: this episode is over (that one is its own incident).
  const d = s.lastDeferral;
  if (d && d.at > since && b) {
    const samePr = b.prNumber != null && d.prNumber === b.prNumber;
    const sameTask = b.taskId != null && d.blockingTaskId === b.taskId;
    if (!samePr && !sameTask) return true;
  }
  return false;
}

function judgeSubject(
  s: PathOverlapSubjectFacts,
  b: PathOverlapBlockerFacts | null,
  fixTask: PathOverlapRecoveryFacts['fixTask'],
  incidentFirstSeenAt: string,
  lastCheckAt: string | null,
): SubjectJudgement {
  const since = episodeStart(s, b, incidentFirstSeenAt);
  const paths = s.lastDeferral?.paths ?? [];
  const j = (rule: Rule, verdict: RecoveryVerdict): SubjectJudgement => ({ subject: s.taskId, rule, verdict, episodeStartedAt: since, paths });
  const subjectRef: FailureRecoveryRef = { kind: 'task', id: s.taskId };

  // 1. The subject is no longer stuck.
  if (subjectProgressed(s, b, since)) return j('passed', { kind: 'passed', summary: `task ${short(s.taskId)} moved` });
  if (s.status === null || !b || b.prState === 'unknown' && b.taskId === null) {
    return j('unknown', { kind: 'inconclusive', reason: `Buildd couldn't confirm what task ${short(s.taskId)} is waiting on.` });
  }

  const gone = b.prState === 'merged' || b.prState === 'closed';
  // 2. The blocker landed or closed, but its leases are held or this waiter was never told.
  if (gone && b.taskId && (b.leasesHeld > 0 || b.unnotifiedWaiters.includes(s.taskId))) {
    return j('blocker_merged_unreleased', {
      kind: 'repair', action: 'release_blocker', subject: { kind: 'task', id: b.taskId },
      label: `${blockerLabel(b)} ${b.prState === 'merged' ? 'landed' : 'closed'}; Buildd is releasing its files.`,
      params: { blockerTaskId: b.taskId, reason: b.prState === 'merged' ? 'merged' : 'abandoned' },
    });
  }
  // 3. The blocker is gone and the subject was never woken in this episode.
  if (gone) {
    if (!s.wokenAt || s.wokenAt < since) {
      return j('blocker_merged_unreleased', {
        kind: 'repair', action: 'wake_subject', subject: subjectRef, once: true,
        label: `${blockerLabel(b)} ${b.prState === 'merged' ? 'landed' : 'closed'}; Buildd restarted task ${short(s.taskId)}.`,
        params: {},
      });
    }
    return j('blocker_merged_unreleased', {
      kind: 'wait', label: `${blockerLabel(b)} ${b.prState === 'merged' ? 'landed' : 'closed'}; task ${short(s.taskId)} was woken and is waiting for a runner.`,
    });
  }
  // 6. A cycle: waiting cannot help.
  if (b.dependsOnSubjects.includes(s.taskId)) return j('cycle', { kind: 'decide', decision: cycleDecision(s.taskId, b) });

  const platformDefect = (rule: 'subject_exempt_violated' | 'spurious_overlap', what: string): SubjectJudgement => {
    if (fixTask?.running) {
      return j(rule, { kind: 'delegated', nextActionKind: 'fix_task_running', label: `Buildd is fixing ${what} (task ${short(fixTask.id)}).`, ref: `fix:${fixTask.id}` });
    }
    if (fixTask) {
      return j(rule, {
        kind: 'decide',
        decision: {
          ...fallbackDecision([s.taskId], b),
          question: `Buildd's fix for ${what} finished, but task ${short(s.taskId)} is still held. Choose one.`,
          ...(rule === 'spurious_overlap'
            ? { options: [{ capability: 'narrow_blocker_manifest' as const, label: `Narrow ${blockerLabel(b)} to its diff`, effect: 'Its declared files shrink to the ones it actually changes.' }, ...fallbackDecision([s.taskId], b).options], recommended: 'narrow_blocker_manifest' as const }
            : {}),
        },
      });
    }
    return j(rule, { kind: 'repair', action: 'file_fix_task', subject: subjectRef, once: true, label: `Buildd filed a fix for ${what}.`, params: {} });
  };
  // 8. The subject is exempt from this blocker, yet still deferred on it: a platform defect.
  if (b.prNumber != null && s.subjectPrNumber === b.prNumber) {
    return platformDefect('subject_exempt_violated', `task ${short(s.taskId)} being held behind the PR it works on`);
  }
  // 7. The overlap is spurious: the blocker's actual diff touches none of the paths.
  if (b.diffPaths && paths.length > 0 && !paths.some(p => b.diffPaths!.some(d => d === p || d.startsWith(`${p}/`) || p.startsWith(`${d}/`)))) {
    return platformDefect('spurious_overlap', `${blockerLabel(b)} declaring files it does not change`);
  }
  // 5. The blocker is open and stuck on a decision of its own: that card is the one card.
  if (b.deliveryState === 'ESCALATED') {
    return j('blocker_stuck', {
      kind: 'delegated', nextActionKind: 'blocked_by_escalation',
      label: `Waiting on a decision on ${blockerLabel(b)}; task ${short(s.taskId)} starts once it lands.`,
      ref: b.prNumber != null ? `pr:${b.prNumber}` : `task:${b.taskId}`,
    });
  }
  // 4. The blocker is open and moving; or open and not moving, which the deadline turns into a decision.
  const moving = b.deliveryState === null || !TERMINAL_DELIVERY.has(b.deliveryState)
    ? !!b.lastMovedAt && b.lastMovedAt >= (lastCheckAt ?? since)
    : false;
  return j(moving ? 'blocker_open' : 'blocker_stuck', { kind: 'wait', label: `Waiting for ${blockerLabel(b)} to land.` });
}

/** Pure. The path-overlap policy (§6) over fresh facts, for one incident. */
export function evaluatePathOverlap(incident: StoredIncident, facts: PathOverlapRecoveryFacts, now: string): RecoveryPolicyOutcome {
  const b = facts.blocker;
  const lastCheckAt = incident.recovery?.observation.observedAt ?? null;
  const judged = facts.subjects.map(s => judgeSubject(s, b, facts.fixTask, incident.firstSeenAt, lastCheckAt));
  const subjects = facts.subjects.map(s => ({ kind: 'task' as const, id: s.taskId }));
  const pending = judged.filter(x => x.verdict.kind !== 'passed');
  // Refs were capped: a task the incident did not keep cannot be checked, so "every subject" is unknown.
  const untracked = (incident.impact.stalledTasks ?? 0) > facts.subjects.length;

  let verdict: RecoveryVerdict;
  let rule: Rule;
  if (judged.length === 0) {
    verdict = { kind: 'inconclusive', reason: 'Buildd has no task on record for this incident to check.' };
    rule = 'unknown';
  } else if (pending.length === 0) {
    verdict = untracked
      ? { kind: 'inconclusive', reason: 'More tasks were held than Buildd kept a record of, so it cannot confirm all of them moved.' }
      : { kind: 'passed', summary: judged.map(x => (x.verdict as { summary: string }).summary).join('; ') };
    rule = untracked ? 'unknown' : 'passed';
  } else {
    const top = [...pending].sort((x, y) => VERDICT_RANK[x.verdict.kind] - VERDICT_RANK[y.verdict.kind])[0];
    verdict = top.verdict;
    rule = top.rule;
  }

  const priorCause = incident.recovery?.cause.reasonCode;
  const reasonCode = rule === 'passed' || rule === 'unknown'
    ? priorCause ?? 'path_overlap.blocker_open'
    : `path_overlap.${rule}`;
  const episodes = (pending.length > 0 ? pending : judged).map(x => x.episodeStartedAt);
  const episodeStartedAt = episodes.length > 0 ? episodes.reduce((m, x) => (x < m ? x : m)) : incident.firstSeenAt;
  const lastProgressAt = facts.subjects.reduce<string | null>((acc, s) => {
    const since = episodeStart(s, b, incident.firstSeenAt);
    const worker = s.lastWorkerAt && s.lastWorkerAt > since ? s.lastWorkerAt : null;
    const woken = s.wokenAt && s.wokenAt > since ? s.wokenAt : null;
    return later(acc, later(worker, woken));
  }, b?.lastMovedAt ?? null);

  return {
    cause: { reasonCode, rule: 'path_overlap_stall', ownership: rule === 'subject_exempt_violated' || rule === 'spurious_overlap' ? 'infrastructure' : 'workflow' },
    subjects,
    blockers: b
      ? [{ kind: b.prNumber != null ? 'pr' : 'task', id: b.prNumber != null ? String(b.prNumber) : b.taskId ?? 'unknown', state: b.deliveryState ?? b.prState, observedAt: now }]
      : [],
    overlappingPaths: [...new Set(judged.flatMap(x => x.paths))].slice(0, 20),
    episodeStartedAt,
    lastProgressAt,
    verdict,
    verification: {
      predicate: 'path_overlap.every_subject_progressed',
      params: { subjects: subjects.map(s => s.id), blockerPr: b?.prNumber ?? null },
    },
    fallbackDecision: fallbackDecision(pending.map(x => x.subject), b),
  };
}

// ── Facts from their owners ─────────────────────────────────────────────────

/**
 * Read one incident's path-overlap facts. Only SELECTs. A row the read cannot
 * find is reported as unknown (`status: null`, `prState: 'unknown'`), never
 * as moved; a query that throws propagates, and the caller treats the whole
 * assessment as inconclusive.
 */
export async function dbObservePathOverlapRecovery(incident: StoredIncident): Promise<{ complete: boolean; facts: PathOverlapRecoveryFacts }> {
  const [{ db }, schema, orm, shared, { GATE_SLUGS }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/shared'),
    import('@buildd/core/gate-slugs'),
  ]);
  const { tasks, workers, gateEvents, taskDispatchOutbox, pathClaims, pathClaimWaiters } = schema;
  const { and, eq, desc, inArray, isNull, sql, or, notInArray } = orm;
  const workspaceId = incident.workspaceId;
  const taskIds = incident.affectedRefs.taskIds;
  const prNumber = incident.affectedRefs.prNumbers[0] ?? null;
  if (!workspaceId) return { complete: false, facts: { subjects: [], blocker: null, fixTask: null } };

  // Subjects: task row, newest worker, newest path_overlap deferral, newest release wake.
  const taskRows = taskIds.length === 0 ? [] : await db
    .select({ id: tasks.id, status: tasks.status, subjectPrNumber: tasks.subjectPrNumber })
    .from(tasks).where(inArray(tasks.id, taskIds));
  const workerRows = taskIds.length === 0 ? [] : await db
    .select({ taskId: workers.taskId, createdAt: workers.createdAt })
    .from(workers).where(inArray(workers.taskId, taskIds));
  const deferralRows = taskIds.length === 0 ? [] : await db
    .select({ taskId: gateEvents.taskId, detail: gateEvents.detail, occurredAt: gateEvents.occurredAt })
    .from(gateEvents)
    .where(and(inArray(gateEvents.taskId, taskIds), eq(gateEvents.gate, GATE_SLUGS.CLAIM_LOOP_DEFERRAL), eq(gateEvents.reason, 'path_overlap')))
    .orderBy(desc(gateEvents.occurredAt))
    .limit(taskIds.length * 5);
  const wakeRows = taskIds.length === 0 ? [] : await db
    .select({ taskId: taskDispatchOutbox.taskId, createdAt: taskDispatchOutbox.createdAt })
    .from(taskDispatchOutbox)
    .where(and(
      inArray(taskDispatchOutbox.taskId, taskIds),
      or(eq(taskDispatchOutbox.cause, 'path_claim.released'), sql`${taskDispatchOutbox.causes} @> '["path_claim.released"]'::jsonb`),
    ))
    .orderBy(desc(taskDispatchOutbox.createdAt))
    .limit(taskIds.length * 5);

  const newest = new Map<string, string>();
  for (const w of workerRows) {
    if (!w.taskId) continue;
    const at = w.createdAt.toISOString();
    if (!newest.has(w.taskId) || at > newest.get(w.taskId)!) newest.set(w.taskId, at);
  }
  const deferralByTask = new Map<string, PathOverlapSubjectFacts['lastDeferral']>();
  for (const r of deferralRows) {
    if (!r.taskId || deferralByTask.has(r.taskId)) continue;
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const at = r.occurredAt.toISOString();
    deferralByTask.set(r.taskId, {
      at,
      prNumber: typeof d.prNumber === 'number' ? d.prNumber : null,
      blockingTaskId: typeof d.blockingTaskId === 'string' ? d.blockingTaskId : null,
      firstDeferredAt: typeof d.firstDeferredAt === 'string' ? d.firstDeferredAt : at,
      paths: Array.isArray(d.paths) ? (d.paths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 20) : [],
    });
  }
  const wokenByTask = new Map<string, string>();
  for (const r of wakeRows) if (!wokenByTask.has(r.taskId)) wokenByTask.set(r.taskId, r.createdAt.toISOString());

  const byId = new Map(taskRows.map(t => [t.id, t]));
  const subjects: PathOverlapSubjectFacts[] = taskIds.map(id => ({
    taskId: id,
    status: byId.get(id)?.status ?? null,
    lastWorkerAt: newest.get(id) ?? null,
    lastDeferral: deferralByTask.get(id) ?? null,
    wokenAt: wokenByTask.get(id) ?? null,
    subjectPrNumber: byId.get(id)?.subjectPrNumber ?? null,
  }));

  // Blocker: kernel delivery first, then the PR's worker rows.
  let blocker: PathOverlapBlockerFacts | null = null;
  if (prNumber !== null) {
    // The kernel's delivery, through its own read (the kernel tables have one reader module).
    const { deliveryBlockerFacts } = await import('./workflow/delivery-view');
    const delivery = await deliveryBlockerFacts(workspaceId, prNumber);
    const prWorkers = await db
      .select({ taskId: workers.taskId, createdAt: workers.createdAt, updatedAt: workers.updatedAt, mergedAt: workers.mergedAt, prLifecycleStatus: workers.prLifecycleStatus })
      .from(workers)
      .where(and(eq(workers.workspaceId, workspaceId), eq(workers.prNumber, prNumber)));
    const fromWorkers: BlockerPrState = prWorkers.some(w => w.mergedAt || w.prLifecycleStatus === 'merged') ? 'merged'
      : prWorkers.some(w => w.prLifecycleStatus === 'closed') ? 'closed'
        : prWorkers.length > 0 && prWorkers.every(w => w.prLifecycleStatus !== 'unresolvable') ? 'open' : 'unknown';
    const fromDelivery: BlockerPrState | null = !delivery ? null
      : delivery.mergedAt || delivery.state === 'MERGED' ? 'merged'
        : delivery.state === 'SUPERSEDED' || delivery.state === 'ABANDONED' ? 'closed' : 'open';
    const rank: Record<BlockerPrState, number> = { unknown: 0, open: 1, closed: 2, merged: 3 };
    const prState = fromDelivery && rank[fromDelivery] >= rank[fromWorkers] ? fromDelivery : fromWorkers;
    const ownerTaskId = delivery?.ownerTaskId ?? prWorkers.find(w => w.taskId)?.taskId ?? null;
    const createdAt = prWorkers.map(w => w.createdAt.toISOString()).sort()[0] ?? null;
    const workerMoved = prWorkers.map(w => w.updatedAt?.toISOString() ?? null).filter((x): x is string => !!x).sort().pop() ?? null;

    let leasesHeld = 0;
    let unnotifiedWaiters: string[] = [];
    let dependsOnSubjects: string[] = [];
    if (ownerTaskId) {
      const [leases] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pathClaims)
        .where(and(eq(pathClaims.taskId, ownerTaskId), isNull(pathClaims.releasedAt)));
      leasesHeld = Number(leases?.n ?? 0);
      if (taskIds.length > 0) {
        const waiters = await db
          .select({ waitingTaskId: pathClaimWaiters.waitingTaskId })
          .from(pathClaimWaiters)
          .where(and(eq(pathClaimWaiters.blockingTaskId, ownerTaskId), inArray(pathClaimWaiters.waitingTaskId, taskIds), isNull(pathClaimWaiters.notifiedAt)));
        unnotifiedWaiters = [...new Set(waiters.map(w => w.waitingTaskId))];
      }
      // The blocker, and any open repair attempt of its PR, depending on a subject is the deadlock.
      const dependents = await db
        .select({ dependsOn: tasks.dependsOn })
        .from(tasks)
        .where(or(
          eq(tasks.id, ownerTaskId),
          and(
            eq(tasks.workspaceId, workspaceId),
            notInArray(tasks.status, [...shared.TERMINAL_TASK_STATUSES]),
            or(eq(tasks.conflictRetryPrNumber, prNumber), eq(tasks.ciRetryPrNumber, prNumber), eq(tasks.reviewerRetryPrNumber, prNumber)),
          ),
        ))
        .limit(20);
      const subjectSet = new Set(taskIds);
      dependsOnSubjects = [...new Set(dependents.flatMap(d => (d.dependsOn ?? []).filter(id => subjectSet.has(id))))];
    }

    blocker = {
      prNumber,
      taskId: ownerTaskId,
      createdAt,
      prState,
      deliveryState: delivery?.state ?? null,
      lastMovedAt: later(delivery?.lastMovedAt ?? null, workerMoved),
      leasesHeld,
      unnotifiedWaiters,
      dependsOnSubjects,
      // The PR diff is not read here (no GitHub call on the sweep path): rule 7 stays dark until it is.
      diffPaths: null,
    };
  }

  let fixTask: PathOverlapRecoveryFacts['fixTask'] = null;
  if (incident.linkedFixTaskId) {
    const [t] = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.id, incident.linkedFixTaskId)).limit(1);
    if (t) fixTask = { id: t.id, running: !(shared.TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status) };
  }

  return { complete: taskRows.length === taskIds.length, facts: { subjects, blocker, fixTask } };
}

/** The path-overlap family on the recovery contract. */
export const pathOverlapRecoveryFamily: RecoveryFamily<PathOverlapRecoveryFacts> = {
  rule: 'path_overlap_stall',
  observe: dbObservePathOverlapRecovery,
  evaluate: evaluatePathOverlap,
};
