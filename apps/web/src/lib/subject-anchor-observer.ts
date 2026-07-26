import { db } from '@buildd/core/db';
import {
  taskSubjectReports,
  tasks,
  type WorkspaceGitConfig,
} from '@buildd/core/db/schema';
import {
  projectSubjectAnchor,
  resolveSubjectPolicy,
  subjectMatchPredicate,
  wouldBeSubjectOutcome,
  type SubjectFilingOrigin,
} from '@buildd/core/subject-anchor-observe';
import {
  extractSubjectAnchor,
  type AnchorExtractionInput,
} from '@buildd/core/subject-anchor-extractor';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { trackEvent } from '@/lib/axiom';

const ACTIVE_TASK_STATUSES = ['pending', 'assigned', 'in_progress'] as const;

export interface PrepareSubjectFilingInput extends AnchorExtractionInput {
  workspaceId: string;
  origin: SubjectFilingOrigin;
  gitConfig?: WorkspaceGitConfig | null;
}

export async function prepareSubjectFiling(input: PrepareSubjectFilingInput) {
  const extraction = extractSubjectAnchor(input);
  if (!extraction.anchor) {
    return { taskValues: {}, anchor: null, match: null, warnings: extraction.warnings };
  }

  const taskValues = projectSubjectAnchor(extraction.anchor);
  const predicate = subjectMatchPredicate(extraction.anchor);
  if (!predicate) {
    return { taskValues, anchor: extraction.anchor, match: null, warnings: extraction.warnings };
  }

  const identity = predicate.kind === 'pr_generation'
    ? and(
        eq(tasks.subjectPrNumber, predicate.prNumber),
        eq(tasks.subjectHeadSha, predicate.headSha),
      )
    : predicate.kind === 'pr_lineage'
      ? eq(tasks.subjectPrNumber, predicate.prNumber)
    : predicate.kind === 'error'
      ? and(
          eq(tasks.subjectErrorSignature, predicate.errorSignature),
          predicate.subjectMissionId
            ? eq(tasks.subjectMissionId, predicate.subjectMissionId)
            : isNull(tasks.subjectMissionId),
        )
      : eq(tasks.subjectMissionId, predicate.subjectMissionId);

  let match: { id: string; creationSource: string | null } | undefined;
  try {
    match = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.workspaceId, input.workspaceId),
        inArray(tasks.status, [...ACTIVE_TASK_STATUSES]),
        identity,
      ),
      columns: { id: true, creationSource: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  } catch (error) {
    console.error('[subject-anchor] failed to query observed match:', error);
  }

  const policy = resolveSubjectPolicy(input.gitConfig?.subjectPolicy);
  return {
    taskValues,
    anchor: extraction.anchor,
    match: match
      ? {
          taskId: match.id,
          matchedOrigin: match.creationSource ?? 'api',
          outcome: predicate.kind === 'pr_lineage'
            ? 'suggest' as const
            : wouldBeSubjectOutcome(input.origin, policy),
          keyType: predicate.kind,
        }
      : null,
    warnings: extraction.warnings,
  };
}

export async function recordSubjectMatchObserved(input: {
  workspaceId: string;
  origin: SubjectFilingOrigin;
  reportingTaskId?: string | null;
  reporterId?: string | null;
  anchor: NonNullable<Awaited<ReturnType<typeof prepareSubjectFiling>>['anchor']>;
  match: NonNullable<Awaited<ReturnType<typeof prepareSubjectFiling>>['match']>;
}) {
  try {
    await db.insert(taskSubjectReports).values({
      taskId: input.match.taskId,
      reportingTaskId: input.reportingTaskId ?? null,
      origin: input.origin,
      reporterId: input.reporterId ?? null,
      note: `subject_match_observed:${input.match.outcome}`,
      anchorSnapshot: input.anchor,
    });
  } catch (error) {
    console.error('[subject-anchor] failed to persist observed match:', error);
  }

  trackEvent('subject_match_observed', {
    workspaceId: input.workspaceId,
    origin: input.origin,
    matchedOrigin: input.match.matchedOrigin,
    outcome: input.match.outcome,
    keyType: input.match.keyType,
    canonicalTaskId: input.match.taskId,
    reportingTaskId: input.reportingTaskId ?? undefined,
  });
}
