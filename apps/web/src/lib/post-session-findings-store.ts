/**
 * Postgres-backed {@link PostSessionFindingStore} for the post-session finding
 * ledger and action policy (`post-session-findings.ts`).
 *
 * Every write is a single atomic statement — neon-http has no interactive
 * transactions — and each one carries its own fence:
 *  - the finding insert rides the unique (workspace, signature, policy) index;
 *  - aggregate updates compare-and-set on `updated_at`;
 *  - the action claim requires no action recorded yet;
 *  - run transitions require `state = 'triaged'`.
 *
 * Tables written: `post_session_findings`, `post_session_runs` (state and
 * coverage only), and — in propose mode — one follow-up `tasks` row, one
 * proposal `artifacts` row, and a `mission_notes` warning. Never memory, and
 * never the worker or task a run describes.
 */

import { db } from '@buildd/core/db';
import {
  artifacts,
  missionNotes,
  postSessionFindings,
  postSessionRuns,
  tasks,
  workspaces,
} from '@buildd/core/db/schema';
import type { FindingLedgerAggregate } from '@buildd/core/post-session-findings';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { PostSessionFindingStore, StoredFinding } from './post-session-findings';
import { WORKSPACE_NOT_OFF } from './post-session-mode-sql';

type FindingRow = typeof postSessionFindings.$inferSelect;

function toStored(r: FindingRow): StoredFinding {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    signature: r.signature,
    policyVersion: r.policyVersion,
    class: r.class,
    severity: r.severity,
    confidence: r.confidence === null ? null : Number(r.confidence),
    title: r.title,
    summary: r.summary,
    recurrenceKey: r.recurrenceKey,
    proposedAction: r.proposedAction,
    occurrenceCount: r.occurrenceCount,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    affectedRefs: r.affectedRefs ?? [],
    evidenceRefs: r.evidenceRefs ?? [],
    actionState: r.actionState,
    actionTaskId: r.actionTaskId,
    actionArtifactId: r.actionArtifactId,
    actionAt: r.actionAt,
    updatedAt: r.updatedAt,
  };
}

function aggregateColumns(a: FindingLedgerAggregate) {
  return {
    class: a.class,
    severity: a.severity,
    confidence: a.confidence === null ? null : a.confidence.toFixed(3),
    title: a.title,
    summary: a.summary,
    recurrenceKey: a.recurrenceKey,
    proposedAction: a.proposedAction,
    occurrenceCount: a.occurrenceCount,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    affectedRefs: a.affectedRefs,
    evidenceRefs: a.evidenceRefs,
  };
}

export const postSessionFindingStore: PostSessionFindingStore = {
  async loadRun(runId) {
    const [row] = await db
      .select({
        id: postSessionRuns.id,
        state: postSessionRuns.state,
        workerId: postSessionRuns.workerId,
        taskId: postSessionRuns.taskId,
        workspaceId: postSessionRuns.workspaceId,
        missionId: postSessionRuns.missionId,
        policyVersion: postSessionRuns.policyVersion,
        mode: postSessionRuns.mode,
        gitConfig: workspaces.gitConfig,
      })
      .from(postSessionRuns)
      .innerJoin(workspaces, eq(workspaces.id, postSessionRuns.workspaceId))
      .where(eq(postSessionRuns.id, runId))
      .limit(1);
    return row ? { ...row, gitConfig: row.gitConfig ?? null } : null;
  },

  async insertFinding({ workspaceId, signature, policyVersion, aggregate, now }) {
    const [row] = await db
      .insert(postSessionFindings)
      .values({
        workspaceId,
        signature,
        policyVersion,
        ...aggregateColumns(aggregate),
        actionState: 'observed',
        // Explicit, millisecond-precision: updated_at is the CAS token and
        // must round-trip through a JS Date exactly.
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [postSessionFindings.workspaceId, postSessionFindings.signature, postSessionFindings.policyVersion] })
      .returning();
    return row ? toStored(row) : null;
  },

  async loadFinding(workspaceId, signature, policyVersion) {
    const [row] = await db
      .select()
      .from(postSessionFindings)
      .where(and(
        eq(postSessionFindings.workspaceId, workspaceId),
        eq(postSessionFindings.signature, signature),
        eq(postSessionFindings.policyVersion, policyVersion),
      ))
      .limit(1);
    return row ? toStored(row) : null;
  },

  async updateFindingIfUnchanged(id, expectedUpdatedAt, aggregate, updatedAt) {
    const [row] = await db
      .update(postSessionFindings)
      .set({ ...aggregateColumns(aggregate), updatedAt })
      .where(and(eq(postSessionFindings.id, id), eq(postSessionFindings.updatedAt, expectedUpdatedAt)))
      .returning();
    return row ? toStored(row) : null;
  },

  async findOpenFollowUpTask(workspaceId, findingId) {
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        sql`${tasks.context}->'postSessionFinding'->>'findingId' = ${findingId}`,
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      ))
      .limit(1);
    return row?.id ?? null;
  },

  async insertTask(workspaceId, spec, now) {
    const [row] = await db
      .insert(tasks)
      .values({
        workspaceId,
        title: spec.title,
        description: spec.description,
        priority: spec.priority,
        category: spec.category,
        kind: spec.kind,
        taskClass: 'work',
        status: 'pending',
        creationSource: 'orchestrator',
        context: spec.context,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });
    return row.id;
  },

  async deleteTask(taskId) {
    // Only an undispatched task we just inserted reaches here; the status
    // fence makes sure a claimed one is never removed.
    await db.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')));
  },

  async dispatchTask(taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) return;
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, task.workspaceId) });
    if (!workspace) return;
    const { dispatchNewTask } = await import('./task-dispatch');
    await dispatchNewTask(task, workspace);
  },

  async claimAction(findingId, { state, taskId, artifactId, now }) {
    const rows = await db
      .update(postSessionFindings)
      .set({
        actionState: state,
        actionTaskId: taskId ?? null,
        actionArtifactId: artifactId ?? null,
        actionAt: now,
        // Deliberately NOT updated_at: the claim must not invalidate an
        // aggregate CAS in flight, and the aggregate never touches these columns.
      })
      .where(and(
        eq(postSessionFindings.id, findingId),
        isNull(postSessionFindings.actionTaskId),
        isNull(postSessionFindings.actionArtifactId),
        inArray(postSessionFindings.actionState, ['observed', 'promoted']),
      ))
      .returning({ id: postSessionFindings.id });
    return rows.length > 0;
  },

  async markPromoted(findingId, now) {
    await db
      .update(postSessionFindings)
      .set({ actionState: 'promoted', actionAt: now })
      .where(and(eq(postSessionFindings.id, findingId), eq(postSessionFindings.actionState, 'observed')));
  },

  async upsertProposal(workspaceId, missionId, spec, now) {
    const [inserted] = await db
      .insert(artifacts)
      .values({
        workspaceId,
        missionId,
        key: spec.key,
        type: spec.type,
        title: spec.title,
        content: spec.content,
        visibility: 'private',
        metadata: spec.metadata as unknown as Record<string, unknown>,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [artifacts.workspaceId, artifacts.key] })
      .returning({ id: artifacts.id });
    if (inserted) return inserted.id;
    const [existing] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.key, spec.key)))
      .limit(1);
    if (!existing) throw new Error('correction proposal neither inserted nor found');
    return existing.id;
  },

  async appendToTask(taskId, text, now) {
    await db
      .update(tasks)
      .set({ description: sql`coalesce(${tasks.description}, '') || ${text}`, updatedAt: now })
      .where(eq(tasks.id, taskId));
  },

  async insertWarning({ missionId, taskId, title, body }) {
    await db.insert(missionNotes).values({
      missionId,
      taskId,
      authorType: 'system',
      type: 'warning',
      title,
      body,
      actorLabel: 'post-session quality loop',
      status: 'open',
    });
  },

  async markRunAnalysed(runId, coverage, now) {
    const rows = await db
      .update(postSessionRuns)
      .set({
        state: 'analysed',
        traceAvailability: coverage.traceAvailability,
        traceSource: coverage.traceSource,
        traceMissing: coverage.traceMissing as unknown as Record<string, unknown>,
        analysedAt: now,
        updatedAt: now,
      })
      .where(and(eq(postSessionRuns.id, runId), eq(postSessionRuns.state, 'triaged')))
      .returning({ id: postSessionRuns.id });
    return rows.length > 0;
  },

  async recordFailure(runId, stage, error, now) {
    await db
      .update(postSessionRuns)
      .set({ errorStage: stage, lastError: error, failedAt: now, updatedAt: now })
      .where(and(eq(postSessionRuns.id, runId), eq(postSessionRuns.state, 'triaged')));
  },

  async listTriaged({ policyVersion, limit }) {
    const rows = await db
      .select({ id: postSessionRuns.id })
      .from(postSessionRuns)
      .innerJoin(workspaces, eq(workspaces.id, postSessionRuns.workspaceId))
      .where(and(
        eq(postSessionRuns.policyVersion, policyVersion),
        eq(postSessionRuns.state, 'triaged'),
        // A workspace switched off after triage is not analysed.
        WORKSPACE_NOT_OFF,
      ))
      .orderBy(asc(postSessionRuns.updatedAt))
      .limit(limit);
    return rows.map(r => r.id);
  },
};
