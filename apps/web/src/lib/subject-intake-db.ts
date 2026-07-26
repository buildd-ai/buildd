import { db } from '@buildd/core/db';
import {
  taskSubjectClaims,
  taskSubjectReports,
  tasks,
  workers,
} from '@buildd/core/db/schema';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { SubjectIntakeRepository, SubjectTask } from './subject-intake';

type IntakeTask = typeof tasks.$inferSelect & SubjectTask;

export function createSubjectIntakeRepository(
  createTask: SubjectIntakeRepository<IntakeTask>['createTask'],
): SubjectIntakeRepository<IntakeTask> {
  return {
    async reserve(input) {
      const [claim] = await db.insert(taskSubjectClaims).values({
        workspaceId: input.workspaceId,
        keyType: input.keyType,
        keyHash: input.keyHash,
        canonicalTaskId: null,
        reservationToken: input.token,
        reservationExpiresAt: input.expiresAt,
      }).onConflictDoNothing().returning();
      return claim ?? null;
    },

    async getActiveClaim(workspaceId, keyType, keyHash) {
      return await db.query.taskSubjectClaims.findFirst({
        where: and(
          eq(taskSubjectClaims.workspaceId, workspaceId),
          eq(taskSubjectClaims.keyType, keyType),
          eq(taskSubjectClaims.keyHash, keyHash),
          eq(taskSubjectClaims.state, 'active'),
        ),
      }) ?? null;
    },

    async takeReservation(claimId, expectedToken, token, expiresAt) {
      const [claim] = await db.update(taskSubjectClaims).set({
        reservationToken: token,
        reservationExpiresAt: expiresAt,
      }).where(and(
        eq(taskSubjectClaims.id, claimId),
        expectedToken
          ? eq(taskSubjectClaims.reservationToken, expectedToken)
          : isNull(taskSubjectClaims.reservationToken),
        lt(taskSubjectClaims.reservationExpiresAt, new Date()),
        isNull(taskSubjectClaims.canonicalTaskId),
      )).returning({ id: taskSubjectClaims.id });
      return Boolean(claim);
    },

    async finalizeReservation(claimId, token, taskId) {
      const [claim] = await db.update(taskSubjectClaims).set({
        canonicalTaskId: taskId,
        reservationToken: null,
        reservationExpiresAt: null,
      }).where(and(
        eq(taskSubjectClaims.id, claimId),
        eq(taskSubjectClaims.reservationToken, token),
      )).returning({ id: taskSubjectClaims.id });
      return Boolean(claim);
    },

    async releaseReservation(claimId, token, restoreCanonicalTaskId) {
      if (restoreCanonicalTaskId) {
        await db.update(taskSubjectClaims).set({
          canonicalTaskId: restoreCanonicalTaskId,
          reservationToken: null,
          reservationExpiresAt: null,
        }).where(and(
          eq(taskSubjectClaims.id, claimId),
          eq(taskSubjectClaims.reservationToken, token),
        ));
        return;
      }
      await db.delete(taskSubjectClaims).where(and(
        eq(taskSubjectClaims.id, claimId),
        eq(taskSubjectClaims.reservationToken, token),
        isNull(taskSubjectClaims.canonicalTaskId),
      ));
    },

    async rotateClaim(claimId, _successorTaskId, token, expiresAt) {
      const [claim] = await db.update(taskSubjectClaims).set({
        canonicalTaskId: null,
        reservationToken: token,
        reservationExpiresAt: expiresAt,
      }).where(and(
        eq(taskSubjectClaims.id, claimId),
        isNotNull(taskSubjectClaims.canonicalTaskId),
        isNull(taskSubjectClaims.reservationToken),
      )).returning({ id: taskSubjectClaims.id });
      return Boolean(claim);
    },

    async getTask(taskId) {
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      return task ? { ...task, hasOpenWorkerPr: false } as IntakeTask : null;
    },

    async getConnectedTasks(taskId) {
      const ids = new Set([taskId]);
      for (let pass = 0; pass < 100; pass += 1) {
        const known = [...ids];
        const [taskRows, reportRows] = await Promise.all([
          db.query.tasks.findMany({
            where: or(inArray(tasks.id, known), inArray(tasks.parentTaskId, known)),
          }),
          db.query.taskSubjectReports.findMany({
            where: or(
              inArray(taskSubjectReports.taskId, known),
              inArray(taskSubjectReports.reportingTaskId, known),
            ),
          }),
        ]);
        for (const task of taskRows) {
          ids.add(task.id);
          if (task.parentTaskId) ids.add(task.parentTaskId);
          if (task.subjectSupersededByTaskId) ids.add(task.subjectSupersededByTaskId);
        }
        for (const report of reportRows) {
          ids.add(report.taskId);
          if (report.reportingTaskId) ids.add(report.reportingTaskId);
        }
        if (ids.size === known.length) break;
      }

      const taskRows = await db.query.tasks.findMany({ where: inArray(tasks.id, [...ids]) });
      const workerRows = await db.query.workers.findMany({
        where: and(inArray(workers.taskId, [...ids]), isNotNull(workers.prUrl)),
        columns: { taskId: true, prLifecycleStatus: true },
      });
      const openPrTaskIds = new Set(
        workerRows
          .filter(worker => worker.taskId && !['closed', 'merged'].includes(worker.prLifecycleStatus ?? ''))
          .map(worker => worker.taskId),
      );
      return taskRows.map(task => ({
        ...task,
        hasOpenWorkerPr: openPrTaskIds.has(task.id),
      })) as IntakeTask[];
    },

    createTask,

    async abortCreatedTask(taskId) {
      await db.delete(tasks).where(and(
        eq(tasks.id, taskId),
        eq(tasks.status, 'pending'),
        isNull(tasks.claimedBy),
      ));
    },

    async updateSuperseded(taskId, successorTaskId) {
      await db.update(tasks).set({
        subjectDedupeScope: 'retry_chain',
        subjectResolution: 'superseded',
        subjectSupersededByTaskId: successorTaskId,
        updatedAt: new Date(),
      }).where(eq(tasks.id, taskId));
    },

    async addReport(input) {
      const [report] = await db.insert(taskSubjectReports).values({
        taskId: input.taskId,
        reportingTaskId: input.reportingTaskId ?? null,
        origin: input.origin,
        reporterId: input.reporterId ?? null,
        note: input.note,
        anchorSnapshot: input.anchor,
      }).returning({ id: taskSubjectReports.id });
      if (!report) throw new Error('subject_report_insert_failed');
      return report.id;
    },
  };
}
