/**
 * The DB side of `supersession.ts`: loading tasks through binding keys, the
 * event and dispatch facts the rules read, the cancelling CAS, and the ledger.
 *
 * Kept apart from the rules so the table stays pure and importable without a
 * database; `reconcileSubjectEvent` loads this module lazily.
 */

import { db } from '@buildd/core/db';
import { missionNotes, tasks, taskSubjectReports, workers } from '@buildd/core/db/schema';
import { GATE_SLUGS, recordGateEvent } from '@buildd/core/gate-events';
import { LIVE_WORKER_STATUSES } from '@buildd/shared';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { appendPrActivity, type PrActivityEntry } from './pr-activity-comment';
import { releaseAndNotify } from './path-claim-release';
import { channels, events, triggerEvent } from './pusher';
import {
  MAX_CANCELS_PER_EVENT,
  OPEN_STATUSES,
  type CancelDecision,
  type DispatchFacts,
  type DispatchProposal,
  type EventFacts,
  type ReviewVerdict,
  type SubjectEvent,
  type SupersessionCandidate,
  type SupersessionRule,
  type SupersessionStore,
} from './supersession';

const DEAD_LIFECYCLE = new Set(['closed', 'merged']);

const CANDIDATE_COLUMNS = {
  id: true,
  workspaceId: true,
  missionId: true,
  status: true,
  parentTaskId: true,
  category: true,
  taskClass: true,
  creationSource: true,
  reviewerRetryPrNumber: true,
  reviewerRetryHeadSha: true,
  ciRetryPrNumber: true,
  subjectPrNumber: true,
  // `source` lives only in the jsonb anchor; an unselected anchor reads as
  // advisory, which would silently stop every anchored cancellation.
  subjectAnchor: true,
  subjectResolution: true,
  context: true,
  createdAt: true,
} as const;

function eventPrNumber(event: SubjectEvent): number | null {
  if ('prNumber' in event && typeof event.prNumber === 'number') return event.prNumber;
  return null;
}

/** The binding-key WHERE for an event. Never a prose match. */
function bindingCondition(event: SubjectEvent) {
  switch (event.kind) {
    case 'verdict':
    case 'merged':
    case 'closed':
    case 'subject_check': {
      const pr = event.prNumber;
      const keys = [
        eq(tasks.reviewerRetryPrNumber, pr),
        eq(tasks.ciRetryPrNumber, pr),
        // Advisory anchors still load here; the rules ignore them
        // (isBindingSubjectAnchor), so the decision stays in one place.
        eq(tasks.subjectPrNumber, pr),
      ];
      if (event.originalTaskId) {
        keys.push(and(
          eq(tasks.category, 'review'),
          or(
            eq(tasks.parentTaskId, event.originalTaskId),
            sql`${tasks.context}->>'reviewerFor' = ${event.originalTaskId}`,
          ),
        )!);
      }
      return or(...keys)!;
    }
    case 'parent_done':
      return eq(tasks.parentTaskId, event.parentTaskId);
    case 'cancelled':
      return eq(tasks.parentTaskId, event.taskId);
  }
}

async function loadCandidates(event: SubjectEvent): Promise<SupersessionCandidate[]> {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.workspaceId, event.workspaceId),
      inArray(tasks.status, [...OPEN_STATUSES]),
      bindingCondition(event),
    ),
    columns: CANDIDATE_COLUMNS,
  });
  if (rows.length === 0) return [];

  // Each task's own open PR, for the "own live PR is not the subject" bound.
  const prWorkers = await db.query.workers.findMany({
    where: and(inArray(workers.taskId, rows.map(r => r.id)), isNotNull(workers.prNumber)),
    columns: { taskId: true, prNumber: true, prLifecycleStatus: true, mergedAt: true, createdAt: true },
    orderBy: [desc(workers.createdAt)],
  });
  const ownLive = new Map<string, number>();
  for (const w of prWorkers) {
    if (!w.taskId || w.prNumber == null || ownLive.has(w.taskId)) continue;
    if (w.mergedAt || (w.prLifecycleStatus && DEAD_LIFECYCLE.has(w.prLifecycleStatus))) continue;
    ownLive.set(w.taskId, w.prNumber);
  }

  return rows.map(r => ({
    ...(r as Omit<SupersessionCandidate, 'ownLivePrNumber'>),
    context: (r.context ?? null) as Record<string, unknown> | null,
    subjectAnchor: (r.subjectAnchor ?? null) as SupersessionCandidate['subjectAnchor'],
    ownLivePrNumber: ownLive.get(r.id) ?? null,
  }));
}

/**
 * Whether any member of the subject PR's retry chain still has an open PR —
 * the liveness half of what `sweepSubjectAnchoredTasks` used to compute. The
 * chain is every task anchored to the PR, their parents, and the parents'
 * other children. A worker with no lifecycle yet (no PR) does not count.
 */
export async function subjectHasLiveSuccessor(workspaceId: string, prNumber: number): Promise<boolean> {
  const anchored = await db.query.tasks.findMany({
    where: and(eq(tasks.workspaceId, workspaceId), eq(tasks.subjectPrNumber, prNumber)),
    columns: { id: true, parentTaskId: true },
  });
  if (anchored.length === 0) return false;

  const taskIds = new Set(anchored.map(t => t.id));
  const parentIds = anchored.map(t => t.parentTaskId).filter((id): id is string => !!id);
  if (parentIds.length > 0) {
    for (const p of parentIds) taskIds.add(p);
    const siblings = await db.query.tasks.findMany({
      where: inArray(tasks.parentTaskId, parentIds),
      columns: { id: true },
    });
    for (const s of siblings) taskIds.add(s.id);
  }

  const chainWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, [...taskIds]),
      isNotNull(workers.prNumber),
      isNotNull(workers.prLifecycleStatus),
    ),
    columns: { prLifecycleStatus: true },
  });
  return chainWorkers.some(w => !!w.prLifecycleStatus && !DEAD_LIFECYCLE.has(w.prLifecycleStatus));
}

async function loadEventFacts(event: SubjectEvent): Promise<EventFacts> {
  const pr = eventPrNumber(event);
  if (pr == null) return {};
  return { subjectHasLiveSuccessor: await subjectHasLiveSuccessor(event.workspaceId, pr) };
}

function verdictOf(result: unknown): ReviewVerdict | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const so = (r.structuredOutput ?? {}) as Record<string, unknown>;
  const v = (r.effectiveVerdict ?? so.verdict) as unknown;
  return v === 'approve' || v === 'request-changes' || v === 'escalate' ? v : null;
}

async function loadDispatchFacts(p: DispatchProposal): Promise<DispatchFacts> {
  const facts: DispatchFacts = {};

  if (p.prNumber != null) {
    const prWorker = await db.query.workers.findFirst({
      where: and(eq(workers.workspaceId, p.workspaceId), eq(workers.prNumber, p.prNumber)),
      columns: { prLifecycleStatus: true, mergedAt: true },
      orderBy: [desc(workers.createdAt)],
    });
    facts.prState = !prWorker
      ? null
      : prWorker.mergedAt || prWorker.prLifecycleStatus === 'merged'
        ? 'merged'
        : prWorker.prLifecycleStatus === 'closed' ? 'closed' : 'open';

    if (p.kind === 'fix') {
      const { findReviewTaskForPr } = await import('./pr-review-request');
      const newest = await findReviewTaskForPr(p.workspaceId, p.prNumber);
      facts.newestReviewTaskId = newest?.id ?? null;
      facts.newestReviewVerdict = newest?.status === 'completed' ? verdictOf(newest.result) : null;
    }
  }

  if (p.parentTaskId) {
    const parent = await db.query.tasks.findFirst({
      where: eq(tasks.id, p.parentTaskId),
      columns: { status: true },
    });
    facts.parentStatus = parent?.status ?? null;
    if (parent?.status === 'completed') {
      const merged = await db.query.workers.findFirst({
        where: and(eq(workers.taskId, p.parentTaskId), isNotNull(workers.mergedAt)),
        columns: { id: true },
      });
      facts.parentMerged = !!merged;
    }
  }
  return facts;
}

async function casCancel(task: SupersessionCandidate, rule: SupersessionRule): Promise<boolean> {
  const statuses = [...(rule.casStatuses ?? OPEN_STATUSES)] as Array<(typeof OPEN_STATUSES)[number]>;
  const [won] = await db
    .update(tasks)
    .set({ ...(rule.stamp ?? {}), status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), inArray(tasks.status, statuses)))
    .returning({ id: tasks.id });
  return !!won;
}

async function applyCancelEffects(task: SupersessionCandidate, rule: SupersessionRule, event: SubjectEvent): Promise<void> {
  // The task CAS is already won, so a claim that comes after fails its own
  // pending-status CAS; a claim that won before is read here.
  const liveWorkers = await db.query.workers.findMany({
    where: and(eq(workers.taskId, task.id), inArray(workers.status, [...LIVE_WORKER_STATUSES])),
    columns: { id: true, status: true },
  });
  for (const w of liveWorkers) {
    await db.update(workers).set({
      status: 'failed',
      error: `Superseded — ${rule.label}`,
      exitCause: 'condition_unmet',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(workers.id, w.id), eq(workers.status, w.status)));
  }

  // Not a cancel through PATCH /api/tasks/[id]: release claims here. Nothing
  // landed from superseded work, so 'abandoned' is always right.
  await releaseAndNotify(task.id, 'abandoned');

  const push = (send: () => Promise<unknown>) =>
    Promise.resolve().then(send).catch(err =>
      console.warn(`[supersession] push failed for task ${task.id}:`, err));
  await Promise.all([
    push(() => triggerEvent(channels.workspace(task.workspaceId), events.TASK_UPDATED, {
      task: { id: task.id, status: 'cancelled', workspaceId: task.workspaceId, missionId: task.missionId },
    })),
    ...liveWorkers.map(w => push(() => triggerEvent(channels.worker(w.id), events.WORKER_COMMAND, {
      action: 'abort', reason: rule.id, timestamp: Date.now(),
    }))),
  ]);

  if (rule.id === 'close_reconciles_subject') {
    const pr = eventPrNumber(event);
    await db.insert(taskSubjectReports).values({
      taskId: task.id,
      origin: 'system',
      note: `subject_reconciled: PR #${pr} is dead (closed/merged, no live successor) — task cancelled so dependents unblock`,
      anchorSnapshot: task.subjectAnchor as never,
    }).catch(err => console.error('[supersession] subject report failed:', err));
  }
}

/** Existing activity kinds keep their wording; the rest share one row. */
function activityEntry(rule: SupersessionRule): PrActivityEntry {
  if (rule.id === 'approve_supersedes_fix') return { kind: 'fix_superseded_by_approval' };
  if (rule.id === 'merge_supersedes_review') return { kind: 'review_superseded_by_merge' };
  return { kind: 'work_superseded', detail: rule.label };
}

function summarizeEvent(event: SubjectEvent): Record<string, unknown> {
  const { pr: _pr, ...rest } = event as SubjectEvent & { pr?: unknown };
  return rest;
}

function eventTaskRef(event: SubjectEvent): string | null {
  switch (event.kind) {
    case 'parent_done': return event.parentTaskId;
    case 'cancelled': return event.taskId;
    default: return event.originalTaskId ?? null;
  }
}

async function recordSupersession(task: SupersessionCandidate, rule: SupersessionRule, event: SubjectEvent): Promise<void> {
  await recordGateEvent({
    gate: GATE_SLUGS.SUPERSESSION,
    surface: event.door,
    outcome: 'accepted',
    reason: `task superseded: ${rule.id}`,
    workspaceId: task.workspaceId,
    missionId: task.missionId,
    taskId: task.id,
    callerOrigin: 'system',
    detail: { rule: rule.id, event: summarizeEvent(event) },
  });

  const pr = eventPrNumber(event);
  if (task.missionId) {
    await db.insert(missionNotes).values({
      missionId: task.missionId,
      taskId: eventTaskRef(event) ?? task.id,
      authorType: 'system',
      type: 'reviewer_superseded',
      title: pr != null ? `PR #${pr}: ${rule.label}` : capitalizeFirst(rule.label),
      body: `Cancelled by supersession rule ${rule.id} on a ${event.kind} event, so it does not run against work that is already decided.`,
      status: 'open',
    }).catch(err => console.error('[supersession] mission note failed:', err));
  }
  if (pr != null && event.pr) {
    await appendPrActivity({
      installationId: event.pr.installationId,
      repoFullName: event.pr.repoFullName,
      prNumber: pr,
      entry: activityEntry(rule),
      workspaceId: task.workspaceId,
    }).catch(() => {});
  }
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function recordBulkRefusal(event: SubjectEvent, wouldCancel: CancelDecision[]): Promise<void> {
  const set = wouldCancel.map(d => ({ taskId: d.task.id, rule: d.rule }));
  await recordGateEvent({
    gate: GATE_SLUGS.SUPERSESSION,
    surface: event.door,
    outcome: 'rejected',
    reason: `supersession bound: one event would cancel more than ${MAX_CANCELS_PER_EVENT} tasks`,
    workspaceId: event.workspaceId,
    missionId: wouldCancel[0]?.task.missionId ?? null,
    taskId: eventTaskRef(event),
    callerOrigin: 'system',
    detail: { event: summarizeEvent(event), wouldCancel: set },
  });
  console.warn(`[supersession] refused: ${event.kind} via ${event.door} would cancel ${set.length} tasks`, set);

  const missionId = wouldCancel.find(d => d.task.missionId)?.task.missionId ?? null;
  await db.insert(missionNotes).values({
    missionId,
    taskId: eventTaskRef(event) ?? wouldCancel[0]?.task.id ?? null,
    authorType: 'system',
    type: 'warning',
    title: `Supersession held back: a ${event.kind} event would cancel ${set.length} tasks`,
    body: `More than ${MAX_CANCELS_PER_EVENT} tasks matched, so none were cancelled. Review them and cancel by hand if they are obsolete: ${set.map(s => `${s.taskId} (${s.rule})`).join(', ')}`,
    status: 'open',
  }).catch(err => console.error('[supersession] bulk refusal note failed:', err));
}

export const supersessionStore: SupersessionStore = {
  loadCandidates,
  loadEventFacts,
  loadDispatchFacts,
  casCancel,
  applyCancelEffects,
  recordSupersession,
  recordBulkRefusal,
};
