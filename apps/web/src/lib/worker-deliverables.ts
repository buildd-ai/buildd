import { db } from '@buildd/core/db';
import { artifacts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export interface DeliverableCheck {
  hasPR: boolean;
  hasArtifacts: boolean;
  hasStructuredOutput: boolean;
  hasCommits: boolean;
  /** True if any deliverable type is present */
  hasAny: boolean;
  /** Human-readable summary for audit trail / debugging */
  details: string;
}

/**
 * Check what deliverables a worker has produced.
 *
 * Single source of truth for "did this worker produce meaningful output?"
 * Used by the PATCH handler, cleanup cron, and stale worker cleanup to
 * make completion decisions across ALL output types (PR, artifacts,
 * structured output, commits).
 */
export async function checkWorkerDeliverables(
  workerId: string,
  worker: {
    prUrl?: string | null;
    prNumber?: number | null;
    commitCount?: number | null;
  },
  taskResult?: { structuredOutput?: unknown } | null,
): Promise<DeliverableCheck> {
  const hasPR = !!worker.prUrl;
  const hasCommits = typeof worker.commitCount === 'number' && worker.commitCount > 0;

  // Check structured output — must be non-empty object
  const so = taskResult?.structuredOutput;
  const hasStructuredOutput = !!so && typeof so === 'object' && Object.keys(so as object).length > 0;

  // Query artifacts table (non-fatal on error)
  let artifactCount = 0;
  try {
    const workerArtifacts = await db.query.artifacts.findMany({
      where: eq(artifacts.workerId, workerId),
      columns: { id: true },
    });
    artifactCount = workerArtifacts.length;
  } catch {
    // Non-fatal — treat as no artifacts
  }
  const hasArtifacts = artifactCount > 0;

  const hasAny = hasPR || hasArtifacts || hasStructuredOutput || hasCommits;

  // Build human-readable details
  const parts: string[] = [];
  if (hasPR) parts.push(`PR #${worker.prNumber || '?'}`);
  if (hasArtifacts) parts.push(`${artifactCount} artifact${artifactCount !== 1 ? 's' : ''}`);
  if (hasStructuredOutput) parts.push('structured output');
  if (hasCommits) parts.push(`${worker.commitCount} commit${worker.commitCount !== 1 ? 's' : ''}`);

  return {
    hasPR,
    hasArtifacts,
    hasStructuredOutput,
    hasCommits,
    hasAny,
    details: parts.length > 0 ? parts.join(', ') : 'none',
  };
}
