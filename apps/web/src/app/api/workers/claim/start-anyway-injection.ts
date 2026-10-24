/**
 * Start anyway assessment brief (Living Spec 36df686b R-4, R-5, R-9, R-10):
 * a claimed task that a person started before its declared prerequisites
 * finished, or that resumes after parking on one, reads first what those
 * prerequisites are doing now (task, agent, PR) and what it may and may not do
 * about them. The words are @buildd/core/start-anyway's `buildAssessmentBrief`;
 * this only loads the live facts.
 *
 * A resume is a new attempt under the same task (`planResume`): the claim
 * minted fresh credentials, file ownership is re-acquired at edit time, and
 * the saved assessment and the lifecycle's facts come back here.
 *
 * Best-effort like every context block: a read failure leaves the block out
 * and never fails the claim.
 */
import { db } from '@buildd/core/db';
import { tasks, workers } from '@buildd/core/db/schema';
import { desc, inArray } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import {
  buildAssessmentBrief,
  factChain,
  planResume,
  readStartAnyway,
  type PrerequisiteState,
} from '@buildd/core/start-anyway';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { appendContextBlock } from './context-injection';

type Worker = ClaimTasksResponse['workers'][number];

export async function attachStartAnywayBrief(claimedWorkers: Worker[]): Promise<void> {
  const subjects = claimedWorkers
    .map(cw => ({ cw, task: cw.task as unknown as { id: string; title: string; context?: Record<string, unknown> | null } | undefined }))
    .map(s => ({ ...s, record: readStartAnyway(s.task?.context ?? null) }))
    .filter((s): s is typeof s & { record: NonNullable<typeof s.record> } => !!s.task && !!s.record);
  if (subjects.length === 0) return;
  try {
    const ids = [...new Set(subjects.flatMap(s => s.record.prerequisiteIds))];
    if (ids.length === 0) return;
    const [rows, workerRows, children] = await Promise.all([
      db.query.tasks.findMany({ where: sqlWhere(inArray(tasks.id, ids)), columns: { id: true, title: true, status: true, updatedAt: true } }),
      db.query.workers.findMany({
        where: sqlWhere(inArray(workers.taskId, ids)),
        columns: { id: true, taskId: true, status: true, currentAction: true, prNumber: true, prUrl: true, mergedAt: true },
        orderBy: sqlOrderBy([desc(workers.createdAt)]),
      }),
      db.query.tasks.findMany({
        where: sqlWhere(inArray(tasks.parentTaskId, ids)),
        columns: { id: true, title: true, status: true, parentTaskId: true },
        limit: 20,
      }),
    ]);
    const latestWorker = new Map<string, (typeof workerRows)[number]>();
    for (const w of workerRows) if (w.taskId && !latestWorker.has(w.taskId)) latestWorker.set(w.taskId, w);
    const byId = new Map(rows.map(r => [r.id, r]));

    for (const s of subjects) {
      const prerequisites: PrerequisiteState[] = s.record.prerequisiteIds.map(id => {
        const t = byId.get(id);
        const w = latestWorker.get(id);
        return {
          id,
          title: t?.title ?? `task ${id.slice(0, 8)}`,
          // A prerequisite that no longer exists is said plainly, never guessed at.
          status: t?.status ?? 'missing',
          worker: w ? { id: w.id, status: w.status, currentAction: w.currentAction ?? null } : null,
          pr: w?.prUrl ? { number: w.prNumber ?? null, url: w.prUrl, merged: !!w.mergedAt } : null,
          version: t?.updatedAt ? new Date(t.updatedAt).getTime() : null,
        };
      });
      const resumedNow = s.record.facts.at(-2)?.fact === 'woken';
      const resume = resumedNow
        // The parked worker ended; its session cannot be continued by a new worker.
        ? planResume({ saved: { taskId: s.task!.id, assessment: s.record.assessment, history: factChain(s.record), sessionId: s.record.sessionId }, sessionValid: false })
        : null;
      const brief = buildAssessmentBrief({
        task: { id: s.task!.id, title: s.task!.title },
        prerequisites,
        recoveryOutcomes: children
          .filter(c => c.parentTaskId && s.record.prerequisiteIds.includes(c.parentTaskId))
          .map(c => ({ taskId: c.id, title: c.title, status: c.status })),
        resumed: resume
          ? { assessment: s.record.assessment, parkedOn: s.record.wake?.taskId ?? null, history: resume.context.history as string[] }
          : null,
      });
      appendContextBlock(s.cw, brief.text);
    }
  } catch (err) {
    console.error('[claim] start-anyway brief failed; the claim proceeds without it:', err);
  }
}
