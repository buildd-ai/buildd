import { db } from '../db';
import {
  taskSubjectReports,
  tasks,
  workspaces,
} from '../db/schema';
import { extractSubjectAnchor } from '../subject-anchor-extractor';
import { projectBackfilledSubjectAnchor } from '../subject-anchor-observe';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';

const OPEN_STATUSES = ['pending', 'assigned', 'in_progress', 'review'] as const;

function workspaceRepo(repo: string | null): string | undefined {
  return repo
    ?.replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/|\/$/g, '');
}

const candidates = await db
  .select({
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    context: tasks.context,
    creationSource: tasks.creationSource,
    createdByWorkerId: tasks.createdByWorkerId,
    ciRetryPrNumber: tasks.ciRetryPrNumber,
    ciRetryHeadSha: tasks.ciRetryHeadSha,
    repo: workspaces.repo,
  })
  .from(tasks)
  .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
  .where(and(
    inArray(tasks.status, [...OPEN_STATUSES]),
    isNull(tasks.subjectAnchor),
  ));

let anchored = 0;
let proposed = 0;
for (const task of candidates) {
  const context = {
    ...((task.context as Record<string, unknown> | null) ?? {}),
    ...(task.ciRetryPrNumber ? { ciRetryPrNumber: task.ciRetryPrNumber } : {}),
    ...(task.ciRetryHeadSha ? { ciRetryHeadSha: task.ciRetryHeadSha } : {}),
  };
  const extraction = extractSubjectAnchor({
    title: task.title,
    description: task.description ?? undefined,
    context,
    workspaceRepo: workspaceRepo(task.repo),
  });
  if (!extraction.anchor) continue;

  const historicHumanProse = (
    extraction.anchor.source === 'url' || extraction.anchor.source === 'text'
  ) && (
    task.creationSource === 'dashboard'
    || (task.creationSource === 'api' && !task.createdByWorkerId)
  );
  const projection = projectBackfilledSubjectAnchor(extraction.anchor, {
    terminal: false,
    historicHumanProse,
  });
  const { requiresConfirmation, reason, ...taskValues } = projection;

  await db.update(tasks)
    .set({
      ...taskValues,
      context: {
        ...context,
        subjectAnchorBackfill: {
          extractionVersion: 1,
          reason,
          requiresConfirmation,
        },
      },
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.id, task.id), isNull(tasks.subjectAnchor)));

  anchored += 1;
  if (requiresConfirmation) proposed += 1;
}

const observedCounts = await db
  .select({
    origin: taskSubjectReports.origin,
    count: sql<number>`count(*)::int`,
  })
  .from(taskSubjectReports)
  .where(like(taskSubjectReports.note, 'subject_match_observed:%'))
  .groupBy(taskSubjectReports.origin);

console.log(JSON.stringify({
  scannedOpenTasks: candidates.length,
  anchored,
  proposedForConfirmation: proposed,
  subjectMatchObservedByOrigin: Object.fromEntries(
    observedCounts.map(row => [row.origin, row.count]),
  ),
}, null, 2));
